package server

import (
	"context"
	"math"
	"path/filepath"
	"testing"

	"github.com/xDarkicex/openclaw-memory-libravdb/sidecar/compact"
	"github.com/xDarkicex/openclaw-memory-libravdb/sidecar/embed"
	"github.com/xDarkicex/openclaw-memory-libravdb/sidecar/health"
	"github.com/xDarkicex/openclaw-memory-libravdb/sidecar/store"
	"github.com/xDarkicex/openclaw-memory-libravdb/sidecar/summarize"
)

type fakeEmbedder struct{}

func (fakeEmbedder) EmbedDocument(_ context.Context, text string) ([]float32, error) {
	switch text {
	case "alpha":
		return []float32{1, 0}, nil
	case "query-alpha":
		return []float32{1, 0}, nil
	case "gate-query":
		return []float32{1, 0}, nil
	case "turn-match":
		return []float32{1, 0}, nil
	case "memory-match":
		return []float32{1, 0}, nil
	case "I prefer switching /src/context-engine.ts after fixed ERR_TIMEOUT in func ComputeGating() on 2026-03-29.":
		return []float32{1, 0}, nil
	default:
		return []float32{0, 1}, nil
	}
}

func (fakeEmbedder) EmbedQuery(_ context.Context, text string) ([]float32, error) {
	return fakeEmbedder{}.EmbedDocument(context.Background(), text)
}

func (fakeEmbedder) Dimensions() int { return 2 }
func (fakeEmbedder) Profile() embed.Profile {
	return embed.Profile{
		Backend:    "test",
		Family:     "test",
		Dimensions: 2,
	}
}
func (fakeEmbedder) Ready() bool    { return true }
func (fakeEmbedder) Reason() string { return "" }
func (fakeEmbedder) Mode() string   { return "primary" }

func TestRPCInsertSearchAndDelete(t *testing.T) {
	ctx := context.Background()
	st, err := store.Open(filepath.Join(t.TempDir(), "test.libravdb"), fakeEmbedder{})
	if err != nil {
		t.Fatalf("store.Open() error = %v", err)
	}

	srv := New(fakeEmbedder{}, nil, nil, st, compact.DefaultGatingConfig())

	if _, err := srv.Call(ctx, "insert_text", map[string]any{
		"collection": "session:test",
		"id":         "a",
		"text":       "alpha",
		"metadata":   map[string]any{"type": "turn"},
	}); err != nil {
		t.Fatalf("insert_text error = %v", err)
	}

	got, err := srv.Call(ctx, "search_text", map[string]any{
		"collection": "session:test",
		"text":       "query-alpha",
		"k":          5,
	})
	if err != nil {
		t.Fatalf("search_text error = %v", err)
	}

	search, ok := got.(searchTextResult)
	if !ok {
		t.Fatalf("expected searchTextResult, got %T", got)
	}
	if len(search.Results) != 1 || search.Results[0].ID != "a" {
		t.Fatalf("unexpected search results: %+v", search.Results)
	}

	if _, err := srv.Call(ctx, "delete", map[string]any{
		"collection": "session:test",
		"id":         "a",
	}); err != nil {
		t.Fatalf("delete error = %v", err)
	}
}

func TestRPCHealthAndListByMeta(t *testing.T) {
	ctx := context.Background()
	st, err := store.Open(filepath.Join(t.TempDir(), "test.libravdb"), fakeEmbedder{})
	if err != nil {
		t.Fatalf("store.Open() error = %v", err)
	}
	srv := New(fakeEmbedder{}, nil, nil, st, compact.DefaultGatingConfig())

	if _, err := srv.Call(ctx, "insert_text", map[string]any{
		"collection": "global",
		"id":         "g1",
		"text":       "alpha",
		"metadata":   map[string]any{"source": "spec"},
	}); err != nil {
		t.Fatalf("insert_text error = %v", err)
	}

	got, err := srv.Call(ctx, "list_by_meta", map[string]any{
		"collection": "global",
		"key":        "source",
		"value":      "spec",
	})
	if err != nil {
		t.Fatalf("list_by_meta error = %v", err)
	}
	listed := got.(searchTextResult)
	if len(listed.Results) != 1 || listed.Results[0].ID != "g1" {
		t.Fatalf("unexpected list_by_meta results: %+v", listed.Results)
	}

	gotHealth, err := srv.Call(ctx, "health", nil)
	if err != nil {
		t.Fatalf("health error = %v", err)
	}
	status, ok := gotHealth.(health.Status)
	if !ok {
		t.Fatalf("expected health.Status, got %T", gotHealth)
	}
	if !status.OK {
		t.Fatalf("expected healthy response, got %+v", gotHealth)
	}
}

