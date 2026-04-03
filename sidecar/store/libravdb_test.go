package store

import (
	"context"
	"errors"
	"path/filepath"
	"testing"

	"github.com/xDarkicex/openclaw-memory-libravdb/sidecar/astv2"
	"github.com/xDarkicex/openclaw-memory-libravdb/sidecar/embed"
)

type fakeEmbedder struct{}

func (fakeEmbedder) EmbedDocument(_ context.Context, text string) ([]float32, error) {
	switch text {
	case "alpha":
		return []float32{1, 0, 0}, nil
	case "beta":
		return []float32{0, 1, 0}, nil
	case "query-alpha":
		return []float32{1, 0, 0}, nil
	default:
		return []float32{0, 0, 1}, nil
	}
}

func (fakeEmbedder) EmbedQuery(_ context.Context, text string) ([]float32, error) {
	return fakeEmbedder{}.EmbedDocument(context.Background(), text)
}

func (fakeEmbedder) Dimensions() int { return 3 }
func (fakeEmbedder) Profile() embed.Profile {
	return embed.Profile{
		Backend:    "test",
		Family:     "test",
		Dimensions: 3,
	}
}
func (fakeEmbedder) Ready() bool    { return true }
func (fakeEmbedder) Reason() string { return "" }
func (fakeEmbedder) Mode() string   { return "primary" }

type fakeProfiledEmbedder struct {
	fingerprint string
}

func (e fakeProfiledEmbedder) EmbedDocument(ctx context.Context, text string) ([]float32, error) {
	return fakeEmbedder{}.EmbedDocument(ctx, text)
}
func (e fakeProfiledEmbedder) EmbedQuery(ctx context.Context, text string) ([]float32, error) {
	return fakeEmbedder{}.EmbedQuery(ctx, text)
}
func (e fakeProfiledEmbedder) Dimensions() int { return 3 }
func (e fakeProfiledEmbedder) Ready() bool     { return true }
func (e fakeProfiledEmbedder) Reason() string  { return "" }
func (e fakeProfiledEmbedder) Mode() string    { return "primary" }
func (e fakeProfiledEmbedder) Profile() embed.Profile {
	return embed.Profile{
		Backend:     "onnx-local",
		Family:      "test",
		Dimensions:  3,
		Normalize:   true,
		Fingerprint: e.fingerprint,
	}
}

func TestInsertSearchAndDelete(t *testing.T) {
	ctx := context.Background()
	s, err := Open(filepath.Join(t.TempDir(), "store.libravdb"), fakeEmbedder{})
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}

	if err := s.InsertText(ctx, "session:test", "a", "alpha", map[string]any{"type": "turn"}); err != nil {
		t.Fatalf("InsertText(alpha) error = %v", err)
	}
	if err := s.InsertText(ctx, "session:test", "b", "beta", map[string]any{"type": "turn"}); err != nil {
		t.Fatalf("InsertText(beta) error = %v", err)
	}

	results, err := s.SearchText(ctx, "session:test", "query-alpha", 5, nil)
	if err != nil {
		t.Fatalf("SearchText() error = %v", err)
	}
	if len(results) != 2 {
		t.Fatalf("expected 2 results, got %d", len(results))
	}
	if results[0].ID != "a" {
		t.Fatalf("expected alpha hit first, got %s", results[0].ID)
	}

	if err := s.Delete(ctx, "session:test", "a"); err != nil {
		t.Fatalf("Delete() error = %v", err)
	}
	results, err = s.SearchText(ctx, "session:test", "query-alpha", 5, nil)
	if err != nil {
		t.Fatalf("SearchText() after delete error = %v", err)
	}
	if len(results) != 1 || results[0].ID != "b" {
		t.Fatalf("expected only beta remaining, got %+v", results)
	}
}

