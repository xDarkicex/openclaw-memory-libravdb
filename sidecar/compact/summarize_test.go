package compact

import (
	"bytes"
	"context"
	"errors"
	"log"
	"math"
	"strings"
	"testing"

	"github.com/xDarkicex/openclaw-memory-libravdb/sidecar/astv2"
	"github.com/xDarkicex/openclaw-memory-libravdb/sidecar/embed"
	"github.com/xDarkicex/openclaw-memory-libravdb/sidecar/store"
	"github.com/xDarkicex/openclaw-memory-libravdb/sidecar/summarize"
)

type fakeStore struct {
	results      []store.SearchResult
	collections  map[string][]store.SearchResult
	insertCalls  []insertCall
	recordCalls  []insertCall
	deleteCalls  []deleteCall
	deleteErr    error
	listErr      error
	insertErr    error
	casErr       error
	stateVersion uint64
	stateMeta    map[string]any
}

type insertCall struct {
	collection string
	id         string
	text       string
	meta       map[string]any
}

type deleteCall struct {
	collection string
	ids        []string
}

type fakeSummarizer struct {
	summaries []summarize.Summary
	err       error
	calls     [][]summarize.Turn
	mode      string
	embedder  embed.Embedder
}

type fakeEmbedder struct {
	vectors map[string][]float32
}

func (f *fakeStore) ListByMeta(_ context.Context, collection, key, value string) ([]store.SearchResult, error) {
	if f.listErr != nil {
		return nil, f.listErr
	}
	items := f.collectionResults(collection)
	filtered := make([]store.SearchResult, 0, len(items))
	for _, item := range items {
		if item.Metadata[key] == value {
			filtered = append(filtered, item)
		}
	}
	return filtered, nil
}

func (f *fakeStore) InsertText(_ context.Context, collection, id, text string, meta map[string]any) error {
	if f.insertErr != nil {
		return f.insertErr
	}
	f.insertCalls = append(f.insertCalls, insertCall{
		collection: collection,
		id:         id,
		text:       text,
		meta:       cloneMeta(meta),
	})
	return nil
}

func (f *fakeStore) EnsureLosslessSessionCollections(_ context.Context, _ string) error {
	if f.stateVersion == 0 {
		f.stateVersion = 1
	}
	if f.stateMeta == nil {
		f.stateMeta = map[string]any{
			"type":                  "session_state",
			"sessionId":             "s1",
			"compaction_generation": 0,
			"last_compacted_at":     int64(0),
			"last_summary_id":       "",
			"updated_at":            int64(0),
		}
	}
	return nil
}

func (f *fakeStore) Get(_ context.Context, collection, id string) (store.Record, error) {
	if strings.HasPrefix(collection, store.SessionStateCollectionPrefix) && id == "__session_state__" {
		if f.stateVersion == 0 {
			_ = f.EnsureLosslessSessionCollections(context.Background(), "")
		}
		return store.Record{
			ID:       id,
			Metadata: cloneMeta(f.stateMeta),
			Version:  f.stateVersion,
		}, nil
	}
	return store.Record{}, errors.New("record not found")
}

func (f *fakeStore) WithTx(ctx context.Context, fn func(tx store.TxWriter) error) error {
	tx := &fakeTx{
		ctx:              ctx,
		store:            f,
		workingStateMeta: cloneMeta(f.stateMeta),
		workingStateVer:  f.stateVersion,
	}
	if tx.workingStateVer == 0 {
		_ = f.EnsureLosslessSessionCollections(ctx, "")
		tx.workingStateMeta = cloneMeta(f.stateMeta)
		tx.workingStateVer = f.stateVersion
	}
	if err := fn(tx); err != nil {
		return err
	}
	f.insertCalls = append(f.insertCalls, tx.pendingInserts...)
	f.recordCalls = append(f.recordCalls, tx.pendingRecords...)
	f.deleteCalls = append(f.deleteCalls, tx.pendingDeletes...)
	if tx.stateUpdated {
		f.stateMeta = cloneMeta(tx.workingStateMeta)
		f.stateVersion = tx.workingStateVer
	}
	return nil
}

func (f *fakeStore) DeleteBatch(_ context.Context, collection string, ids []string) error {
	f.deleteCalls = append(f.deleteCalls, deleteCall{
		collection: collection,
		ids:        append([]string(nil), ids...),
	})
	return f.deleteErr
}

func metaStringValue(meta map[string]any, key string) string {
	if meta == nil {
		return ""
	}
	value, ok := meta[key]
	if !ok {
		return ""
	}
	text, ok := value.(string)
	if !ok {
		return ""
	}
	return text
}

func (f *fakeStore) ExpandSummary(_ context.Context, sessionID, summaryID string, maxDepth int) ([]store.SearchResult, error) {
	if maxDepth <= 0 {
		maxDepth = 3
	}
	if f.collections == nil {
		return nil, nil
	}
	edgeKey := store.SessionEdgeCollection(sessionID)
	edges, ok := f.collections[edgeKey]
	if !ok {
		return nil, nil
	}
	var results []store.SearchResult
	for _, edge := range edges {
		if metaStringValue(edge.Metadata, "parent_summary_id") != summaryID {
			continue
		}
		childID := metaStringValue(edge.Metadata, "child_id")
		childCollection := metaStringValue(edge.Metadata, "child_collection")
		childType := metaStringValue(edge.Metadata, "child_type")

		if childType == "summary" {
			nested, _ := f.ExpandSummary(context.Background(), sessionID, childID, maxDepth-1)
			results = append(results, nested...)
			continue
		}
		if raw, ok := f.collections[childCollection]; ok {
			for _, r := range raw {
				if r.ID == childID {
					results = append(results, r)
					break
				}
			}
		}
	}
	return results, nil
}

func (f *fakeStore) collectionResults(collection string) []store.SearchResult {
	if f.collections != nil {
		if items, ok := f.collections[collection]; ok {
			return append([]store.SearchResult(nil), items...)
		}
	}
	switch {
	case strings.HasPrefix(collection, store.SessionSummaryCollectionPrefix):
		summaries := make([]store.SearchResult, 0, len(f.results))
		for _, item := range f.results {
			if item.Metadata["type"] == "summary" {
				summaries = append(summaries, item)
			}
		}
		return summaries
	case strings.HasPrefix(collection, "session:"):
		return append([]store.SearchResult(nil), f.results...)
	default:
		return nil
	}
}

type fakeTx struct {
	ctx              context.Context
	store            *fakeStore
	pendingInserts   []insertCall
	pendingRecords   []insertCall
	pendingDeletes   []deleteCall
	workingStateMeta map[string]any
	workingStateVer  uint64
	stateUpdated     bool
}

func (tx *fakeTx) InsertText(ctx context.Context, collection, id, text string, meta map[string]any) error {
	if tx.store.insertErr != nil {
		return tx.store.insertErr
	}
	tx.pendingInserts = append(tx.pendingInserts, insertCall{
		collection: collection,
		id:         id,
		text:       text,
		meta:       cloneMeta(meta),
	})
	return nil
}

func (tx *fakeTx) InsertRecord(_ context.Context, collection, id string, _ []float32, meta map[string]any) error {
	if tx.store.insertErr != nil {
		return tx.store.insertErr
	}
	tx.pendingRecords = append(tx.pendingRecords, insertCall{
		collection: collection,
		id:         id,
		meta:       cloneMeta(meta),
	})
	return nil
}

func (tx *fakeTx) UpdateRecordIfVersion(_ context.Context, collection, id string, _ []float32, meta map[string]any, expectedVersion uint64) error {
	if !strings.HasPrefix(collection, store.SessionStateCollectionPrefix) || id != "__session_state__" {
		return errors.New("unexpected CAS target")
	}
	if tx.store.casErr != nil {
		return tx.store.casErr
	}
	if tx.workingStateVer == 0 {
		_ = tx.store.EnsureLosslessSessionCollections(tx.ctx, "")
		tx.workingStateMeta = cloneMeta(tx.store.stateMeta)
		tx.workingStateVer = tx.store.stateVersion
	}
	if expectedVersion != tx.workingStateVer {
		return errors.New("version conflict")
	}
	tx.workingStateMeta = cloneMeta(meta)
	tx.workingStateVer++
	tx.stateUpdated = true
	return nil
}

func (tx *fakeTx) DeleteBatch(_ context.Context, collection string, ids []string) error {
	if tx.store.deleteErr != nil {
		return tx.store.deleteErr
	}
	tx.pendingDeletes = append(tx.pendingDeletes, deleteCall{
		collection: collection,
		ids:        append([]string(nil), ids...),
	})
	return nil
}

func (f *fakeSummarizer) Summarize(_ context.Context, turns []summarize.Turn, _ summarize.SummaryOpts) (summarize.Summary, error) {
	f.calls = append(f.calls, append([]summarize.Turn(nil), turns...))
	if f.err != nil {
		return summarize.Summary{}, f.err
	}
	index := len(f.calls) - 1
	if index < len(f.summaries) {
		return f.summaries[index], nil
	}
	sourceIDs := make([]string, 0, len(turns))
	for _, turn := range turns {
		sourceIDs = append(sourceIDs, turn.ID)
	}
	return summarize.Summary{
		Text:       "summary",
		SourceIDs:  sourceIDs,
		Method:     "extractive",
		TokenCount: 3,
		Confidence: 0.8,
	}, nil
}

