package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/xDarkicex/openclaw-memory-libravdb/sidecar/embed"
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
	ExitThresholdL1: 0.92,
	ExitThresholdL2: 0.80,
	BudgetMs:        50,
}

type record struct {
	ID       string
	Text     string
	Vector   []float32
	Metadata map[string]any
}

type Store struct {
	path               string
	embedder           embed.Embedder
	profile            embed.Profile
	mu                 sync.RWMutex
	collections        map[string]map[string]record
	beforeInsertRecord func(collection, id string, vec []float32, meta map[string]any) error
}

type persistedRecord struct {
	ID       string         `json:"id"`
	Text     string         `json:"text"`
	Vector   []float32      `json:"vector"`
	Metadata map[string]any `json:"metadata"`
}

type persistedStore struct {
	Embedding   *embed.Profile               `json:"embedding,omitempty"`
	Collections map[string][]persistedRecord `json:"collections"`
}

const dirtyTierCollection = "_tier_dirty"

func Open(path string, embedder embed.Embedder) (*Store, error) {
	if path == "" {
		return nil, errors.New("store path is required")
	}
	if embedder == nil {
		return nil, errors.New("embedder is required")
	}
	s := &Store{
		path:        path,
		embedder:    embedder,
		collections: make(map[string]map[string]record),
	}
	s.profile = embedder.Profile()
	if err := s.load(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Store) Path() string {
	return s.path
}

func (s *Store) EnsureCollection(_ context.Context, collection string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ensureCollectionLocked(collection)
	return nil
}

func (s *Store) InsertText(ctx context.Context, collection, id, text string, meta map[string]any) error {
	vec, err := s.embedder.EmbedDocument(ctx, text)
	if err != nil {
		return fmt.Errorf("embed document: %w", err)
	}
	return s.insertRecord(ctx, collection, id, text, vec, meta)
}

func (s *Store) InsertRecord(_ context.Context, collection, id string, vec []float32, meta map[string]any) error {
	return s.insertRecord(context.Background(), collection, id, "", vec, meta)
}

func (s *Store) insertRecord(_ context.Context, collection, id, text string, vec []float32, meta map[string]any) error {
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

	s.mu.Lock()
	defer s.mu.Unlock()

	col := s.ensureCollectionLocked(collection)
	col[id] = record{
		ID:       id,
		Text:     text,
		Vector:   append([]float32(nil), vec...),
		Metadata: cloneMeta(meta),
	}
	return nil
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
	return s.searchVec(ctx, collection, vec, k, exclude), nil
}

func (s *Store) ListByMeta(_ context.Context, collection, key, value string) ([]SearchResult, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	col := s.collections[collection]
	results := make([]SearchResult, 0, len(col))
	for _, rec := range col {
		metaValue, ok := rec.Metadata[key]
		if !ok || !matchesMeta(metaValue, value) {
			continue
		}
		results = append(results, SearchResult{
			ID:       rec.ID,
			Score:    0,
			Text:     rec.Text,
			Metadata: cloneMeta(rec.Metadata),
		})
	}

	sort.Slice(results, func(i, j int) bool { return results[i].ID < results[j].ID })
	return results, nil
}

func (s *Store) ListCollection(_ context.Context, collection string) ([]SearchResult, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	col := s.collections[collection]
	results := make([]SearchResult, 0, len(col))
	for _, rec := range col {
		results = append(results, SearchResult{
			ID:       rec.ID,
			Score:    0,
			Text:     rec.Text,
			Metadata: cloneMeta(rec.Metadata),
		})
	}

	sort.Slice(results, func(i, j int) bool { return results[i].ID < results[j].ID })
	return results, nil
}

func (s *Store) CollectionNames() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()

	names := make([]string, 0, len(s.collections))
	for name := range s.collections {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func (s *Store) CountByPrefix(prefix string) int {
	s.mu.RLock()
	defer s.mu.RUnlock()

	total := 0
	for collection, records := range s.collections {
		if !strings.HasPrefix(collection, prefix) {
			continue
		}
		total += len(records)
	}
	return total
}

func (s *Store) DeleteCollectionsByPrefix(_ context.Context, prefix string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	for collection := range s.collections {
		if strings.HasPrefix(collection, prefix) {
			delete(s.collections, collection)
		}
	}
	return nil
}

func (s *Store) loadVec(_ context.Context, collection, id string) ([]float32, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	col := s.collections[collection]
	rec, ok := col[id]
	if !ok {
		return nil, fmt.Errorf("record %s/%s not found", collection, id)
	}
	return append([]float32(nil), rec.Vector...), nil
}

func (s *Store) loadMeta(_ context.Context, collection, id string) (map[string]any, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	col := s.collections[collection]
	rec, ok := col[id]
	if !ok {
		return nil, fmt.Errorf("record %s/%s not found", collection, id)
	}
	return cloneMeta(rec.Metadata), nil
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
		hits := s.searchVec(ctx, tierCollection(base, embed.DimsL1), queryVec.L1, k, exclude)
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
		hits := s.searchVec(ctx, tierCollection(base, embed.DimsL2), queryVec.L2, k, exclude)
		lat := time.Since(t0)
		top := best(hits)
		exits = append(exits, TierExit{Tier: 2, Dims: embed.DimsL2, BestScore: top, Latency: lat})
		if top >= cfg.ExitThresholdL2 {
			exits[len(exits)-1].Exited = true
			return CascadeResult{Hits: hits, TierUsed: 2, Dims: embed.DimsL2, Latency: time.Since(start), Exits: exits}
		}
	}

	t0 := time.Now()
	hits := s.searchVec(ctx, base, queryVec.L3, k, exclude)
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
	zero := make([]float32, dims)
	meta := map[string]any{
		"base_collection": base,
		"record_id":       id,
		"dims":            dims,
		"created_at":      time.Now().UnixMilli(),
	}
	if err := s.InsertRecord(ctx, dirtyTierCollection, dirtyID(base, id, dims), zero, meta); err != nil {
		log.Printf("markTierDirty: failed to mark %s/%s dims=%d: %v", base, id, dims, err)
	}
}

func (s *Store) Delete(_ context.Context, collection, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if col, ok := s.collections[collection]; ok {
		delete(col, id)
	}
	return nil
}

func (s *Store) DeleteBatch(ctx context.Context, collection string, ids []string) error {
	for _, id := range ids {
		if err := s.Delete(ctx, collection, id); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) Flush(_ context.Context) error {
	s.mu.RLock()
	snapshot := persistedStore{
		Embedding:   profilePtr(s.profile),
		Collections: make(map[string][]persistedRecord, len(s.collections)),
	}
	for collection, records := range s.collections {
		items := make([]persistedRecord, 0, len(records))
		for _, rec := range records {
			items = append(items, persistedRecord{
				ID:       rec.ID,
				Text:     rec.Text,
				Vector:   append([]float32(nil), rec.Vector...),
				Metadata: cloneMeta(rec.Metadata),
			})
		}
		sort.Slice(items, func(i, j int) bool { return items[i].ID < items[j].ID })
		snapshot.Collections[collection] = items
	}
	s.mu.RUnlock()

	if err := os.MkdirAll(s.path, 0o755); err != nil {
		return err
	}

	data, err := json.MarshalIndent(snapshot, "", "  ")
	if err != nil {
		return err
	}

	tmpPath := filepath.Join(s.path, "store.json.tmp")
	finalPath := filepath.Join(s.path, "store.json")
	if err := os.WriteFile(tmpPath, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmpPath, finalPath)
}

func (s *Store) ensureCollectionLocked(collection string) map[string]record {
	col, ok := s.collections[collection]
	if !ok {
		col = make(map[string]record)
		s.collections[collection] = col
	}
	return col
}

func cloneMeta(src map[string]any) map[string]any {
	if src == nil {
		return map[string]any{}
	}
	dst := make(map[string]any, len(src))
	for k, v := range src {
		dst[k] = v
	}
	return dst
}

func matchesMeta(v any, want string) bool {
	switch typed := v.(type) {
	case string:
		return typed == want
	default:
		return fmt.Sprint(typed) == want
	}
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

func (s *Store) collectionDimensions(collection string, vec []float32, meta map[string]any) int {
	switch {
	case strings.HasSuffix(collection, ":64d"):
		return embed.DimsL1
	case strings.HasSuffix(collection, ":256d"):
		return embed.DimsL2
	case collection == dirtyTierCollection:
		if dims, ok := meta["dims"].(int); ok && dims > 0 {
			return dims
		}
		return len(vec)
	default:
		return s.profile.Dimensions
	}
}

func (s *Store) searchVec(_ context.Context, collection string, vec []float32, k int, exclude []string) []SearchResult {
	s.mu.RLock()
	defer s.mu.RUnlock()

	col := s.collections[collection]
	if len(col) == 0 {
		return []SearchResult{}
	}

	excluded := make(map[string]struct{}, len(exclude))
	for _, id := range exclude {
		excluded[id] = struct{}{}
	}

	results := make([]SearchResult, 0, len(col))
	for _, rec := range col {
		if _, skip := excluded[rec.ID]; skip {
			continue
		}
		score := cosine(rec.Vector, vec)
		results = append(results, SearchResult{
			ID:       rec.ID,
			Score:    score,
			Text:     rec.Text,
			Metadata: cloneMeta(rec.Metadata),
		})
	}

	sort.Slice(results, func(i, j int) bool {
		if results[i].Score == results[j].Score {
			return results[i].ID < results[j].ID
		}
		return results[i].Score > results[j].Score
	})
	if k > 0 && len(results) > k {
		results = results[:k]
	}
	return results
}

func best(hits []SearchResult) float64 {
	if len(hits) == 0 {
		return 0
	}
	return hits[0].Score
}

func cosine(a, b []float32) float64 {
	if len(a) == 0 || len(a) != len(b) {
		return 0
	}

	var dot, normA, normB float64
	for i := range a {
		av := float64(a[i])
		bv := float64(b[i])
		dot += av * bv
		normA += av * av
		normB += bv * bv
	}
	if normA == 0 || normB == 0 {
		return 0
	}
	return dot / (sqrt(normA) * sqrt(normB))
}

func sqrt(v float64) float64 {
	// Newton iteration is enough here and avoids another dependency.
	if v <= 0 {
		return 0
	}
	x := v
	for i := 0; i < 8; i++ {
		x = 0.5 * (x + v/x)
	}
	return x
}

func (s *Store) load() error {
	finalPath := filepath.Join(s.path, "store.json")
	data, err := os.ReadFile(finalPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}

	var snapshot persistedStore
	if err := json.Unmarshal(data, &snapshot); err != nil {
		return err
	}
	if snapshot.Embedding != nil && s.profile.Fingerprint != "" && snapshot.Embedding.Fingerprint != s.profile.Fingerprint {
		return fmt.Errorf("embedding profile mismatch: store fingerprint %s does not match current fingerprint %s", snapshot.Embedding.Fingerprint, s.profile.Fingerprint)
	}
	if snapshot.Embedding != nil {
		s.profile = *snapshot.Embedding
	}

	for collection, items := range snapshot.Collections {
		col := make(map[string]record, len(items))
		for _, item := range items {
			col[item.ID] = record{
				ID:       item.ID,
				Text:     item.Text,
				Vector:   append([]float32(nil), item.Vector...),
				Metadata: cloneMeta(item.Metadata),
			}
		}
		s.collections[collection] = col
	}
	return nil
}

func profilePtr(profile embed.Profile) *embed.Profile {
	if profile.Fingerprint == "" {
		return nil
	}
	copyProfile := profile
	return &copyProfile
}