func TestListByMetaAndExclude(t *testing.T) {
	ctx := context.Background()
	s, err := Open(filepath.Join(t.TempDir(), "store.libravdb"), fakeEmbedder{})
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}

	_ = s.InsertText(ctx, "global", "g1", "alpha", map[string]any{"type": "doc", "source": "spec"})
	_ = s.InsertText(ctx, "global", "g2", "beta", map[string]any{"type": "doc", "source": "notes"})

	listed, err := s.ListByMeta(ctx, "global", "source", "spec")
	if err != nil {
		t.Fatalf("ListByMeta() error = %v", err)
	}
	if len(listed) != 1 || listed[0].ID != "g1" {
		t.Fatalf("expected only g1 from metadata filter, got %+v", listed)
	}

	results, err := s.SearchText(ctx, "global", "query-alpha", 5, []string{"g1"})
	if err != nil {
		t.Fatalf("SearchText() with exclude error = %v", err)
	}
	if len(results) != 1 || results[0].ID != "g2" {
		t.Fatalf("expected g2 after excluding g1, got %+v", results)
	}
}

func TestEnsureCollectionIsIdempotent(t *testing.T) {
	ctx := context.Background()
	s, err := Open(filepath.Join(t.TempDir(), "store.libravdb"), fakeEmbedder{})
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}

	if err := s.EnsureCollection(ctx, "session:test"); err != nil {
		t.Fatalf("first EnsureCollection() error = %v", err)
	}
	if err := s.EnsureCollection(ctx, "session:test"); err != nil {
		t.Fatalf("second EnsureCollection() error = %v", err)
	}
}

func TestFlushPersistsAndReloadsRecords(t *testing.T) {
	ctx := context.Background()
	storePath := filepath.Join(t.TempDir(), "store.libravdb")

	s, err := Open(storePath, fakeEmbedder{})
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}

	if err := s.InsertText(ctx, "global", "g1", "alpha", map[string]any{"source": "spec"}); err != nil {
		t.Fatalf("InsertText() error = %v", err)
	}
	if err := s.Flush(ctx); err != nil {
		t.Fatalf("Flush() error = %v", err)
	}

	reopened, err := Open(storePath, fakeEmbedder{})
	if err != nil {
		t.Fatalf("reopen Open() error = %v", err)
	}

	results, err := reopened.SearchText(ctx, "global", "query-alpha", 5, nil)
	if err != nil {
		t.Fatalf("SearchText() after reload error = %v", err)
	}
	if len(results) != 1 || results[0].ID != "g1" {
		t.Fatalf("expected persisted g1 after reload, got %+v", results)
	}
}

func TestOpenRejectsEmbeddingFingerprintMismatch(t *testing.T) {
	ctx := context.Background()
	storePath := filepath.Join(t.TempDir(), "store.libravdb")

	s, err := Open(storePath, fakeProfiledEmbedder{fingerprint: "first"})
	if err != nil {
		t.Fatalf("Open(first) error = %v", err)
	}
	if err := s.InsertText(ctx, "global", "g1", "alpha", map[string]any{"source": "spec"}); err != nil {
		t.Fatalf("InsertText() error = %v", err)
	}
	if err := s.Flush(ctx); err != nil {
		t.Fatalf("Flush() error = %v", err)
	}

	if _, err := Open(storePath, fakeProfiledEmbedder{fingerprint: "second"}); err == nil {
		t.Fatalf("expected embedding fingerprint mismatch to error")
	}
}

func TestInsertRecordAndListCollection(t *testing.T) {
	ctx := context.Background()
	s, err := Open(filepath.Join(t.TempDir(), "store.libravdb"), fakeEmbedder{})
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}

	if err := s.InsertRecord(ctx, "_tier_dirty", "session:test/doc1:64", []float32{0}, map[string]any{
		"base_collection": "session:test",
		"record_id":       "doc1",
		"dims":            64,
	}); err != nil {
		t.Fatalf("InsertRecord() error = %v", err)
	}
	if err := s.InsertRecord(ctx, "_tier_dirty", "session:test/doc1:256", []float32{0}, map[string]any{
		"base_collection": "session:test",
		"record_id":       "doc1",
		"dims":            256,
	}); err != nil {
		t.Fatalf("InsertRecord() second error = %v", err)
	}

	results, err := s.ListCollection(ctx, "_tier_dirty")
	if err != nil {
		t.Fatalf("ListCollection() error = %v", err)
	}
	if len(results) != 2 {
		t.Fatalf("expected 2 dirty records, got %d", len(results))
	}
	if results[0].ID != "session:test/doc1:256" || results[1].ID != "session:test/doc1:64" {
		t.Fatalf("expected stable id ordering, got %+v", results)
	}
	if results[0].Text != "" || results[1].Text != "" {
		t.Fatalf("expected non-semantic records to preserve empty text, got %+v", results)
	}
}