func (f *fakeSummarizer) Profile() summarize.Profile        { return summarize.Profile{Backend: "extractive"} }
func (f *fakeSummarizer) Warmup(context.Context) error      { return nil }
func (f *fakeSummarizer) Unload()                           {}
func (f *fakeSummarizer) Close() error                      { return nil }
func (f *fakeSummarizer) Ready() bool                       { return true }
func (f *fakeSummarizer) Reason() string                    { return "" }
func (f *fakeSummarizer) CanonicalEmbedder() embed.Embedder { return f.embedder }
func (f *fakeSummarizer) Mode() string {
	if f.mode != "" {
		return f.mode
	}
	return "extractive"
}

func (f fakeEmbedder) EmbedDocument(_ context.Context, text string) ([]float32, error) {
	if vec, ok := f.vectors[text]; ok {
		return append([]float32(nil), vec...), nil
	}
	return []float32{0, 0}, nil
}

func (f fakeEmbedder) EmbedQuery(_ context.Context, text string) ([]float32, error) {
	return f.EmbedDocument(context.Background(), text)
}

func (f fakeEmbedder) Dimensions() int { return 2 }
func (f fakeEmbedder) Profile() embed.Profile {
	return embed.Profile{Backend: "test", Family: "test", Dimensions: 2}
}
func (f fakeEmbedder) Ready() bool    { return true }
func (f fakeEmbedder) Reason() string { return "" }
func (f fakeEmbedder) Mode() string   { return "primary" }

// TestCompactSessionShortSessionAttemptsCompaction verifies that sessions with
// enough compactable turns attempt compaction even without force. The summarizer
// is called but all clusters may still be declined via strict-progress — in which
// case DidCompact is false and no data is mutated. The removed gate was:
//   if !force && len(compactable) < targetSize { return early }
// which incorrectly blocked short sessions from compaction at all.
func TestCompactSessionShortSessionAttemptsCompaction(t *testing.T) {
	st := &fakeStore{
		results: []store.SearchResult{
			{ID: "a", Text: "alpha", Metadata: map[string]any{"sessionId": "s1", "ts": int64(10)}},
			{ID: "b", Text: "beta", Metadata: map[string]any{"sessionId": "s1", "ts": int64(20)}},
		},
	}
	sum := &fakeSummarizer{}

	got, err := CompactSession(context.Background(), st, sum, nil, "s1", false, 20, ContinuityConfig{})
	if err != nil {
		t.Fatalf("CompactSession() error = %v", err)
	}
	// Summarizer was reached (compaction was attempted), but all clusters were
	// declined on strict-progress grounds — so DidCompact is correctly false
	// and no store mutations occurred.
	if got.DidCompact {
		t.Fatalf("expected DidCompact=false (declined), got %+v", got)
	}
	if got.ClustersDeclined == 0 {
		t.Fatalf("expected ClustersDeclined > 0, got %d", got.ClustersDeclined)
	}
	if len(st.insertCalls) != 0 || len(st.deleteCalls) != 0 {
		t.Fatalf("expected no store mutations, got inserts=%d deletes=%d", len(st.insertCalls), len(st.deleteCalls))
	}
}

// TestCompactSessionWithZeroTargetSizeAttemptsCompaction verifies that targetSize=0
// is normalized to DefaultTargetSize (20) but still allows compaction to be attempted.
// The removed gate len(compactable) < targetSize would have silently skipped this session.
func TestCompactSessionWithZeroTargetSizeAttemptsCompaction(t *testing.T) {
	st := &fakeStore{
		results: []store.SearchResult{
			{ID: "a", Text: "first", Metadata: map[string]any{"sessionId": "s1", "ts": int64(10)}},
			{ID: "b", Text: "second", Metadata: map[string]any{"sessionId": "s1", "ts": int64(20)}},
			{ID: "c", Text: "third", Metadata: map[string]any{"sessionId": "s1", "ts": int64(30)}},
		},
	}
	sum := &fakeSummarizer{}

	got, err := CompactSession(context.Background(), st, sum, nil, "s1", false, 0, ContinuityConfig{})
	if err != nil {
		t.Fatalf("CompactSession() error = %v", err)
	}
	// DidCompact may be false because clusters were declined, but compaction was
	// correctly attempted (summarizer was called), unlike before the fix.
	if got.DidCompact {
		t.Fatalf("expected DidCompact=false (declined), got %+v", got)
	}
	if len(sum.calls) == 0 {
		t.Fatalf("expected summarizer calls (compaction was attempted), got 0")
	}
}

func TestCompactSessionPartitionsDeterministicallyByTimestamp(t *testing.T) {
	st := &fakeStore{
		results: []store.SearchResult{
			{ID: "c", Text: "third", Metadata: map[string]any{"sessionId": "s1", "ts": int64(30)}},
			{ID: "a", Text: "first", Metadata: map[string]any{"sessionId": "s1", "ts": int64(10)}},
			{ID: "d", Text: "fourth", Metadata: map[string]any{"sessionId": "s1", "ts": int64(40)}},
			{ID: "b", Text: "second", Metadata: map[string]any{"sessionId": "s1", "ts": int64(20)}},
		},
	}
	sum := &fakeSummarizer{
		summaries: []summarize.Summary{
			{Text: "summary-1", SourceIDs: []string{"a", "b"}, Method: "extractive", TokenCount: 1, Confidence: 0.6},
			{Text: "summary-2", SourceIDs: []string{"c", "d"}, Method: "extractive", TokenCount: 1, Confidence: 0.8},
		},
	}

	got, err := CompactSession(context.Background(), st, sum, nil, "s1", true, 2, ContinuityConfig{})
	if err != nil {
		t.Fatalf("CompactSession() error = %v", err)
	}
	if !got.DidCompact || got.ClustersFormed != 2 || got.TurnsRemoved != 4 {
		t.Fatalf("unexpected result: %+v", got)
	}
	if got.SummaryMethod != "extractive" {
		t.Fatalf("unexpected summary method: %+v", got)
	}
	if got.MeanConfidence != 0.7 {
		t.Fatalf("expected mean confidence 0.7, got %f", got.MeanConfidence)
	}
	if len(sum.calls) != 2 {
		t.Fatalf("expected 2 summarize calls, got %d", len(sum.calls))
	}
	assertTurnIDs(t, sum.calls[0], []string{"a", "b"})
	assertTurnIDs(t, sum.calls[1], []string{"c", "d"})
}

func TestCompactSessionWritesCoverageEdgesAndAdvancesState(t *testing.T) {
	st := &fakeStore{
		results: []store.SearchResult{
			{ID: "a", Text: "first turn", Metadata: map[string]any{"sessionId": "s1", "ts": int64(10), "type": "turn"}},
			{ID: "b", Text: "second turn", Metadata: map[string]any{"sessionId": "s1", "ts": int64(20), "type": "turn"}},
		},
	}
	sum := &fakeSummarizer{
		summaries: []summarize.Summary{
			{Text: "summary-1", SourceIDs: []string{"a", "b"}, Method: "extractive", TokenCount: 1, Confidence: 0.8},
		},
	}

	got, err := CompactSession(context.Background(), st, sum, nil, "s1", true, 2, ContinuityConfig{})
	if err != nil {
		t.Fatalf("CompactSession() error = %v", err)
	}
	if !got.DidCompact {
		t.Fatalf("expected compaction to proceed, got %+v", got)
	}
	if len(st.recordCalls) != 2 {
		t.Fatalf("expected two coverage edge inserts, got %+v", st.recordCalls)
	}
	if st.recordCalls[0].collection != "session_edge:s1" {
		t.Fatalf("expected coverage edge collection, got %+v", st.recordCalls[0])
	}
	if got := st.recordCalls[0].meta["type"]; got != "coverage_edge" {
		t.Fatalf("expected coverage edge metadata, got %+v", st.recordCalls[0].meta)
	}
	if got := st.recordCalls[0].meta["child_collection"]; got != "session_raw:s1" {
		t.Fatalf("expected raw-history child collection, got %+v", got)
	}
	if st.stateVersion != 2 {
		t.Fatalf("expected state version to advance to 2, got %d", st.stateVersion)
	}
	if got := st.stateMeta["last_summary_id"]; got == "" {
		t.Fatalf("expected last_summary_id to be populated, got %+v", st.stateMeta)
	}
}

func TestCompactSessionAbortsOnCASConflict(t *testing.T) {
	st := &fakeStore{
		results: []store.SearchResult{
			{ID: "a", Text: "first turn", Metadata: map[string]any{"sessionId": "s1", "ts": int64(10), "type": "turn"}},
			{ID: "b", Text: "second turn", Metadata: map[string]any{"sessionId": "s1", "ts": int64(20), "type": "turn"}},
		},
		casErr: errors.New("version conflict"),
	}
	sum := &fakeSummarizer{}

	if _, err := CompactSession(context.Background(), st, sum, nil, "s1", true, 2, ContinuityConfig{}); err == nil || !strings.Contains(err.Error(), "version conflict") {
		t.Fatalf("expected CAS conflict error, got %v", err)
	}
}