func TestRPCUnknownMethodErrors(t *testing.T) {
	ctx := context.Background()
	st, err := store.Open(filepath.Join(t.TempDir(), "test.libravdb"), fakeEmbedder{})
	if err != nil {
		t.Fatalf("store.Open() error = %v", err)
	}
	srv := New(fakeEmbedder{}, nil, nil, st, compact.DefaultGatingConfig())

	if _, err := srv.Call(ctx, "does_not_exist", nil); err == nil {
		t.Fatalf("expected unknown method to error")
	}
}

func TestRPCMalformedParamsError(t *testing.T) {
	ctx := context.Background()
	st, err := store.Open(filepath.Join(t.TempDir(), "test.libravdb"), fakeEmbedder{})
	if err != nil {
		t.Fatalf("store.Open() error = %v", err)
	}
	srv := New(fakeEmbedder{}, nil, nil, st, compact.DefaultGatingConfig())

	if _, err := srv.Call(ctx, "insert_text", "not-an-object"); err == nil {
		t.Fatalf("expected malformed params to error")
	}
}

func TestRPCCompactReturnsStructuredResult(t *testing.T) {
	ctx := context.Background()
	st, err := store.Open(filepath.Join(t.TempDir(), "test.libravdb"), fakeEmbedder{})
	if err != nil {
		t.Fatalf("store.Open() error = %v", err)
	}
	srv := New(fakeEmbedder{}, summarize.NewExtractive(fakeEmbedder{}, "extractive"), nil, st, compact.DefaultGatingConfig())

	if _, err := srv.Call(ctx, "insert_text", map[string]any{
		"collection": "session:test",
		"id":         "a",
		"text":       "alpha",
		"metadata":   map[string]any{"type": "turn", "sessionId": "test", "ts": int64(10)},
	}); err != nil {
		t.Fatalf("insert_text(a) error = %v", err)
	}
	if _, err := srv.Call(ctx, "insert_text", map[string]any{
		"collection": "session:test",
		"id":         "b",
		"text":       "alpha",
		"metadata":   map[string]any{"type": "turn", "sessionId": "test", "ts": int64(20)},
	}); err != nil {
		t.Fatalf("insert_text(b) error = %v", err)
	}

	got, err := srv.Call(ctx, "compact_session", map[string]any{
		"sessionId":  "test",
		"force":      true,
		"targetSize": 20,
	})
	if err != nil {
		t.Fatalf("compact_session error = %v", err)
	}

	result, ok := got.(compact.Result)
	if !ok {
		t.Fatalf("expected compact.Result, got %T", got)
	}
	if !result.DidCompact || result.ClustersFormed != 1 || result.TurnsRemoved != 2 {
		t.Fatalf("unexpected compact result: %+v", result)
	}
	if result.SummaryMethod == "" {
		t.Fatalf("expected summary method in compact result: %+v", result)
	}
}

func TestRPCGatingScalarReturnsDecomposedSignals(t *testing.T) {
	ctx := context.Background()
	st, err := store.Open(filepath.Join(t.TempDir(), "test.libravdb"), fakeEmbedder{})
	if err != nil {
		t.Fatalf("store.Open() error = %v", err)
	}
	srv := New(fakeEmbedder{}, nil, nil, st, compact.DefaultGatingConfig())

	for i := 0; i < 5; i++ {
		if err := st.InsertText(ctx, "turns:u1", string(rune('a'+i)), "turn-match", map[string]any{"type": "turn"}); err != nil {
			t.Fatalf("turn insert %d error = %v", i, err)
		}
	}
	for i := 0; i < 2; i++ {
		if err := st.InsertText(ctx, "user:u1", string(rune('k'+i)), "memory-match", map[string]any{"type": "turn", "userId": "u1"}); err != nil {
			t.Fatalf("memory insert %d error = %v", i, err)
		}
	}

	got, err := srv.Call(ctx, "gating_scalar", map[string]any{
		"userId": "u1",
		"text":   "I prefer switching /src/context-engine.ts after fixed ERR_TIMEOUT in func ComputeGating() on 2026-03-29.",
	})
	if err != nil {
		t.Fatalf("gating_scalar error = %v", err)
	}

	signals, ok := got.(compact.GatingSignals)
	if !ok {
		t.Fatalf("expected compact.GatingSignals, got %T", got)
	}
	if signals.InputFreq != 1.0 {
		t.Fatalf("InputFreq = %v, want 1.0", signals.InputFreq)
	}
	if signals.MemSaturation != (2.0 / 3.0) {
		t.Fatalf("MemSaturation = %v, want %v", signals.MemSaturation, 2.0/3.0)
	}
	if signals.H != 0.0 {
		t.Fatalf("H = %v, want 0.0", signals.H)
	}
	if signals.D <= 0.0 {
		t.Fatalf("D = %v, want positive conversational structure", signals.D)
	}
	if math.Abs(signals.R-(1.0/3.0)) > 1e-12 {
		t.Fatalf("R = %v, want %v", signals.R, 1.0/3.0)
	}
	if signals.T < 0.5 {
		t.Fatalf("T = %v, want technical mixture weight above 0.5", signals.T)
	}
	if signals.P <= 0.0 || signals.A <= 0.0 || signals.Dtech <= 0.0 {
		t.Fatalf("expected positive technical signals, got %+v", signals)
	}
	if signals.G < signals.Gconv || signals.G > signals.Gtech {
		t.Fatalf("expected convex blend bounded by sub-formulas, got %+v", signals)
	}
}