func TestInsertRecordRejectsDimensionMismatch(t *testing.T) {
	ctx := context.Background()
	s, err := Open(filepath.Join(t.TempDir(), "store.libravdb"), fakeEmbedder{})
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}

	err = s.InsertRecord(ctx, "_tier_dirty", "bad", []float32{0, 0}, map[string]any{"dims": 64})
	if err == nil {
		t.Fatalf("expected dimension mismatch error")
	}
}

func TestInsertMatryoshkaL3IsSourceOfTruth(t *testing.T) {
	ctx := context.Background()
	s, err := Open(filepath.Join(t.TempDir(), "store.libravdb"), fakeMatryoshkaEmbedder{})
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}

	s.beforeInsertRecord = func(collection, id string, vec []float32, meta map[string]any) error {
		if collection == tierCollection("test", embed.DimsL2) {
			return errors.New("injected L2 failure")
		}
		return nil
	}

	vec, err := embed.NewMatryoshkaVec(testMatryoshkaVector())
	if err != nil {
		t.Fatalf("NewMatryoshkaVec() error = %v", err)
	}

	err = s.InsertMatryoshka(ctx, "test", "doc1", vec, map[string]any{"kind": "memory"})
	if err == nil {
		t.Fatal("expected error on L2 insert failure")
	}

	if !recordExists(s, "test", "doc1") {
		t.Error("L3 record missing after L2 failure")
	}
	if recordExists(s, tierCollection("test", embed.DimsL1), "doc1") {
		t.Error("L1 record should not exist when L2 insert failed first")
	}

	dirty, err := s.ListCollection(ctx, dirtyTierCollection)
	if err != nil {
		t.Fatalf("ListCollection(_tier_dirty) error = %v", err)
	}
	if !containsDirty(dirty, "test", "doc1", embed.DimsL2) {
		t.Error("dirty marker missing for failed L2 tier")
	}
	if containsDirty(dirty, "test", "doc1", embed.DimsL1) {
		t.Error("spurious dirty marker for L1 tier")
	}
}

func TestPersistAuthoredDocumentStoresTieredRecords(t *testing.T) {
	ctx := context.Background()
	s, err := Open(filepath.Join(t.TempDir(), "store.libravdb"), fakeEmbedder{})
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}

	doc, err := astv2.ExtractDocument("AGENTS.md", []byte(`---
name: Codex
---

You must be careful.

> Prefer exact formulas.

- Always cite the governing math.

Plain lore here.
`), "tok-v1")
	if err != nil {
		t.Fatalf("ExtractDocument() error = %v", err)
	}

	if err := s.PersistAuthoredDocument(ctx, doc, true); err != nil {
		t.Fatalf("PersistAuthoredDocument() error = %v", err)
	}

	hard, err := s.ListCollection(ctx, AuthoredHardCollection)
	if err != nil {
		t.Fatalf("ListCollection(hard) error = %v", err)
	}
	soft, err := s.ListCollection(ctx, AuthoredSoftCollection)
	if err != nil {
		t.Fatalf("ListCollection(soft) error = %v", err)
	}
	variant, err := s.ListCollection(ctx, AuthoredVariantCollection)
	if err != nil {
		t.Fatalf("ListCollection(variant) error = %v", err)
	}

	if len(hard) != 2 {
		t.Fatalf("len(hard) = %d, want 2", len(hard))
	}
	if len(soft) != 2 {
		t.Fatalf("len(soft) = %d, want 2", len(soft))
	}
	if len(variant) != 1 {
		t.Fatalf("len(variant) = %d, want 1", len(variant))
	}
	if variant[0].Text != "Plain lore here." {
		t.Fatalf("variant text = %q, want plain lore", variant[0].Text)
	}
	if got := metaString(variant[0].Metadata, "source_doc"); got != "AGENTS.md" {
		t.Fatalf("variant source_doc = %q, want AGENTS.md", got)
	}
	if got := metaString(variant[0].Metadata, "node_kind"); got != string(astv2.NodeParagraph) {
		t.Fatalf("variant node_kind = %q, want %q", got, astv2.NodeParagraph)
	}
	if got := metaFloat(hard[0].Metadata, "authority"); got != 1.0 {
		t.Fatalf("hard authority = %v, want 1.0", got)
	}
	if got := metaInt(soft[0].Metadata, "position"); got <= 0 {
		t.Fatalf("soft position = %d, want > 0", got)
	}
	if got := metaFloat(variant[0].Metadata, "access_count"); got != 0 {
		t.Fatalf("variant access_count = %v, want 0", got)
	}
}