func TestCompactSessionPreservesProtectedGuidanceAsVerbatimShards(t *testing.T) {
	st := &fakeStore{
		results: []store.SearchResult{
			{ID: "a", Text: "Never use mutexes in the hot path.", Metadata: map[string]any{"sessionId": "s1", "userId": "u1", "ts": int64(10), "stability_weight": 0.8, "provenance_class": "session_turn"}},
			{ID: "b", Text: "background implementation detail", Metadata: map[string]any{"sessionId": "s1", "userId": "u1", "ts": int64(20), "stability_weight": 0.2, "provenance_class": "session_turn"}},
		},
	}
	sum := &fakeSummarizer{
		summaries: []summarize.Summary{
			{Text: "background detail", SourceIDs: []string{"b"}, Method: "extractive", TokenCount: 2, Confidence: 0.8},
		},
	}

	got, err := CompactSession(context.Background(), st, sum, nil, "s1", true, 2, ContinuityConfig{})
	if err != nil {
		t.Fatalf("CompactSession() error = %v", err)
	}
	if !got.DidCompact {
		t.Fatalf("expected compaction to proceed, got %+v", got)
	}
	if len(st.insertCalls) != 2 {
		t.Fatalf("expected guidance shard plus summary insert, got %d inserts", len(st.insertCalls))
	}
	if st.insertCalls[0].collection != "elevated:user:u1" {
		t.Fatalf("expected durable elevated collection, got %q", st.insertCalls[0].collection)
	}
	if st.insertCalls[0].meta["type"] != guidanceShardType {
		t.Fatalf("expected first insert to be guidance shard, got %+v", st.insertCalls[0].meta)
	}
	if st.insertCalls[0].text != "Never use mutexes in the hot path." {
		t.Fatalf("expected verbatim shard text, got %q", st.insertCalls[0].text)
	}
	if elevated, ok := st.insertCalls[0].meta["elevated_guidance"].(bool); !ok || !elevated {
		t.Fatalf("expected elevated guidance metadata, got %+v", st.insertCalls[0].meta)
	}
	if len(st.deleteCalls) != 0 {
		t.Fatalf("expected no delete calls (raw history is immutable), got %+v", st.deleteCalls)
	}
}

func TestCompactSessionDoesNotProtectLowStabilityDeonticTurns(t *testing.T) {
	st := &fakeStore{
		results: []store.SearchResult{
			{ID: "a", Text: "Never use mutexes in the hot path.", Metadata: map[string]any{"sessionId": "s1", "userId": "u1", "ts": int64(10), "stability_weight": 0.1, "provenance_class": "session_turn"}},
			{ID: "b", Text: "background implementation detail", Metadata: map[string]any{"sessionId": "s1", "userId": "u1", "ts": int64(20), "stability_weight": 0.1, "provenance_class": "session_turn"}},
		},
	}
	sum := &fakeSummarizer{
		summaries: []summarize.Summary{
			{Text: "condensed summary", SourceIDs: []string{"a", "b"}, Method: "extractive", TokenCount: 2, Confidence: 0.8},
		},
	}

	got, err := CompactSession(context.Background(), st, sum, nil, "s1", true, 2, ContinuityConfig{})
	if err != nil {
		t.Fatalf("CompactSession() error = %v", err)
	}
	if !got.DidCompact {
		t.Fatalf("expected summary compaction, got %+v", got)
	}
	if len(st.insertCalls) != 1 {
		t.Fatalf("expected summary only with no protected shard, got %+v", st.insertCalls)
	}
	if st.insertCalls[0].collection != "session_summary:s1" {
		t.Fatalf("expected only session summary insert, got %+v", st.insertCalls[0])
	}
}

func TestCompactSessionSemanticBoosterProtectsBorderlineGuidance(t *testing.T) {
	st := &fakeStore{
		results: []store.SearchResult{
			{ID: "a", Text: "We should probably keep the router focused on stealth.", Metadata: map[string]any{"sessionId": "s1", "userId": "u1", "ts": int64(10), "stability_weight": 0.8, "provenance_class": "session_turn"}},
			{ID: "b", Text: "background implementation detail", Metadata: map[string]any{"sessionId": "s1", "userId": "u1", "ts": int64(20), "stability_weight": 0.2, "provenance_class": "session_turn"}},
		},
	}
	sum := &fakeSummarizer{
		summaries: []summarize.Summary{
			{Text: "background detail", SourceIDs: []string{"b"}, Method: "extractive", TokenCount: 2, Confidence: 0.8},
		},
		embedder: fakeEmbedder{
			vectors: map[string][]float32{
				"We should probably keep the router focused on stealth.":                   {1, 0},
				"Prefer deterministic operational guidance over generic defaults.":         {1, 0},
				"Avoid unsafe or undesired implementation choices in hot paths.":           {0, 1},
				"Use the specified approach when implementing core project logic.":         {1, 0},
				"Keep the implementation aligned with project-specific engineering rules.": {1, 0},
			},
		},
	}

	got, err := CompactSession(context.Background(), st, sum, nil, "s1", true, 2, ContinuityConfig{})
	if err != nil {
		t.Fatalf("CompactSession() error = %v", err)
	}
	if !got.DidCompact {
		t.Fatalf("expected compaction to proceed, got %+v", got)
	}
	if len(st.insertCalls) != 2 {
		t.Fatalf("expected guidance shard plus summary insert, got %+v", st.insertCalls)
	}
	if st.insertCalls[0].collection != "elevated:user:u1" {
		t.Fatalf("expected semantic booster shard in durable elevated collection, got %+v", st.insertCalls[0])
	}
}

func TestCompactSessionSemanticBoosterRequiresGuidanceSurfaceHint(t *testing.T) {
	st := &fakeStore{
		results: []store.SearchResult{
			{ID: "a", Text: "Stealth router architecture background note.", Metadata: map[string]any{"sessionId": "s1", "userId": "u1", "ts": int64(10), "stability_weight": 0.8, "provenance_class": "session_turn"}},
			{ID: "b", Text: "background implementation detail", Metadata: map[string]any{"sessionId": "s1", "userId": "u1", "ts": int64(20), "stability_weight": 0.2, "provenance_class": "session_turn"}},
		},
	}
	sum := &fakeSummarizer{
		summaries: []summarize.Summary{
			{Text: "condensed summary", SourceIDs: []string{"a", "b"}, Method: "extractive", TokenCount: 2, Confidence: 0.8},
		},
		embedder: fakeEmbedder{
			vectors: map[string][]float32{
				"Stealth router architecture background note.":                             {1, 0},
				"Prefer deterministic operational guidance over generic defaults.":         {1, 0},
				"Avoid unsafe or undesired implementation choices in hot paths.":           {0, 1},
				"Use the specified approach when implementing core project logic.":         {1, 0},
				"Keep the implementation aligned with project-specific engineering rules.": {1, 0},
			},
		},
	}

	got, err := CompactSession(context.Background(), st, sum, nil, "s1", true, 2, ContinuityConfig{})
	if err != nil {
		t.Fatalf("CompactSession() error = %v", err)
	}
	if !got.DidCompact {
		t.Fatalf("expected summary compaction, got %+v", got)
	}
	if len(st.insertCalls) != 1 || st.insertCalls[0].collection != "session_summary:s1" {
		t.Fatalf("expected no semantic booster protection without surface hint, got %+v", st.insertCalls)
	}
}

func TestCompactSessionSkipsGuidanceShardsWhenSelectingEligibleTurns(t *testing.T) {
	results := []store.SearchResult{
		{ID: "guidance:s1:a", Text: "Never use mutexes in the hot path.", Metadata: map[string]any{"sessionId": "s1", "ts": int64(15), "type": guidanceShardType}},
		{ID: "a", Text: "alpha", Metadata: map[string]any{"sessionId": "s1", "ts": int64(10), "type": "turn"}},
		{ID: "b", Text: "beta", Metadata: map[string]any{"sessionId": "s1", "ts": int64(20), "type": "turn"}},
	}

	turns := eligibleTurns(results)
	assertTurnIDs(t, []summarize.Turn{
		{ID: turns[0].id},
		{ID: turns[1].id},
	}, []string{"a", "b"})
}

func TestPartitionChronologicalProducesContiguousCompleteBuckets(t *testing.T) {
	turns := []turnRecord{
		{id: "a", ts: 10},
		{id: "b", ts: 20},
		{id: "c", ts: 30},
		{id: "d", ts: 40},
		{id: "e", ts: 50},
	}

	clusters := partitionChronological(turns, 2)
	if len(clusters) != 3 {
		t.Fatalf("expected 3 clusters, got %d", len(clusters))
	}
	assertClusterTurnIDs(t, clusters[0].turns, []string{"a", "b"})
	assertClusterTurnIDs(t, clusters[1].turns, []string{"c", "d"})
	assertClusterTurnIDs(t, clusters[2].turns, []string{"e"})
}

func TestCompactSessionProtectsRecentTailFromCompaction(t *testing.T) {
	st := &fakeStore{
		results: []store.SearchResult{
			{ID: "a", Text: "first older turn", Metadata: map[string]any{"sessionId": "s1", "ts": int64(10)}},
			{ID: "b", Text: "second older turn", Metadata: map[string]any{"sessionId": "s1", "ts": int64(20)}},
			{ID: "c", Text: "recent preserved one", Metadata: map[string]any{"sessionId": "s1", "ts": int64(30)}},
			{ID: "d", Text: "recent preserved two", Metadata: map[string]any{"sessionId": "s1", "ts": int64(40)}},
		},
	}
	sum := &fakeSummarizer{
		summaries: []summarize.Summary{
			{Text: "older summary", SourceIDs: []string{"a", "b"}, Method: "extractive", TokenCount: 1, Confidence: 0.7},
		},
	}

	got, err := CompactSession(context.Background(), st, sum, nil, "s1", true, 20, ContinuityConfig{
		MinTurns:         2,
		TailBudgetTokens: 8,
	})
	if err != nil {
		t.Fatalf("CompactSession() error = %v", err)
	}
	if !got.DidCompact || got.TurnsRemoved != 2 {
		t.Fatalf("unexpected result: %+v", got)
	}
	if len(sum.calls) != 1 {
		t.Fatalf("expected one summarize call, got %d", len(sum.calls))
	}
	assertTurnIDs(t, sum.calls[0], []string{"a", "b"})
	if len(st.deleteCalls) != 0 {
		t.Fatalf("expected no delete calls (recent tail excluded from compaction), got %d", len(st.deleteCalls))
	}
}

