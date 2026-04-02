package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"sort"
	"strings"
	"time"

	libravdb "github.com/xDarkicex/libravdb/libravdb"

	"github.com/xDarkicex/openclaw-memory-libravdb/sidecar/embed"
)

const (
	dirtyTierCollection = "_tier_dirty"
	dirtyTierDims       = 1
	maxCollections      = 10000
	rawStoreCap         = 4096
)

type SearchResult struct {
	ID       string         `json:"id"`
	Score    float64        `json:"score"`
	Text     string         `json:"text"`
	Metadata map[string]any `json:"metadata"`
}

type TierExit struct {
	Tier      int           `json:"tier"`
	Dims      int           `json:"dims"`
	BestScore float64       `json:"bestScore"`
	Latency   time.Duration `json:"latency"`
	Exited    bool          `json:"exited"`
}

type CascadeResult struct {
	Hits     []SearchResult `json:"hits"`
	TierUsed int            `json:"tierUsed"`
	Dims     int            `json:"dims"`
	Latency  time.Duration  `json:"latency"`
	Exits    []TierExit     `json:"exits"`
}

type CascadeConfig struct {
	ExitThresholdL1 float64
	ExitThresholdL2 float64
	BudgetMs        int
}

var DefaultCascadeConfig = CascadeConfig{
	ExitThresholdL1: 0.65,
	ExitThresholdL2: 0.75,
	BudgetMs:        50,
}

type Store struct {
	path               string
	db                 *libravdb.Database
	embedder           embed.Embedder
	profile            embed.Profile
	beforeInsertRecord func(collection, id string, vec []float32, meta map[string]any) error
}

type persistedProfile struct {
	Embedding *embed.Profile `json:"embedding,omitempty"`
}