func TestPersistAuthoredDocumentStoresHopTargetsFromASTMetadata(t *testing.T) {
	ctx := context.Background()
	s, err := Open(filepath.Join(t.TempDir(), "test.libravdb"), fakeEmbedder{})
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}

	doc, err := astv2.ExtractDocument("AGENTS.md", []byte(`---
hop_targets: [souls.md#000007]
---

Regular narrative lore goes here.
`), "tok-v1")
	if err != nil {
		t.Fatalf("ExtractDocument() error = %v", err)
	}
	if err := s.PersistAuthoredDocument(ctx, doc, true); err != nil {
		t.Fatalf("PersistAuthoredDocument() error = %v", err)
	}

	variant, err := s.ListCollection(ctx, AuthoredVariantCollection)
	if err != nil {
		t.Fatalf("ListCollection(variant) error = %v", err)
	}
	if len(variant) != 1 {
		t.Fatalf("len(variant) = %d, want 1", len(variant))
	}
	switch hopTargets := variant[0].Metadata["hop_targets"].(type) {
	case []string:
		if len(hopTargets) != 1 || hopTargets[0] != "souls.md#000007" {
			t.Fatalf("hop_targets = %+v, want [souls.md#000007]", hopTargets)
		}
	case []any:
		if len(hopTargets) != 1 || hopTargets[0] != "souls.md#000007" {
			t.Fatalf("hop_targets = %+v, want [souls.md#000007]", hopTargets)
		}
	default:
		t.Fatalf("hop_targets type = %T, want []string or []any", variant[0].Metadata["hop_targets"])
	}
}

func TestPersistAuthoredDocumentReplacesPreviousSourceDocRecords(t *testing.T) {
	ctx := context.Background()
	s, err := Open(filepath.Join(t.TempDir(), "store.libravdb"), fakeEmbedder{})
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}

	first, err := astv2.ExtractDocument("souls.md", []byte(`You must answer precisely.

Lore alpha.
`), "tok-v1")
	if err != nil {
		t.Fatalf("ExtractDocument(first) error = %v", err)
	}
	second, err := astv2.ExtractDocument("souls.md", []byte(`> Style reminder.

Lore beta.
`), "tok-v1")
	if err != nil {
		t.Fatalf("ExtractDocument(second) error = %v", err)
	}

	if err := s.PersistAuthoredDocument(ctx, first, true); err != nil {
		t.Fatalf("PersistAuthoredDocument(first) error = %v", err)
	}
	if err := s.PersistAuthoredDocument(ctx, second, true); err != nil {
		t.Fatalf("PersistAuthoredDocument(second) error = %v", err)
	}

	hard, err := s.ListByMeta(ctx, AuthoredHardCollection, "source_doc", "souls.md")
	if err != nil {
		t.Fatalf("ListByMeta(hard) error = %v", err)
	}
	soft, err := s.ListByMeta(ctx, AuthoredSoftCollection, "source_doc", "souls.md")
	if err != nil {
		t.Fatalf("ListByMeta(soft) error = %v", err)
	}
	variant, err := s.ListByMeta(ctx, AuthoredVariantCollection, "source_doc", "souls.md")
	if err != nil {
		t.Fatalf("ListByMeta(variant) error = %v", err)
	}

	if len(hard) != 0 {
		t.Fatalf("expected previous hard records to be removed, got %+v", hard)
	}
	if len(soft) != 1 || soft[0].Text != "Style reminder." {
		t.Fatalf("expected only replacement soft record, got %+v", soft)
	}
	if len(variant) != 1 || variant[0].Text != "Lore beta." {
		t.Fatalf("expected only replacement variant record, got %+v", variant)
	}
}