func TestCompactSessionMandatoryTailWinsWhenTailBudgetIsTooSmall(t *testing.T) {
	st := &fakeStore{
		results: []store.SearchResult{
			{ID: "a", Text: "older alpha text", Metadata: map[string]any{"sessionId": "s1", "ts": int64(10)}},
			{ID: "b", Text: "older beta text", Metadata: map[string]any{"sessionId": "s1", "ts": int64(20)}},
			{ID: "c", Text: "recent gamma text", Metadata: map[string]any{"sessionId": "s1", "ts": int64(30)}},
			{ID: "d", Text: "recent delta text", Metadata: map[string]any{"sessionId": "s1", "ts": int64(40)}},
			{ID: "e", Text: "recent epsilon text", Metadata: map[string]any{"sessionId": "s1", "ts": int64(50)}},
		},
	}
	sum := &fakeSummarizer{
		summaries: []summarize.Summary{
			{Text: "older summary", SourceIDs: []string{"a", "b"}, Method: "extractive", TokenCount: 1, Confidence: 0.7},
		},
	}

	got, err := CompactSession(context.Background(), st, sum, nil, "s1", true, 20, ContinuityConfig{
		MinTurns:         3,
		TailBudgetTokens: 1,
	})
	if err != nil {
		t.Fatalf("CompactSession() error = %v", err)
	}
	if !got.DidCompact || got.TurnsRemoved != 2 {
		t.Fatalf("unexpected result: %+v", got)
	}
	assertTurnIDs(t, sum.calls[0], []string{"a", "b"})
}

func TestCompactSessionInsertsBeforeDeleteAndPreservesDataOnDeleteFailure(t *testing.T) {
	st := &fakeStore{
		results: []store.SearchResult{
			{ID: "a", Text: "alpha", Metadata: map[string]any{"sessionId": "s1", "ts": int64(10), "userId": "u1"}},
			{ID: "b", Text: "beta", Metadata: map[string]any{"sessionId": "s1", "ts": int64(20), "userId": "u1"}},
		},
		deleteErr: errors.New("boom"),
	}
	sum := &fakeSummarizer{
		summaries: []summarize.Summary{
			{Text: "summary-1", SourceIDs: []string{"a", "b"}, Method: "extractive", TokenCount: 1, Confidence: 0.75},
		},
	}

	// Under lossless continuity, raw turns are never deleted - deleteErr is never reached
	// since the transaction no longer includes a delete phase.
	got, err := CompactSession(context.Background(), st, sum, nil, "s1", true, 20, ContinuityConfig{})
	if err != nil {
		t.Fatalf("CompactSession() error = %v", err)
	}
	if !got.DidCompact {
		t.Fatalf("expected compaction to proceed, got %+v", got)
	}
	if len(st.insertCalls) < 1 {
		t.Fatalf("expected at least summary insert, got %d", len(st.insertCalls))
	}
	// Raw history is immutable - no deletes happen, so deleteErr is never triggered
	if len(st.deleteCalls) != 0 {
		t.Fatalf("expected no delete calls (raw immutable), got %d", len(st.deleteCalls))
	}

	meta := summaryMetadata("s1", 0, sum.summaries[0], []turnRecord{
		{id: "a", ts: 10, metadata: map[string]any{"userId": "u1"}},
		{id: "b", ts: 20},
	}, qualityMetadata{}, priorContextSelection{})
	if meta["type"] != "summary" {
		t.Fatalf("expected summary metadata type, got %+v", meta)
	}
	if meta["method"] != "extractive" {
		t.Fatalf("expected method metadata, got %+v", meta)
	}
	if meta["confidence"] != 0.75 {
		t.Fatalf("expected confidence metadata, got %+v", meta)
	}
	if meta["decay_rate"] != 0.25 {
		t.Fatalf("expected decay rate metadata, got %+v", meta)
	}
	if math.Abs(metaFloat(meta, "decay_rate")-(1.0-metaFloat(meta, "confidence"))) > 1e-9 {
		t.Fatalf("expected decay_rate = 1 - confidence, got %+v", meta)
	}
	if meta["userId"] != "u1" {
		t.Fatalf("expected userId carried forward, got %+v", meta)
	}

	sourceIDs, ok := meta["source_ids"].([]string)
	if !ok {
		t.Fatalf("expected source_ids to be []string, got %T", meta["source_ids"])
	}
	if len(sourceIDs) != 2 || sourceIDs[0] != "a" || sourceIDs[1] != "b" {
		t.Fatalf("unexpected source_ids: %+v", sourceIDs)
	}

	lineage, ok := meta["continuity_lineage"].(map[string]any)
	if !ok {
		t.Fatalf("expected continuity_lineage map, got %T", meta["continuity_lineage"])
	}
	if got := lineage["method"]; got != "extractive" {
		t.Fatalf("expected lineage method, got %+v", lineage)
	}
	if math.Abs(metaFloat(lineage, "confidence")-0.75) > 1e-9 {
		t.Fatalf("expected lineage confidence, got %+v", lineage)
	}
	if math.Abs(metaFloat(lineage, "source_ts_min")-10) > 1e-9 || math.Abs(metaFloat(lineage, "source_ts_max")-20) > 1e-9 {
		t.Fatalf("expected lineage source timestamp bounds, got %+v", lineage)
	}
	lineageSourceIDs, ok := lineage["source_ids"].([]string)
	if !ok {
		t.Fatalf("expected lineage source_ids to be []string, got %T", lineage["source_ids"])
	}
	if len(lineageSourceIDs) != 2 || lineageSourceIDs[0] != "a" || lineageSourceIDs[1] != "b" {
		t.Fatalf("unexpected lineage source_ids: %+v", lineageSourceIDs)
	}
	lineageTurnIDs, ok := lineage["source_turn_ids"].([]string)
	if !ok {
		t.Fatalf("expected lineage source_turn_ids to be []string, got %T", lineage["source_turn_ids"])
	}
	if len(lineageTurnIDs) != 2 || lineageTurnIDs[0] != "a" || lineageTurnIDs[1] != "b" {
		t.Fatalf("unexpected lineage source_turn_ids: %+v", lineageTurnIDs)
	}
	parentSummaryIDs, ok := lineage["parent_summary_ids"].([]string)
	if !ok {
		t.Fatalf("expected lineage parent_summary_ids to be []string, got %T", lineage["parent_summary_ids"])
	}
	if len(parentSummaryIDs) != 0 {
		t.Fatalf("expected no parent summary IDs for raw-turn compaction, got %+v", parentSummaryIDs)
	}
}

func TestCompactSessionPreservesSourceTurnsWhenInsertFails(t *testing.T) {
	st := &fakeStore{
		results: []store.SearchResult{
			{ID: "a", Text: "alpha", Metadata: map[string]any{"sessionId": "s1", "ts": int64(10)}},
			{ID: "b", Text: "beta", Metadata: map[string]any{"sessionId": "s1", "ts": int64(20)}},
		},
		insertErr: errors.New("insert failed"),
	}
	sum := &fakeSummarizer{
		summaries: []summarize.Summary{{
			Text:       "summary",
			Method:     "extractive",
			TokenCount: 1,
			Confidence: 0.8,
		}},
	}

	_, err := CompactSession(context.Background(), st, sum, nil, "s1", true, 20, ContinuityConfig{})
	if err == nil {
		t.Fatalf("expected insert failure")
	}
	if len(st.deleteCalls) != 0 {
		t.Fatalf("expected no delete call when insert fails, got %d", len(st.deleteCalls))
	}
}

func TestSummaryMetadataCarriesParentSummaryLineage(t *testing.T) {
	summary := summarize.Summary{
		Text:       "rolled-up",
		SourceIDs:  []string{"summary:1", "turn-b"},
		Method:     "extractive",
		TokenCount: 1,
		Confidence: 0.6,
	}
	turns := []turnRecord{
		{id: "summary:1", ts: 10, metadata: map[string]any{"type": "summary"}},
		{id: "turn-b", ts: 20, metadata: map[string]any{"type": "turn"}},
	}

	meta := summaryMetadata("s1", 25, summary, turns, qualityMetadata{}, priorContextSelection{})
	lineage, ok := meta["continuity_lineage"].(map[string]any)
	if !ok {
		t.Fatalf("expected continuity_lineage map, got %T", meta["continuity_lineage"])
	}

	parentSummaryIDs, ok := lineage["parent_summary_ids"].([]string)
	if !ok {
		t.Fatalf("expected parent_summary_ids to be []string, got %T", lineage["parent_summary_ids"])
	}
	if len(parentSummaryIDs) != 1 || parentSummaryIDs[0] != "summary:1" {
		t.Fatalf("unexpected parent_summary_ids: %+v", parentSummaryIDs)
	}
	sourceTurnIDs, ok := lineage["source_turn_ids"].([]string)
	if !ok {
		t.Fatalf("expected source_turn_ids to be []string, got %T", lineage["source_turn_ids"])
	}
	if len(sourceTurnIDs) != 1 || sourceTurnIDs[0] != "turn-b" {
		t.Fatalf("unexpected source_turn_ids: %+v", sourceTurnIDs)
	}
}