func Open(path string, embedder embed.Embedder) (*Store, error) {
	if path == "" {
		return nil, errors.New("store path is required")
	}
	if embedder == nil {
		return nil, errors.New("embedder is required")
	}

	db, err := libravdb.New(
		libravdb.WithStoragePath(path),
		libravdb.WithMetrics(false),
		libravdb.WithMaxCollections(maxCollections),
	)
	if err != nil {
		return nil, err
	}

	s := &Store{
		path:     path,
		db:       db,
		embedder: embedder,
		profile:  embedder.Profile(),
	}
	if err := s.checkEmbeddingFingerprint(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Store) Path() string {
	return s.path
}

func (s *Store) EnsureCollection(ctx context.Context, collection string) error {
	_, err := s.ensureCollection(ctx, collection, s.collectionDimensions(collection, nil, nil))
	return err
}

func (s *Store) InsertText(ctx context.Context, collection, id, text string, meta map[string]any) error {
	vec, err := s.embedder.EmbedDocument(ctx, text)
	if err != nil {
		return fmt.Errorf("embed document: %w", err)
	}
	return s.insertRecord(ctx, collection, id, text, vec, meta)
}

func (s *Store) InsertRecord(ctx context.Context, collection, id string, vec []float32, meta map[string]any) error {
	return s.insertRecord(ctx, collection, id, "", vec, meta)
}

func (s *Store) insertRecord(ctx context.Context, collection, id, text string, vec []float32, meta map[string]any) error {
	if id == "" {
		return errors.New("record id is required")
	}
	expected := s.collectionDimensions(collection, vec, meta)
	if len(vec) != expected {
		return fmt.Errorf("record vector dimensions %d do not match collection %s dimensions %d", len(vec), collection, expected)
	}
	if s.beforeInsertRecord != nil {
		if err := s.beforeInsertRecord(collection, id, vec, meta); err != nil {
			return err
		}
	}

	col, err := s.ensureCollection(ctx, collection, expected)
	if err != nil {
		return err
	}

	entryMeta := toStringMap(meta)
	if text != "" {
		entryMeta["text"] = text
	}
	return col.Insert(ctx, id, cloneVector(vec), entryMeta)
}

func (s *Store) InsertMatryoshka(ctx context.Context, collection, id string, vec embed.MatryoshkaVec, meta map[string]any) error {
	if err := s.InsertRecord(ctx, collection, id, vec.L3, meta); err != nil {
		return fmt.Errorf("L3 insert: %w", err)
	}
	if err := s.InsertRecord(ctx, tierCollection(collection, embed.DimsL2), id, vec.L2, meta); err != nil {
		s.markTierDirty(ctx, collection, id, embed.DimsL2)
		return fmt.Errorf("L2 insert: %w", err)
	}
	if err := s.InsertRecord(ctx, tierCollection(collection, embed.DimsL1), id, vec.L1, meta); err != nil {
		s.markTierDirty(ctx, collection, id, embed.DimsL1)
		return fmt.Errorf("L1 insert: %w", err)
	}
	return nil
}

func (s *Store) SearchText(ctx context.Context, collection, query string, k int, exclude []string) ([]SearchResult, error) {
	if me, ok := s.embedder.(embed.MatryoshkaEmbedder); ok && embed.SupportsMatryoshka(s.embedder) {
		queryVec, err := me.EmbedQueryM(ctx, query)
		if err == nil {
			result := s.CascadeSearch(ctx, collection, queryVec, k, exclude, DefaultCascadeConfig)
			return result.Hits, nil
		}
	}

	vec, err := s.embedder.EmbedQuery(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("embed query: %w", err)
	}
	return s.searchVec(ctx, collection, vec, k, exclude)
}

func (s *Store) ListByMeta(ctx context.Context, collection, key, value string) ([]SearchResult, error) {
	col, err := s.getCollection(collection)
	if err != nil {
		if isCollectionNotFound(err) {
			return []SearchResult{}, nil
		}
		return nil, err
	}
	if col == nil {
		return []SearchResult{}, nil
	}

	records, err := col.ListByMetadata(ctx, key, value)
	if err != nil {
		return nil, err
	}
	results := recordsToResults(records, 0)
	sortByID(results)
	return results, nil
}

func (s *Store) ListCollection(ctx context.Context, collection string) ([]SearchResult, error) {
	col, err := s.getCollection(collection)
	if err != nil {
		if isCollectionNotFound(err) {
			return []SearchResult{}, nil
		}
		return nil, err
	}
	if col == nil {
		return []SearchResult{}, nil
	}

	records, err := col.ListAll(ctx)
	if err != nil {
		return nil, err
	}
	results := recordsToResults(records, 0)
	sortByID(results)
	return results, nil
}

func (s *Store) CollectionNames() []string {
	if s == nil || s.db == nil {
		return nil
	}
	names, err := s.db.ListCollectionsWithContext(context.Background())
	if err != nil {
		return nil
	}
	return names
}

func (s *Store) CountByPrefix(prefix string) int {
	ctx := context.Background()
	total := 0
	for _, collection := range s.CollectionNames() {
		if !strings.HasPrefix(collection, prefix) {
			continue
		}
		col, err := s.getCollection(collection)
		if err != nil || col == nil {
			continue
		}
		count, err := col.Count(ctx)
		if err != nil {
			continue
		}
		total += count
	}
	return total
}

func (s *Store) DeleteCollectionsByPrefix(ctx context.Context, prefix string) error {
	names, err := s.db.ListCollectionsWithContext(ctx)
	if err != nil {
		return err
	}
	toDelete := make([]string, 0)
	for _, name := range names {
		if strings.HasPrefix(name, prefix) {
			toDelete = append(toDelete, name)
		}
	}
	if len(toDelete) == 0 {
		return nil
	}
	return s.db.DeleteCollections(ctx, toDelete)
}

func (s *Store) loadVec(ctx context.Context, collection, id string) ([]float32, error) {
	record, err := s.getRecord(ctx, collection, id)
	if err != nil {
		return nil, err
	}
	return cloneVector(record.Vector), nil
}

func (s *Store) loadMeta(ctx context.Context, collection, id string) (map[string]any, error) {
	record, err := s.getRecord(ctx, collection, id)
	if err != nil {
		return nil, err
	}
	return fromStringMap(record.Metadata), nil
}

func (s *Store) BackfillDirtyTiers(ctx context.Context) error {
	markers, err := s.ListCollection(ctx, dirtyTierCollection)
	if err != nil {
		return fmt.Errorf("backfill: list dirty tiers: %w", err)
	}
	if len(markers) == 0 {
		return nil
	}

	log.Printf("backfill: %d dirty tier(s) to restore", len(markers))
	var restored, dropped int
	for _, marker := range markers {
		base := metaString(marker.Metadata, "base_collection")
		id := metaString(marker.Metadata, "record_id")
		dims := metaInt(marker.Metadata, "dims")
		if base == "" || id == "" || dims == 0 {
			log.Printf("backfill: malformed dirty marker %s - dropping", marker.ID)
			_ = s.Delete(ctx, dirtyTierCollection, marker.ID)
			dropped++
			continue
		}

		l3, err := s.loadVec(ctx, base, id)
		if err != nil || len(l3) < embed.DimsL3 {
			log.Printf("backfill: L3 missing for %s/%s - dropping dirty marker", base, id)
			_ = s.Delete(ctx, dirtyTierCollection, marker.ID)
			dropped++
			continue
		}

		mv, err := embed.NewMatryoshkaVec(l3)
		if err != nil {
			log.Printf("backfill: cannot derive matryoshka for %s/%s: %v", base, id, err)
			continue
		}

		var tierVec []float32
		switch dims {
		case embed.DimsL2:
			tierVec = mv.L2
		case embed.DimsL1:
			tierVec = mv.L1
		default:
			log.Printf("backfill: unexpected dims %d for %s/%s - dropping", dims, base, id)
			_ = s.Delete(ctx, dirtyTierCollection, marker.ID)
			dropped++
			continue
		}

		meta, err := s.loadMeta(ctx, base, id)
		if err != nil {
			log.Printf("backfill: metadata missing for %s/%s - dropping dirty marker", base, id)
			_ = s.Delete(ctx, dirtyTierCollection, marker.ID)
			dropped++
			continue
		}
		if err := s.InsertRecord(ctx, tierCollection(base, dims), id, tierVec, meta); err != nil {
			log.Printf("backfill: re-insert failed for %s/%s dims=%d: %v", base, id, dims, err)
			continue
		}

		_ = s.Delete(ctx, dirtyTierCollection, marker.ID)
		restored++
	}

	log.Printf("backfill: restored=%d dropped=%d remaining=%d", restored, dropped, len(markers)-restored-dropped)
	return nil
}

func (s *Store) CascadeSearch(ctx context.Context, base string, queryVec embed.MatryoshkaVec, k int, exclude []string, cfg CascadeConfig) CascadeResult {
	start := time.Now()
	deadline := start.Add(time.Duration(cfg.BudgetMs) * time.Millisecond)
	exits := make([]TierExit, 0, 3)

	if time.Now().Before(deadline) {
		t0 := time.Now()
		hits, _ := s.searchVec(ctx, tierCollection(base, embed.DimsL1), queryVec.L1, k, exclude)
		lat := time.Since(t0)
		top := best(hits)
		exits = append(exits, TierExit{Tier: 1, Dims: embed.DimsL1, BestScore: top, Latency: lat})
		if top >= cfg.ExitThresholdL1 {
			exits[len(exits)-1].Exited = true
			return CascadeResult{Hits: hits, TierUsed: 1, Dims: embed.DimsL1, Latency: time.Since(start), Exits: exits}
		}
	}

	if time.Now().Before(deadline) {
		t0 := time.Now()
		hits, _ := s.searchVec(ctx, tierCollection(base, embed.DimsL2), queryVec.L2, k, exclude)
		lat := time.Since(t0)
		top := best(hits)
		exits = append(exits, TierExit{Tier: 2, Dims: embed.DimsL2, BestScore: top, Latency: lat})
		if top >= cfg.ExitThresholdL2 {
			exits[len(exits)-1].Exited = true
			return CascadeResult{Hits: hits, TierUsed: 2, Dims: embed.DimsL2, Latency: time.Since(start), Exits: exits}
		}
	}

	t0 := time.Now()
	hits, _ := s.searchVec(ctx, base, queryVec.L3, k, exclude)
	lat := time.Since(t0)
	exits = append(exits, TierExit{Tier: 3, Dims: embed.DimsL3, BestScore: best(hits), Latency: lat, Exited: true})
	return CascadeResult{Hits: hits, TierUsed: 3, Dims: embed.DimsL3, Latency: time.Since(start), Exits: exits}
}

func dirtyID(baseCollection, id string, dims int) string {
	return fmt.Sprintf("%s/%s:%d", baseCollection, id, dims)
}

func tierCollection(base string, dims int) string {
	switch dims {
	case embed.DimsL1:
		return base + ":64d"
	case embed.DimsL2:
		return base + ":256d"
	default:
		return base
	}
}

func (s *Store) markTierDirty(ctx context.Context, base, id string, dims int) {
	meta := map[string]any{
		"base_collection": base,
		"record_id":       id,
		"dims":            dims,
		"created_at":      time.Now().UnixMilli(),
	}
	if err := s.InsertRecord(ctx, dirtyTierCollection, dirtyID(base, id, dims), []float32{0}, meta); err != nil {
		log.Printf("markTierDirty: failed to mark %s/%s dims=%d: %v", base, id, dims, err)
	}
}

func (s *Store) Delete(ctx context.Context, collection, id string) error {
	col, err := s.getCollection(collection)
	if err != nil {
		if isCollectionNotFound(err) {
			return nil
		}
		return err
	}
	if col == nil {
		return nil
	}
	return col.Delete(ctx, id)
}

func (s *Store) DeleteBatch(ctx context.Context, collection string, ids []string) error {
	col, err := s.getCollection(collection)
	if err != nil {
		if isCollectionNotFound(err) {
			return nil
		}
		return err
	}
	if col == nil {
		return nil
	}
	return col.DeleteBatch(ctx, ids)
}

func (s *Store) Flush(_ context.Context) error {
	// libravdb persists writes directly to the backing .libravdb file.
	return nil
}

func (s *Store) getRecord(ctx context.Context, collection, id string) (libravdb.Record, error) {
	col, err := s.getCollection(collection)
	if err != nil {
		return libravdb.Record{}, err
	}
	if col == nil {
		return libravdb.Record{}, fmt.Errorf("record %s/%s not found", collection, id)
	}

	var out libravdb.Record
	found := false
	err = col.Iterate(ctx, func(record libravdb.Record) error {
		if record.ID != id {
			return nil
		}
		out = record
		found = true
		return errStopIter
	})
	if err != nil && !errors.Is(err, errStopIter) {
		return libravdb.Record{}, err
	}
	if !found {
		return libravdb.Record{}, fmt.Errorf("record %s/%s not found", collection, id)
	}
	return out, nil
}

func (s *Store) ensureCollection(ctx context.Context, collection string, dims int) (*libravdb.Collection, error) {
	col, err := s.getCollection(collection)
	if err == nil {
		return col, nil
	}
	if !isCollectionNotFound(err) {
		return nil, err
	}

	opts := []libravdb.CollectionOption{
		libravdb.WithDimension(dims),
		libravdb.WithMetric(libravdb.CosineDistance),
	}
	if collection == dirtyTierCollection {
		opts = append(opts, libravdb.WithFlat())
	} else {
		opts = append(opts, libravdb.WithAutoIndexSelection(true), libravdb.WithRawVectorStoreSlabby(rawStoreCap))
	}

	col, err = s.db.CreateCollection(ctx, collection, opts...)
	if err == nil {
		return col, nil
	}
	if strings.Contains(strings.ToLower(err.Error()), "already exists") {
		return s.getCollection(collection)
	}
	return nil, err
}

func (s *Store) getCollection(collection string) (*libravdb.Collection, error) {
	if s == nil || s.db == nil {
		return nil, errors.New("store unavailable")
	}
	return s.db.GetCollection(collection)
}

func (s *Store) collectionDimensions(collection string, vec []float32, meta map[string]any) int {
	switch {
	case strings.HasSuffix(collection, ":64d"):
		return embed.DimsL1
	case strings.HasSuffix(collection, ":256d"):
		return embed.DimsL2
	case collection == dirtyTierCollection:
		return dirtyTierDims
	default:
		return s.profile.Dimensions
	}
}

func (s *Store) searchVec(ctx context.Context, collection string, vec []float32, k int, exclude []string) ([]SearchResult, error) {
	col, err := s.getCollection(collection)
	if err != nil {
		if isCollectionNotFound(err) {
			return []SearchResult{}, nil
		}
		return nil, err
	}
	if col == nil {
		return []SearchResult{}, nil
	}

	limit := k
	if limit <= 0 || len(exclude) > 0 {
		count, err := col.Count(ctx)
		if err != nil {
			return nil, err
		}
		if count == 0 {
			return []SearchResult{}, nil
		}
		limit = count
	}

	results, err := col.Search(ctx, cloneVector(vec), limit)
	if err != nil {
		return nil, err
	}

	excluded := make(map[string]struct{}, len(exclude))
	for _, id := range exclude {
		excluded[id] = struct{}{}
	}

	out := make([]SearchResult, 0, len(results.Results))
	for _, result := range results.Results {
		if _, skip := excluded[result.ID]; skip {
			continue
		}
		out = append(out, SearchResult{
			ID:       result.ID,
			Score:    float64(result.Score),
			Text:     textFromMetadata(result.Metadata),
			Metadata: fromStringMap(result.Metadata),
		})
	}
	if k > 0 && len(out) > k {
		out = out[:k]
	}
	return out, nil
}

func best(hits []SearchResult) float64 {
	if len(hits) == 0 {
		return 0
	}
	return hits[0].Score
}

func (s *Store) checkEmbeddingFingerprint() error {
	if s.profile.Fingerprint == "" {
		return nil
	}
	path := s.profilePath()
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return s.writeEmbeddingFingerprint()
		}
		return err
	}

	var persisted persistedProfile
	if err := json.Unmarshal(data, &persisted); err != nil {
		return err
	}
	if persisted.Embedding != nil && persisted.Embedding.Fingerprint != "" && persisted.Embedding.Fingerprint != s.profile.Fingerprint {
		return fmt.Errorf("embedding profile mismatch: store fingerprint %s does not match current fingerprint %s", persisted.Embedding.Fingerprint, s.profile.Fingerprint)
	}
	return s.writeEmbeddingFingerprint()
}