func TestBackfillDirtyTiersRestoresMissingTier(t *testing.T) {
	ctx := context.Background()
	s, err := Open(filepath.Join(t.TempDir(), "store.libravdb"), fakeMatryoshkaEmbedder{})
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}

	vec, err := embed.NewMatryoshkaVec(testMatryoshkaVector())
	if err != nil {
		t.Fatalf("NewMatryoshkaVec() error = %v", err)
	}
	if err := s.InsertRecord(ctx, "test", "doc1", vec.L3, map[string]any{"kind": "memory"}); err != nil {
		t.Fatalf("InsertRecord(L3) error = %v", err)
	}
	if err := s.InsertRecord(ctx, dirtyTierCollection, dirtyID("test", "doc1", embed.DimsL2), []float32{0}, map[string]any{
		"base_collection": "test",
		"record_id":       "doc1",
		"dims":            embed.DimsL2,
	}); err != nil {
		t.Fatalf("InsertRecord(dirty) error = %v", err)
	}

	if err := s.BackfillDirtyTiers(ctx); err != nil {
		t.Fatalf("BackfillDirtyTiers() error = %v", err)
	}
	if !recordExists(s, tierCollection("test", embed.DimsL2), "doc1") {
		t.Fatalf("expected L2 tier record to be restored")
	}
	dirty, err := s.ListCollection(ctx, dirtyTierCollection)
	if err != nil {
		t.Fatalf("ListCollection(_tier_dirty) error = %v", err)
	}
	if len(dirty) != 0 {
		t.Fatalf("expected dirty collection to be empty after restore, got %+v", dirty)
	}
}

func TestCascadeExitsAtCorrectTier(t *testing.T) {
	ctx := context.Background()
	s, err := Open(filepath.Join(t.TempDir(), "store.libravdb"), fakeMatryoshkaEmbedder{})
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}

	cfg := CascadeConfig{
		ExitThresholdL1: 0.65,
		ExitThresholdL2: 0.75,
		BudgetMs:        50,
	}

	vec, err := embed.NewMatryoshkaVec(testMatryoshkaVector())
	if err != nil {
		t.Fatalf("NewMatryoshkaVec() error = %v", err)
	}
	if err := s.InsertMatryoshka(ctx, "test", "doc1", vec, nil); err != nil {
		t.Fatalf("InsertMatryoshka() error = %v", err)
	}

	result := s.CascadeSearch(ctx, "test", vec, 1, nil, cfg)
	if result.TierUsed != 1 {
		t.Errorf("expected L1 exit for identical vector, got tier %d", result.TierUsed)
	}
	if len(result.Exits) == 0 || result.Exits[0].BestScore < 0.65 {
		t.Errorf("L1 best score %.4f below exit threshold", best(result.Hits))
	}
}