func TestCompactSessionAddsBoundedPriorCompactedContextForAbstractiveSummaries(t *testing.T) {
	st := &fakeStore{
		results: []store.SearchResult{
			{ID: "summary:prev", Text: "Earlier compacted background", Metadata: map[string]any{"type": "summary", "sessionId": "s1", "ts": int64(5), "token_count": 3}},
			{ID: "a", Text: "alpha", Metadata: map[string]any{"type": "turn", "sessionId": "s1", "ts": int64(10), "gating_score": 0.8}},
			{ID: "b", Text: "beta", Metadata: map[string]any{"type": "turn", "sessionId": "s1", "ts": int64(20), "gating_score": 0.8}},
		},
	}
	extractive := &fakeSummarizer{
		mode:      "extractive",
		summaries: []summarize.Summary{{Text: "extractive", Method: "extractive", TokenCount: 1, Confidence: 0.6}},
	}
	abstractive := &fakeSummarizer{
		mode:      "onnx-local",
		summaries: []summarize.Summary{{Text: "abstractive", Method: "onnx-t5", TokenCount: 1, Confidence: 0.8}},
	}

	_, err := CompactSession(context.Background(), st, extractive, abstractive, "s1", true, 20, ContinuityConfig{PriorContextTokens: 8})
	if err != nil {
		t.Fatalf("CompactSession() error = %v", err)
	}
	if len(abstractive.calls) != 1 || len(abstractive.calls[0]) != 3 {
		t.Fatalf("expected abstractive summarizer to receive prior context plus cluster turns, got %+v", abstractive.calls)
	}
	if abstractive.calls[0][0].ID != "__continuity_prior__" {
		t.Fatalf("expected synthetic prior-context turn first, got %+v", abstractive.calls[0][0])
	}
	if !strings.Contains(abstractive.calls[0][0].Text, "Earlier compacted background") {
		t.Fatalf("expected prior compacted context text, got %q", abstractive.calls[0][0].Text)
	}
	if got, ok := st.insertCalls[0].meta["continuity_support_summary_ids"].([]string); !ok || len(got) != 1 || got[0] != "summary:prev" {
		t.Fatalf("expected continuity support summary IDs, got %+v", st.insertCalls[0].meta["continuity_support_summary_ids"])
	}
}

func TestCompactSessionDoesNotConditionExtractiveSummariesOnPriorContext(t *testing.T) {
	st := &fakeStore{
		results: []store.SearchResult{
			{ID: "summary:prev", Text: "Earlier compacted background", Metadata: map[string]any{"type": "summary", "sessionId": "s1", "ts": int64(5), "token_count": 3}},
			{ID: "a", Text: "alpha", Metadata: map[string]any{"type": "turn", "sessionId": "s1", "ts": int64(10)}},
			{ID: "b", Text: "beta", Metadata: map[string]any{"type": "turn", "sessionId": "s1", "ts": int64(20)}},
		},
	}
	sum := &fakeSummarizer{
		mode:      "extractive",
		summaries: []summarize.Summary{{Text: "summary", Method: "extractive", TokenCount: 1, Confidence: 0.8}},
	}

	_, err := CompactSession(context.Background(), st, sum, nil, "s1", true, 20, ContinuityConfig{PriorContextTokens: 8})
	if err != nil {
		t.Fatalf("CompactSession() error = %v", err)
	}
	if len(sum.calls) != 1 || len(sum.calls[0]) != 2 {
		t.Fatalf("expected extractive summarizer to receive only cluster turns, got %+v", sum.calls)
	}
}

func TestSanitizeContinuityTextReplacesLargeOpaquePayloads(t *testing.T) {
	text := "Intro\n\ndata:text/plain;base64,QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ==\n\nTail"
	got := sanitizeContinuityText(text)
	if !strings.Contains(got, "[sanitized transport payload omitted for continuity]") {
		t.Fatalf("expected transport payload marker, got %q", got)
	}
	if !strings.Contains(got, "Intro") || !strings.Contains(got, "Tail") {
		t.Fatalf("expected surrounding continuity text preserved, got %q", got)
	}
}

func TestSanitizeContinuityTextReplacesLargeFencedPayloads(t *testing.T) {
	text := "Before\n```json\n{\n  \"payload\": \"abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz0123456789\"\n}\nline4\nline5\nline6\nline7\nline8\nline9\n```\nAfter"
	got := sanitizeContinuityText(text)
	if !strings.Contains(got, "[sanitized fenced payload omitted for continuity]") {
		t.Fatalf("expected fenced payload marker, got %q", got)
	}
	if strings.Contains(got, "\"payload\"") {
		t.Fatalf("expected bulky fenced payload removed, got %q", got)
	}
}

func TestCompactSessionSanitizesSummarizerInputOnly(t *testing.T) {
	st := &fakeStore{
		results: []store.SearchResult{
			{ID: "a", Text: "Context\ndata:text/plain;base64,QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ==", Metadata: map[string]any{"sessionId": "s1", "ts": int64(10)}},
			{ID: "b", Text: "Normal reply", Metadata: map[string]any{"sessionId": "s1", "ts": int64(20)}},
		},
	}
	sum := &fakeSummarizer{
		summaries: []summarize.Summary{{
			Text:       "summary",
			Method:     "extractive",
			TokenCount: 1,
			Confidence: 0.8,
		}},
	}

	_, err := CompactSession(context.Background(), st, sum, nil, "s1", true, 20, ContinuityConfig{})
	if err != nil {
		t.Fatalf("CompactSession() error = %v", err)
	}
	if len(sum.calls) != 1 || len(sum.calls[0]) != 2 {
		t.Fatalf("expected summarizer to receive one two-turn cluster, got %+v", sum.calls)
	}
	if !strings.Contains(sum.calls[0][0].Text, "[sanitized transport payload omitted for continuity]") {
		t.Fatalf("expected sanitized summarizer input, got %q", sum.calls[0][0].Text)
	}
	// Lossless continuity: raw history is never deleted
	if len(st.deleteCalls) != 0 {
		t.Fatalf("expected no delete calls (raw immutable), got %+v", st.deleteCalls)
	}
}

func TestCompactSessionRoutesHighGatingClustersToAbstractive(t *testing.T) {
	embedder := fakeEmbedder{
		vectors: map[string][]float32{
			"alpha":               {1, 0},
			"beta":                {1, 0},
			"abstractive-summary": {1, 0},
		},
	}
	st := &fakeStore{
		results: []store.SearchResult{
			{ID: "a", Text: "alpha", Metadata: map[string]any{"sessionId": "s1", "ts": int64(10), "gating_score": 0.8}},
			{ID: "b", Text: "beta", Metadata: map[string]any{"sessionId": "s1", "ts": int64(20), "gating_score": 0.7}},
		},
	}
	extractive := &fakeSummarizer{
		summaries: []summarize.Summary{{Text: "extractive-summary", Method: "extractive", TokenCount: 1, Confidence: 0.5}},
		mode:      "extractive",
		embedder:  embedder,
	}
	abstractive := &fakeSummarizer{
		summaries: []summarize.Summary{{Text: "abstractive-summary", Method: "onnx-t5", TokenCount: 1, Confidence: 0.9}},
		mode:      "onnx-local",
	}

	got, err := CompactSession(context.Background(), st, extractive, abstractive, "s1", true, 20, ContinuityConfig{})
	if err != nil {
		t.Fatalf("CompactSession() error = %v", err)
	}
	if !got.DidCompact {
		t.Fatalf("expected compaction, got %+v", got)
	}
	if len(abstractive.calls) != 1 {
		t.Fatalf("expected abstractive summarizer to be used, got %d calls", len(abstractive.calls))
	}
	if len(extractive.calls) != 0 {
		t.Fatalf("expected extractive summarizer to be skipped, got %d calls", len(extractive.calls))
	}
	if got.SummaryMethod != "onnx-t5" {
		t.Fatalf("expected onnx-t5 method, got %+v", got)
	}
	if len(st.insertCalls) != 1 {
		t.Fatalf("expected one summary insert, got %d", len(st.insertCalls))
	}
	if got, ok := st.insertCalls[0].meta["confidence"].(float64); !ok || math.Abs(got-0.98) > 1e-9 {
		t.Fatalf("expected hybrid confidence 0.98, got %+v", st.insertCalls[0].meta["confidence"])
	}
	if got := st.insertCalls[0].meta["confidence_nomic"]; got != 1.0 {
		t.Fatalf("expected nomic confidence metadata, got %+v", got)
	}
	if got := st.insertCalls[0].meta["confidence_t5"]; got != 0.9 {
		t.Fatalf("expected t5 confidence metadata, got %+v", got)
	}
}

func TestCompactSessionEscalatesToMoreAggressivePrimaryBeforeDecline(t *testing.T) {
	st := &fakeStore{
		results: []store.SearchResult{
			{ID: "a", Text: "alpha", Metadata: map[string]any{"sessionId": "s1", "ts": int64(10), "gating_score": 0.8}},
			{ID: "b", Text: "beta", Metadata: map[string]any{"sessionId": "s1", "ts": int64(20), "gating_score": 0.8}},
		},
	}
	extractive := &fakeSummarizer{
		mode: "extractive",
	}
	abstractive := &fakeSummarizer{
		mode: "onnx-local",
		summaries: []summarize.Summary{
			{Text: "first-too-long", Method: "onnx-t5", TokenCount: 2, Confidence: 0.9},
			{Text: "shorter", Method: "onnx-t5", TokenCount: 1, Confidence: 0.8},
		},
	}

	got, err := CompactSession(context.Background(), st, extractive, abstractive, "s1", true, 20, ContinuityConfig{})
	if err != nil {
		t.Fatalf("CompactSession() error = %v", err)
	}
	if !got.DidCompact {
		t.Fatalf("expected compaction after aggressive retry, got %+v", got)
	}
	if len(abstractive.calls) != 2 {
		t.Fatalf("expected two abstractive attempts, got %d", len(abstractive.calls))
	}
	if len(extractive.calls) != 0 {
		t.Fatalf("expected no deterministic fallback, got %d calls", len(extractive.calls))
	}
	if len(st.insertCalls) != 1 || st.insertCalls[0].text != "shorter" {
		t.Fatalf("expected aggressive retry summary inserted, got %+v", st.insertCalls)
	}
}