func (s *Store) writeEmbeddingFingerprint() error {
	if s.profile.Fingerprint == "" {
		return nil
	}
	payload := persistedProfile{Embedding: profilePtr(s.profile)}
	data, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return err
	}
	tmpPath := s.profilePath() + ".tmp"
	if err := os.WriteFile(tmpPath, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmpPath, s.profilePath())
}

func (s *Store) profilePath() string {
	return s.path + ".embedding.json"
}

func profilePtr(profile embed.Profile) *embed.Profile {
	if profile.Fingerprint == "" {
		return nil
	}
	copyProfile := profile
	return &copyProfile
}

func cloneVector(src []float32) []float32 {
	if src == nil {
		return nil
	}
	out := make([]float32, len(src))
	copy(out, src)
	return out
}

func toStringMap(src map[string]any) map[string]interface{} {
	if src == nil {
		return map[string]interface{}{}
	}
	dst := make(map[string]interface{}, len(src))
	for k, v := range src {
		dst[k] = v
	}
	return dst
}

func fromStringMap(src map[string]interface{}) map[string]any {
	if src == nil {
		return map[string]any{}
	}
	dst := make(map[string]any, len(src))
	for k, v := range src {
		dst[k] = v
	}
	return dst
}

func textFromMetadata(meta map[string]interface{}) string {
	if meta == nil {
		return ""
	}
	value, ok := meta["text"]
	if !ok {
		return ""
	}
	if text, ok := value.(string); ok {
		return text
	}
	return fmt.Sprint(value)
}

func recordsToResults(records []libravdb.Record, score float64) []SearchResult {
	out := make([]SearchResult, 0, len(records))
	for _, record := range records {
		out = append(out, SearchResult{
			ID:       record.ID,
			Score:    score,
			Text:     textFromMetadata(record.Metadata),
			Metadata: fromStringMap(record.Metadata),
		})
	}
	return out
}

func sortByID(results []SearchResult) {
	sort.Slice(results, func(i, j int) bool { return results[i].ID < results[j].ID })
}

func isCollectionNotFound(err error) bool {
	return err != nil && strings.Contains(strings.ToLower(err.Error()), "not found")
}

func metaString(meta map[string]any, key string) string {
	if meta == nil {
		return ""
	}
	value, ok := meta[key]
	if !ok {
		return ""
	}
	if typed, ok := value.(string); ok {
		return typed
	}
	return fmt.Sprint(value)
}

func metaInt(meta map[string]any, key string) int {
	if meta == nil {
		return 0
	}
	value, ok := meta[key]
	if !ok {
		return 0
	}
	switch typed := value.(type) {
	case int:
		return typed
	case int64:
		return int(typed)
	case float64:
		return int(typed)
	default:
		return 0
	}
}

var errStopIter = errors.New("stop iteration")