func TestCascadeFallsThroughOnLowScore(t *testing.T) {
	ctx := context.Background()
	s, err := Open(filepath.Join(t.TempDir(), "store.libravdb"), fakeMatryoshkaEmbedder{})
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}

	cfg := CascadeConfig{
		ExitThresholdL1: 0.65,
		ExitThresholdL2: 0.75,
		BudgetMs:        50,
	}

	vec, err := embed.NewMatryoshkaVec(testMatryoshkaVector())
	if err != nil {
		t.Fatalf("NewMatryoshkaVec() error = %v", err)
	}
	if err := s.InsertMatryoshka(ctx, "test", "doc1", vec, nil); err != nil {
		t.Fatalf("InsertMatryoshka() error = %v", err)
	}

	orthogonal, err := embed.NewMatryoshkaVec(orthogonalMatryoshkaVector())
	if err != nil {
		t.Fatalf("NewMatryoshkaVec(orthogonal) error = %v", err)
	}
	result := s.CascadeSearch(ctx, "test", orthogonal, 1, nil, cfg)
	if result.TierUsed != 3 {
		t.Errorf("expected L3 fallthrough for orthogonal query, got tier %d", result.TierUsed)
	}
	if len(result.Exits) != 3 {
		t.Errorf("expected 3 tier exit records, got %d", len(result.Exits))
	}
}

func TestCascadeDegradesWhenTierEmpty(t *testing.T) {
	ctx := context.Background()
	s, err := Open(filepath.Join(t.TempDir(), "store.libravdb"), fakeMatryoshkaEmbedder{})
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}

	cfg := CascadeConfig{
		ExitThresholdL1: 0.65,
		ExitThresholdL2: 0.75,
		BudgetMs:        50,
	}

	vec, err := embed.NewMatryoshkaVec(testMatryoshkaVector())
	if err != nil {
		t.Fatalf("NewMatryoshkaVec() error = %v", err)
	}
	if err := s.InsertRecord(ctx, "test", "doc1", vec.L3, nil); err != nil {
		t.Fatalf("InsertRecord(L3) error = %v", err)
	}

	result := s.CascadeSearch(ctx, "test", vec, 1, nil, cfg)
	if result.TierUsed != 3 {
		t.Errorf("expected L3 fallthrough when lower tiers are empty, got tier %d", result.TierUsed)
	}
}

type fakeMatryoshkaEmbedder struct{}

func (fakeMatryoshkaEmbedder) EmbedDocument(_ context.Context, _ string) ([]float32, error) {
	return testMatryoshkaVector(), nil
}

func (fakeMatryoshkaEmbedder) EmbedQuery(_ context.Context, _ string) ([]float32, error) {
	return testMatryoshkaVector(), nil
}

func (fakeMatryoshkaEmbedder) Dimensions() int { return embed.DimsL3 }
func (fakeMatryoshkaEmbedder) Ready() bool     { return true }
func (fakeMatryoshkaEmbedder) Reason() string  { return "" }
func (fakeMatryoshkaEmbedder) Mode() string    { return "primary" }
func (fakeMatryoshkaEmbedder) Profile() embed.Profile {
	return embed.Profile{
		Backend:    "onnx-local",
		Family:     "nomic-embed-text-v1.5",
		Dimensions: embed.DimsL3,
		Normalize:  true,
	}
}

func testMatryoshkaVector() []float32 {
	full := make([]float32, embed.DimsL3)
	full[0] = 1
	full[1] = 0.5
	full[2] = 0.25
	return full
}

func orthogonalMatryoshkaVector() []float32 {
	full := make([]float32, embed.DimsL3)
	full[10] = 1
	full[11] = -0.5
	full[12] = 0.25
	return full
}

func recordExists(s *Store, collection, id string) bool {
	results, err := s.ListCollection(context.Background(), collection)
	if err != nil {
		return false
	}
	for _, rec := range results {
		if rec.ID == id {
			return true
		}
	}
	return false
}

func containsDirty(records []SearchResult, base, id string, dims int) bool {
	want := dirtyID(base, id, dims)
	for _, rec := range records {
		if rec.ID == want {
			return true
		}
	}
	return false
}

func metaFloat(meta map[string]any, key string) float64 {
	value, ok := meta[key]
	if !ok {
		return 0
	}
	switch typed := value.(type) {
	case float64:
		return typed
	case float32:
		return float64(typed)
	case int:
		return float64(typed)
	default:
		return 0
	}
}