func TestCompactSessionEscalatesToDeterministicFallbackBeforeDecline(t *testing.T) {
	st := &fakeStore{
		results: []store.SearchResult{
			{ID: "a", Text: "alpha", Metadata: map[string]any{"sessionId": "s1", "ts": int64(10), "gating_score": 0.8}},
			{ID: "b", Text: "beta", Metadata: map[string]any{"sessionId": "s1", "ts": int64(20), "gating_score": 0.8}},
		},
	}
	extractive := &fakeSummarizer{
		mode: "extractive",
		summaries: []summarize.Summary{
			{Text: "extractive-short", Method: "extractive", TokenCount: 1, Confidence: 0.7},
		},
	}
	abstractive := &fakeSummarizer{
		mode: "onnx-local",
		summaries: []summarize.Summary{
			{Text: "too-long-1", Method: "onnx-t5", TokenCount: 2, Confidence: 0.9},
			{Text: "too-long-2", Method: "onnx-t5", TokenCount: 2, Confidence: 0.8},
		},
	}

	got, err := CompactSession(context.Background(), st, extractive, abstractive, "s1", true, 20, ContinuityConfig{})
	if err != nil {
		t.Fatalf("CompactSession() error = %v", err)
	}
	if !got.DidCompact {
		t.Fatalf("expected compaction after deterministic fallback, got %+v", got)
	}
	if len(abstractive.calls) != 2 {
		t.Fatalf("expected two abstractive attempts, got %d", len(abstractive.calls))
	}
	if len(extractive.calls) != 1 {
		t.Fatalf("expected one deterministic fallback call, got %d", len(extractive.calls))
	}
	if len(st.insertCalls) != 1 || st.insertCalls[0].text != "extractive-short" {
		t.Fatalf("expected deterministic fallback summary inserted, got %+v", st.insertCalls)
	}
}

func TestCompactSessionRoutesMissingGatingScoreToExtractiveAndLogsDecision(t *testing.T) {
	st := &fakeStore{
		results: []store.SearchResult{
			{ID: "a", Text: "alpha", Metadata: map[string]any{"sessionId": "s1", "ts": int64(10)}},
			{ID: "b", Text: "beta", Metadata: map[string]any{"sessionId": "s1", "ts": int64(20)}},
		},
	}
	extractive := &fakeSummarizer{
		summaries: []summarize.Summary{{Text: "extractive-summary", Method: "extractive", TokenCount: 1, Confidence: 0.5}},
		mode:      "extractive",
	}
	abstractive := &fakeSummarizer{
		summaries: []summarize.Summary{{Text: "abstractive-summary", Method: "onnx-t5", TokenCount: 1, Confidence: 0.9}},
		mode:      "onnx-local",
	}

	var buf bytes.Buffer
	prevWriter := log.Writer()
	log.SetOutput(&buf)
	defer log.SetOutput(prevWriter)

	got, err := CompactSession(context.Background(), st, extractive, abstractive, "s1", true, 20, ContinuityConfig{})
	if err != nil {
		t.Fatalf("CompactSession() error = %v", err)
	}
	if !got.DidCompact {
		t.Fatalf("expected compaction, got %+v", got)
	}
	if len(extractive.calls) != 1 {
		t.Fatalf("expected extractive summarizer to be used, got %d calls", len(extractive.calls))
	}
	if len(abstractive.calls) != 0 {
		t.Fatalf("expected abstractive summarizer to be skipped, got %d calls", len(abstractive.calls))
	}
	logged := buf.String()
	if !bytes.Contains([]byte(logged), []byte("cluster_id=0")) || !bytes.Contains([]byte(logged), []byte("mean_gating_score=0.000")) || !bytes.Contains([]byte(logged), []byte("summarizer_used=extractive")) {
		t.Fatalf("expected routing telemetry log, got %q", logged)
	}
}

func TestCompactSessionFallsBackToExtractiveWhenAbstractiveFailsPreservationGate(t *testing.T) {
	embedder := fakeEmbedder{
		vectors: map[string][]float32{
			"alpha":              {1, 0},
			"beta":               {1, 0},
			"drifted-summary":    {0, 1},
			"extractive-summary": {1, 0},
		},
	}
	st := &fakeStore{
		results: []store.SearchResult{
			{ID: "a", Text: "alpha", Metadata: map[string]any{"sessionId": "s1", "ts": int64(10), "gating_score": 0.8}},
			{ID: "b", Text: "beta", Metadata: map[string]any{"sessionId": "s1", "ts": int64(20), "gating_score": 0.8}},
		},
	}
	extractive := &fakeSummarizer{
		summaries: []summarize.Summary{{Text: "extractive-summary", Method: "extractive", TokenCount: 1, Confidence: 0.2}},
		mode:      "extractive",
		embedder:  embedder,
	}
	abstractive := &fakeSummarizer{
		summaries: []summarize.Summary{{Text: "drifted-summary", Method: "onnx-t5", TokenCount: 1, Confidence: 0.95}},
		mode:      "onnx-local",
	}

	got, err := CompactSession(context.Background(), st, extractive, abstractive, "s1", true, 20, ContinuityConfig{})
	if err != nil {
		t.Fatalf("CompactSession() error = %v", err)
	}
	if got.SummaryMethod != "extractive" {
		t.Fatalf("expected extractive fallback, got %+v", got)
	}
	if len(abstractive.calls) != 1 {
		t.Fatalf("expected one abstractive attempt, got %d", len(abstractive.calls))
	}
	if len(extractive.calls) != 1 {
		t.Fatalf("expected one extractive fallback, got %d", len(extractive.calls))
	}
	if len(st.insertCalls) != 1 {
		t.Fatalf("expected one insert, got %d", len(st.insertCalls))
	}
	if st.insertCalls[0].text != "extractive-summary" {
		t.Fatalf("expected extractive summary text after fallback, got %q", st.insertCalls[0].text)
	}
	if got := st.insertCalls[0].meta["confidence"]; got != 1.0 {
		t.Fatalf("expected fallback confidence 1.0, got %+v", got)
	}
	if got := st.insertCalls[0].meta["confidence_t5"]; got != 0.95 {
		t.Fatalf("expected original t5 confidence metadata preserved, got %+v", got)
	}
}

func TestPassesPreservationGateAtAndBelowThreshold(t *testing.T) {
	if !passesPreservationGate(PreservationThreshold) {
		t.Fatalf("expected gate to accept align exactly at threshold")
	}
	if passesPreservationGate(PreservationThreshold - 1e-9) {
		t.Fatalf("expected gate to reject align just below threshold")
	}
}

func TestCompactSessionAcceptsAbstractiveSummaryAtPreservationBoundary(t *testing.T) {
	const align = PreservationThreshold + 1e-4
	embedder := fakeEmbedder{
		vectors: map[string][]float32{
			"alpha":              {1, 0},
			"beta":               {1, 0},
			"threshold-summary":  {align, float32(math.Sqrt(1.0 - align*align))},
			"extractive-summary": {1, 0},
		},
	}
	st := &fakeStore{
		results: []store.SearchResult{
			{ID: "a", Text: "alpha", Metadata: map[string]any{"sessionId": "s1", "ts": int64(10), "gating_score": 0.8}},
			{ID: "b", Text: "beta", Metadata: map[string]any{"sessionId": "s1", "ts": int64(20), "gating_score": 0.8}},
		},
	}
	extractive := &fakeSummarizer{
		summaries: []summarize.Summary{{Text: "extractive-summary", Method: "extractive", TokenCount: 1, Confidence: 0.2}},
		mode:      "extractive",
		embedder:  embedder,
	}
	abstractive := &fakeSummarizer{
		summaries: []summarize.Summary{{Text: "threshold-summary", Method: "onnx-t5", TokenCount: 1, Confidence: 0.9}},
		mode:      "onnx-local",
	}

	got, err := CompactSession(context.Background(), st, extractive, abstractive, "s1", true, 20, ContinuityConfig{})
	if err != nil {
		t.Fatalf("CompactSession() error = %v", err)
	}
	if got.SummaryMethod != "onnx-t5" {
		t.Fatalf("expected accepted abstractive summary at threshold, got %+v", got)
	}
	if len(extractive.calls) != 0 {
		t.Fatalf("expected no extractive fallback at threshold, got %d calls", len(extractive.calls))
	}
	if len(st.insertCalls) != 1 {
		t.Fatalf("expected one inserted summary, got %d", len(st.insertCalls))
	}
	gotAlign := metaFloat(st.insertCalls[0].meta, "nomic_align")
	if gotAlign < PreservationThreshold {
		t.Fatalf("expected accepted summary to store align >= threshold, got %f", gotAlign)
	}
	if math.Abs(gotAlign-align) > 1e-4 {
		t.Fatalf("unexpected alignment metadata %+v", st.insertCalls[0].meta)
	}
}