func TestRPCStatusReportsCountsAndThreshold(t *testing.T) {
	ctx := context.Background()
	st, err := store.Open(filepath.Join(t.TempDir(), "test.libravdb"), fakeEmbedder{})
	if err != nil {
		t.Fatalf("store.Open() error = %v", err)
	}
	cfg := compact.DefaultGatingConfig()
	cfg.Threshold = 0.42
	srv := New(fakeEmbedder{}, nil, nil, st, cfg)

	if err := st.InsertText(ctx, "turns:u1", "t1", "turn-match", map[string]any{"type": "turn"}); err != nil {
		t.Fatalf("turn insert error = %v", err)
	}
	if err := st.InsertText(ctx, "user:u1", "m1", "memory-match", map[string]any{"type": "turn"}); err != nil {
		t.Fatalf("memory insert error = %v", err)
	}

	got, err := srv.Call(ctx, "status", nil)
	if err != nil {
		t.Fatalf("status error = %v", err)
	}

	status, ok := got.(memoryStatus)
	if !ok {
		t.Fatalf("expected memoryStatus, got %T", got)
	}
	if !status.OK {
		t.Fatalf("expected healthy status, got %+v", status)
	}
	if status.TurnCount != 1 || status.MemoryCount != 1 {
		t.Fatalf("unexpected counts: %+v", status)
	}
	if status.GatingThreshold != 0.42 {
		t.Fatalf("GatingThreshold = %v, want 0.42", status.GatingThreshold)
	}
}

func TestRPCExportMemoryAndFlushNamespace(t *testing.T) {
	ctx := context.Background()
	st, err := store.Open(filepath.Join(t.TempDir(), "test.libravdb"), fakeEmbedder{})
	if err != nil {
		t.Fatalf("store.Open() error = %v", err)
	}
	srv := New(fakeEmbedder{}, nil, nil, st, compact.DefaultGatingConfig())

	if err := st.InsertText(ctx, "user:u1", "a", "memory-match", map[string]any{"userId": "u1"}); err != nil {
		t.Fatalf("u1 insert error = %v", err)
	}
	if err := st.InsertText(ctx, "user:u2", "b", "memory-match", map[string]any{"userId": "u2"}); err != nil {
		t.Fatalf("u2 insert error = %v", err)
	}

	exportedRaw, err := srv.Call(ctx, "export_memory", map[string]any{"userId": "u1"})
	if err != nil {
		t.Fatalf("export_memory error = %v", err)
	}
	exported, ok := exportedRaw.(exportMemoryResult)
	if !ok {
		t.Fatalf("expected exportMemoryResult, got %T", exportedRaw)
	}
	if len(exported.Records) != 1 || exported.Records[0].Collection != "user:u1" || exported.Records[0].ID != "a" {
		t.Fatalf("unexpected export records: %+v", exported.Records)
	}

	if _, err := srv.Call(ctx, "flush_namespace", map[string]any{"userId": "u1"}); err != nil {
		t.Fatalf("flush_namespace error = %v", err)
	}

	u1, err := st.ListCollection(ctx, "user:u1")
	if err != nil {
		t.Fatalf("ListCollection(user:u1) error = %v", err)
	}
	if len(u1) != 0 {
		t.Fatalf("expected user:u1 to be empty after flush, got %+v", u1)
	}

	u2, err := st.ListCollection(ctx, "user:u2")
	if err != nil {
		t.Fatalf("ListCollection(user:u2) error = %v", err)
	}
	if len(u2) != 1 || u2[0].ID != "b" {
		t.Fatalf("expected user:u2 to remain intact, got %+v", u2)
	}
}