func TestCompactSessionFallsBackJustBelowPreservationThreshold(t *testing.T) {
	const align = 0.649
	embedder := fakeEmbedder{
		vectors: map[string][]float32{
			"alpha":              {1, 0},
			"beta":               {1, 0},
			"below-threshold":    {align, float32(math.Sqrt(1.0 - align*align))},
			"extractive-summary": {1, 0},
		},
	}
	st := &fakeStore{
		results: []store.SearchResult{
			{ID: "a", Text: "alpha", Metadata: map[string]any{"sessionId": "s1", "ts": int64(10), "gating_score": 0.8}},
			{ID: "b", Text: "beta", Metadata: map[string]any{"sessionId": "s1", "ts": int64(20), "gating_score": 0.8}},
		},
	}
	extractive := &fakeSummarizer{
		summaries: []summarize.Summary{{Text: "extractive-summary", Method: "extractive", TokenCount: 1, Confidence: 0.2}},
		mode:      "extractive",
		embedder:  embedder,
	}
	abstractive := &fakeSummarizer{
		summaries: []summarize.Summary{{Text: "below-threshold", Method: "onnx-t5", TokenCount: 1, Confidence: 0.95}},
		mode:      "onnx-local",
	}

	got, err := CompactSession(context.Background(), st, extractive, abstractive, "s1", true, 20, ContinuityConfig{})
	if err != nil {
		t.Fatalf("CompactSession() error = %v", err)
	}
	if got.SummaryMethod != "extractive" {
		t.Fatalf("expected extractive fallback below threshold, got %+v", got)
	}
	if len(extractive.calls) != 1 {
		t.Fatalf("expected extractive fallback call, got %d", len(extractive.calls))
	}
}

func TestCompactSessionStoresExactHybridConfidenceForAcceptedAbstractiveSummary(t *testing.T) {
	const align = 0.8
	embedder := fakeEmbedder{
		vectors: map[string][]float32{
			"alpha":              {1, 0},
			"beta":               {1, 0},
			"hybrid-summary":     {align, 0.6},
			"extractive-summary": {1, 0},
		},
	}
	st := &fakeStore{
		results: []store.SearchResult{
			{ID: "a", Text: "alpha", Metadata: map[string]any{"sessionId": "s1", "ts": int64(10), "gating_score": 0.8}},
			{ID: "b", Text: "beta", Metadata: map[string]any{"sessionId": "s1", "ts": int64(20), "gating_score": 0.8}},
		},
	}
	extractive := &fakeSummarizer{
		summaries: []summarize.Summary{{Text: "extractive-summary", Method: "extractive", TokenCount: 1, Confidence: 0.2}},
		mode:      "extractive",
		embedder:  embedder,
	}
	abstractive := &fakeSummarizer{
		summaries: []summarize.Summary{{Text: "hybrid-summary", Method: "onnx-t5", TokenCount: 1, Confidence: 0.9}},
		mode:      "onnx-local",
	}

	_, err := CompactSession(context.Background(), st, extractive, abstractive, "s1", true, 20, ContinuityConfig{})
	if err != nil {
		t.Fatalf("CompactSession() error = %v", err)
	}
	if len(st.insertCalls) != 1 {
		t.Fatalf("expected one insert, got %d", len(st.insertCalls))
	}
	meta := st.insertCalls[0].meta
	const expectedNomic = 0.8
	const expected = NomicConfidenceWeight*expectedNomic + (1.0-NomicConfidenceWeight)*0.9
	if math.Abs(metaFloat(meta, "confidence_nomic")-expectedNomic) > 1e-6 {
		t.Fatalf("unexpected nomic confidence metadata %+v", meta)
	}
	if math.Abs(metaFloat(meta, "confidence")-expected) > 1e-6 {
		t.Fatalf("confidence = %f, want %f", metaFloat(meta, "confidence"), expected)
	}
	if math.Abs(metaFloat(meta, "decay_rate")-(1.0-expected)) > 1e-6 {
		t.Fatalf("decay_rate = %f, want %f", metaFloat(meta, "decay_rate"), 1.0-expected)
	}
	assertBoundedSummaryMeta(t, meta)
}

func TestCompactSessionStoresExactNomicConfidenceForExtractiveSummary(t *testing.T) {
	embedder := fakeEmbedder{
		vectors: map[string][]float32{
			"alpha":              {1, 0},
			"beta":               {1, 0},
			"extractive-summary": {0.8, 0.6},
		},
	}
	st := &fakeStore{
		results: []store.SearchResult{
			{ID: "a", Text: "alpha", Metadata: map[string]any{"sessionId": "s1", "ts": int64(10)}},
			{ID: "b", Text: "beta", Metadata: map[string]any{"sessionId": "s1", "ts": int64(20)}},
		},
	}
	extractive := &fakeSummarizer{
		summaries: []summarize.Summary{{Text: "extractive-summary", Method: "extractive", TokenCount: 1, Confidence: 0.1}},
		mode:      "extractive",
		embedder:  embedder,
	}

	_, err := CompactSession(context.Background(), st, extractive, nil, "s1", true, 20, ContinuityConfig{})
	if err != nil {
		t.Fatalf("CompactSession() error = %v", err)
	}
	if len(st.insertCalls) != 1 {
		t.Fatalf("expected one insert, got %d", len(st.insertCalls))
	}
	meta := st.insertCalls[0].meta
	const expected = 0.8
	if math.Abs(metaFloat(meta, "confidence")-expected) > 1e-6 {
		t.Fatalf("confidence = %f, want %f", metaFloat(meta, "confidence"), expected)
	}
	if math.Abs(metaFloat(meta, "confidence_nomic")-expected) > 1e-6 {
		t.Fatalf("confidence_nomic = %f, want %f", metaFloat(meta, "confidence_nomic"), expected)
	}
	if math.Abs(metaFloat(meta, "decay_rate")-0.2) > 1e-6 {
		t.Fatalf("decay_rate = %f, want 0.2", metaFloat(meta, "decay_rate"))
	}
	assertBoundedSummaryMeta(t, meta)
}

func TestCompactSessionDeclinesSingleMemberClustersUnderStrictProgressRule(t *testing.T) {
	st := &fakeStore{
		results: []store.SearchResult{
			{ID: "a", Text: "alpha", Metadata: map[string]any{"sessionId": "s1", "ts": int64(10)}},
			{ID: "b", Text: "beta", Metadata: map[string]any{"sessionId": "s1", "ts": int64(20)}},
			{ID: "c", Text: "gamma", Metadata: map[string]any{"sessionId": "s1", "ts": int64(30)}},
		},
	}
	sum := &fakeSummarizer{
		summaries: []summarize.Summary{
			{Text: "summary-1", SourceIDs: []string{"a", "b"}, Method: "extractive", TokenCount: 1, Confidence: 0.8},
		},
	}

	got, err := CompactSession(context.Background(), st, sum, nil, "s1", true, 2, ContinuityConfig{})
	if err != nil {
		t.Fatalf("CompactSession() error = %v", err)
	}
	if !got.DidCompact {
		t.Fatalf("expected non-singleton cluster to compact, got %+v", got)
	}
	if len(st.insertCalls) != 1 {
		t.Fatalf("expected only one summary insert, got %d", len(st.insertCalls))
	}
	if got.ClustersDeclined != 1 {
		t.Fatalf("expected one declined singleton cluster, got %+v", got)
	}
	if len(sum.calls) != 1 {
		t.Fatalf("expected only one real summarizer call for the non-trivial cluster, got %d", len(sum.calls))
	}
}

func TestCompactSessionDeclinesClusterWhenSummaryDoesNotShrinkSource(t *testing.T) {
	st := &fakeStore{
		results: []store.SearchResult{
			{ID: "a", Text: "alpha", Metadata: map[string]any{"sessionId": "s1", "ts": int64(10)}},
			{ID: "b", Text: "beta", Metadata: map[string]any{"sessionId": "s1", "ts": int64(20)}},
		},
	}
	sum := &fakeSummarizer{
		summaries: []summarize.Summary{
			{Text: "alpha beta gamma delta", SourceIDs: []string{"a", "b"}, Method: "extractive", TokenCount: 4, Confidence: 0.8},
		},
	}

	got, err := CompactSession(context.Background(), st, sum, nil, "s1", true, 20, ContinuityConfig{})
	if err != nil {
		t.Fatalf("CompactSession() error = %v", err)
	}
	if got.DidCompact {
		t.Fatalf("expected compaction to decline non-shrinking summary, got %+v", got)
	}
	if got.ClustersDeclined != 1 {
		t.Fatalf("expected one declined cluster, got %+v", got)
	}
	if len(st.insertCalls) != 0 || len(st.deleteCalls) != 0 {
		t.Fatalf("expected no insert/delete on declined cluster, got inserts=%d deletes=%d", len(st.insertCalls), len(st.deleteCalls))
	}
}

func TestEvaluatePreservationMetricsAverageAlignmentAndCoverage(t *testing.T) {
	embedder := fakeEmbedder{
		vectors: map[string][]float32{
			"turn-a":  {1, 0},
			"turn-b":  {0, 1},
			"summary": {1, 0},
		},
	}
	metrics, err := summarize.EvaluatePreservation(context.Background(), embedder, []summarize.Turn{
		{ID: "a", Text: "turn-a"},
		{ID: "b", Text: "turn-b"},
	}, "summary")
	if err != nil {
		t.Fatalf("EvaluatePreservation() error = %v", err)
	}
	if math.Abs(metrics.Align-math.Sqrt(0.5)) > 1e-9 {
		t.Fatalf("unexpected align %.9f", metrics.Align)
	}
	if metrics.Cover != 0.5 {
		t.Fatalf("unexpected cover %.9f", metrics.Cover)
	}
}

func TestSelectRecentTailBaseIsSubsetOfRecentAndOlderIsDisjoint(t *testing.T) {
	turns := []turnRecord{
		{id: "a", text: "aa", ts: 10},
		{id: "b", text: "bb", ts: 20},
		{id: "c", text: "cc", ts: 30},
		{id: "d", text: "dd", ts: 40},
	}

	got := selectRecentTail(turns, ContinuityConfig{
		MinTurns:         2,
		TailBudgetTokens: 1,
	})

	assertClusterTurnIDs(t, got.base, []string{"c", "d"})
	assertClusterTurnIDs(t, got.recent, []string{"c", "d"})
	assertClusterTurnIDs(t, got.older, []string{"a", "b"})
}

func TestSelectRecentTailExtendsBackwardToPreserveCoupledBundleAtBoundary(t *testing.T) {
	turns := []turnRecord{
		{id: "a", text: "a", ts: 10},
		{id: "b", text: "bundle-left", ts: 20, metadata: map[string]any{"continuity_bundle_id": "pair-1"}},
		{id: "c", text: "c", ts: 30, metadata: map[string]any{"continuity_bundle_id": "pair-1"}},
		{id: "d", text: "d", ts: 40},
	}

	got := selectRecentTail(turns, ContinuityConfig{
		MinTurns:         2,
		TailBudgetTokens: 2,
	})

	assertClusterTurnIDs(t, got.base, []string{"c", "d"})
	assertClusterTurnIDs(t, got.recent, []string{"b", "c", "d"})
	assertClusterTurnIDs(t, got.older, []string{"a"})
}

func TestSection6QualityLoopHighValueClusterLiftsRetrievalWeight(t *testing.T) {
	embedder := fakeEmbedder{
		vectors: map[string][]float32{
			"high-a":       {1, 0},
			"high-b":       {1, 0},
			"high-summary": {1, 0},
			"low-a":        {0, 1},
			"low-b":        {0, 1},
			"low-summary":  {1, 0},
		},
	}
	st := &fakeStore{
		results: []store.SearchResult{
			{ID: "a", Text: "high-a", Metadata: map[string]any{"sessionId": "s1", "ts": int64(10), "gating_score": 0.95}},
			{ID: "b", Text: "high-b", Metadata: map[string]any{"sessionId": "s1", "ts": int64(20), "gating_score": 0.90}},
			{ID: "c", Text: "low-a", Metadata: map[string]any{"sessionId": "s1", "ts": int64(30), "gating_score": 0.10}},
			{ID: "d", Text: "low-b", Metadata: map[string]any{"sessionId": "s1", "ts": int64(40), "gating_score": 0.10}},
		},
	}
	extractive := &fakeSummarizer{
		summaries: []summarize.Summary{
			{Text: "low-summary", Method: "extractive", TokenCount: 1, Confidence: 0.4},
		},
		mode:     "extractive",
		embedder: embedder,
	}
	abstractive := &fakeSummarizer{
		summaries: []summarize.Summary{
			{Text: "high-summary", Method: "onnx-t5", TokenCount: 1, Confidence: 0.9},
		},
		mode: "onnx-local",
	}

	got, err := CompactSession(context.Background(), st, extractive, abstractive, "s1", true, 2, ContinuityConfig{})
	if err != nil {
		t.Fatalf("CompactSession() error = %v", err)
	}
	if !got.DidCompact || len(st.insertCalls) != 2 {
		t.Fatalf("expected two inserted summaries, got %+v inserts=%d", got, len(st.insertCalls))
	}

	var highMeta, lowMeta map[string]any
	for _, call := range st.insertCalls {
		switch call.meta["method"] {
		case "onnx-t5":
			highMeta = call.meta
		case "extractive":
			lowMeta = call.meta
		}
	}
	if highMeta == nil || lowMeta == nil {
		t.Fatalf("expected one abstractive and one extractive summary, got %+v", st.insertCalls)
	}

	highConfidence := metaFloat(highMeta, "confidence")
	lowConfidence := metaFloat(lowMeta, "confidence")
	highDecay := metaFloat(highMeta, "decay_rate")
	lowDecay := metaFloat(lowMeta, "decay_rate")

	if highConfidence <= lowConfidence {
		t.Fatalf("expected higher confidence for high-value cluster, got high=%f low=%f", highConfidence, lowConfidence)
	}
	if highDecay >= lowDecay {
		t.Fatalf("expected lower decay for high-value cluster, got high=%f low=%f", highDecay, lowDecay)
	}

	const delta = 0.5
	const sharedBase = 0.8
	highQuality := 1.0 - delta*highDecay
	lowQuality := 1.0 - delta*lowDecay
	highFinal := sharedBase * highQuality
	lowFinal := sharedBase * lowQuality
	if highFinal <= lowFinal {
		t.Fatalf("expected higher downstream retrieval score, got high=%f low=%f", highFinal, lowFinal)
	}
}

func assertTurnIDs(t *testing.T, turns []summarize.Turn, want []string) {
	t.Helper()
	if len(turns) != len(want) {
		t.Fatalf("unexpected turns length: got %d want %d", len(turns), len(want))
	}
	for i, turn := range turns {
		if turn.ID != want[i] {
			t.Fatalf("unexpected turn order at %d: got %q want %q", i, turn.ID, want[i])
		}
	}
}

func assertClusterTurnIDs(t *testing.T, turns []turnRecord, want []string) {
	t.Helper()
	if len(turns) != len(want) {
		t.Fatalf("unexpected turns length: got %d want %d", len(turns), len(want))
	}
	for i, turn := range turns {
		if turn.id != want[i] {
			t.Fatalf("unexpected turn order at %d: got %q want %q", i, turn.id, want[i])
		}
	}
}

func assertBoundedSummaryMeta(t *testing.T, meta map[string]any) {
	t.Helper()
	confidence := metaFloat(meta, "confidence")
	decay := metaFloat(meta, "decay_rate")
	if confidence < 0 || confidence > 1 {
		t.Fatalf("expected confidence in [0,1], got %f", confidence)
	}
	if decay < 0 || decay > 1 {
		t.Fatalf("expected decay_rate in [0,1], got %f", decay)
	}
}

// TestMetatextualDesignProseNotElevatedViaDeontic verifies that design-intent
// metatextual prose does not elevate via the sigma/deontic path just because it
// contains a word like "preserve" or "design" that appears in the imperative verb list.
//
// Specifically tests the project corpus false positive:
//   - Text: "The design goal is: preserve high-value shadow rules that are too weakly
//     structured for AST promotion but too directive to be allowed to decay into lossy
//     summaries or low-trust recalled memory."
//   - Root cause: "preserve" is in isImperativeVerb and triggers detectBareImperative
//     at sentence start, making the deontic frame set Promoted=true for a sentence
//     that is actually describing a design goal, not issuing an operational directive.
//
// The fix belongs in the deontic frame's narrative-rhetoric filter, not threshold tuning.
func TestMetatextualDesignProseNotElevatedViaDeontic(t *testing.T) {
	const metatextualText = "The design goal is: preserve high-value shadow rules that are too weakly structured for AST promotion but too directive to be allowed to decay into lossy summaries or low-trust recalled memory."

	turn := turnRecord{
		id:   "meta",
		text: metatextualText,
		metadata: map[string]any{
			"type":             "turn",
			"sessionId":        "s1",
			"userId":           "u1",
			"ts":               int64(10),
			"stability_weight": 0.9,
			"provenance_class": "session_turn",
		},
	}

	deonticFrame := astv2.NewDeonticFrame()
	zeroEmb := &fakeEmbedder{vectors: map[string][]float32{}}
	admitted, trace := evaluateProtectedGuidanceTurn(context.Background(), turn, deonticFrame, zeroEmb)

	// The deontic frame should NOT promote this text.
	// If it does (sigma_promoted=true), it means "preserve" or "design" is being treated
	// as a bare imperative in a metatextual "design goal is: preserve X" construction.
	if admitted {
		t.Errorf("metatextual prose incorrectly admitted via %s: sigma_promoted=%v mask=%d surface_hint=%v booster_sim=%.4f\ntext: %.80q...",
			trace.AdmissionPath, trace.SigmaPromoted, trace.SigmaMask, trace.SurfaceHintMatched,
			trace.BoosterSimilarity, metatextualText)
	}
}

// TestGuidanceSurfaceHintAndBoosterMetatextualProse verifies that design-intent
// metatextual prose containing guidance-like surface words (e.g. "shadow rules",
// "should", "use") but lacking direct operational directives does not elevate via
// the booster path. The booster path requires both a surface hint AND prototype
// similarity >= ElevatedGuidanceBoosterFloor.
func TestGuidanceSurfaceHintAndBoosterMetatextualProse(t *testing.T) {
	// Texts that contain guidance-related words but are fundamentally metatextual.
	metatextualCases := []struct {
		name string
		text string
	}{
		{
			name: "design_goal_is_preserve",
			text: "The design goal is: preserve high-value shadow rules that are too weakly structured for AST promotion.",
		},
		{
			name: "assembly_order_describes_precedence",
			text: "The intended prompt precedence is: authored context, recent raw tail, elevated guidance, recalled memories.",
		},
		{
			name: "failure_policy_describes_safety",
			text: "If a local abstractive model is unavailable, slow, or times out, the system must not fail open to deleting potential shadow rules.",
		},
	}

	deonticFrame := astv2.NewDeonticFrame()

	// Use a zero embedder so booster similarity is always 0.
	zeroEmb := &fakeEmbedder{vectors: map[string][]float32{}}

	for _, tc := range metatextualCases {
		t.Run(tc.name, func(t *testing.T) {
			turn := turnRecord{
				id:   tc.name,
				text: tc.text,
				metadata: map[string]any{
					"type":             "turn",
					"sessionId":        "s1",
					"userId":           "u1",
					"ts":               int64(10),
					"stability_weight": 0.9,
					"provenance_class": "session_turn",
				},
			}

			admitted, trace := evaluateProtectedGuidanceTurn(context.Background(), turn, deonticFrame, zeroEmb)

			if admitted {
				t.Errorf("metatextual prose incorrectly admitted via %s: sigma_promoted=%v surface_hint=%v booster_sim=%.4f\ntext: %.60q...",
					trace.AdmissionPath, trace.SigmaPromoted, trace.SurfaceHintMatched,
					trace.BoosterSimilarity, tc.text)
			}
		})
	}
}
