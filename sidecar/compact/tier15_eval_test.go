package compact

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/xDarkicex/openclaw-memory-libravdb/sidecar/embed"
	"github.com/xDarkicex/openclaw-memory-libravdb/sidecar/store"
	"github.com/xDarkicex/openclaw-memory-libravdb/sidecar/summarize"
)

type tier15EvalEmbedder struct{}

func (tier15EvalEmbedder) EmbedDocument(_ context.Context, text string) ([]float32, error) {
	switch text {
	case "Never use mutexes in the hot path.":
		return []float32{1, 0, 0}, nil
	case "We should probably keep the router focused on stealth.":
		return []float32{1, 0, 0}, nil
	case "Prefer arena allocators for the radix tree.":
		return []float32{1, 0, 0}, nil
	case "What allocator should the radix tree use?":
		return []float32{1, 0, 0}, nil
	case "Prefer deterministic operational guidance over generic defaults.":
		return []float32{1, 0, 0}, nil
	case "Avoid unsafe or undesired implementation choices in hot paths.":
		return []float32{0, 1, 0}, nil
	case "Use the specified approach when implementing core project logic.":
		return []float32{1, 0, 0}, nil
	case "Keep the implementation aligned with project-specific engineering rules.":
		return []float32{1, 0, 0}, nil
	case "background implementation detail":
		return []float32{0, 1, 0}, nil
	case "background detail":
		return []float32{0, 1, 0}, nil
	case "condensed summary":
		return []float32{0, 1, 0}, nil
	default:
		return []float32{0, 0, 1}, nil
	}
}

func (e tier15EvalEmbedder) EmbedQuery(ctx context.Context, text string) ([]float32, error) {
	return e.EmbedDocument(ctx, text)
}

func (tier15EvalEmbedder) Dimensions() int { return 3 }
func (tier15EvalEmbedder) Profile() embed.Profile {
	return embed.Profile{Backend: "test", Family: "tier15-eval", Dimensions: 3}
}
func (tier15EvalEmbedder) Ready() bool    { return true }
func (tier15EvalEmbedder) Reason() string { return "" }
func (tier15EvalEmbedder) Mode() string   { return "primary" }

type tier15EvalRow struct {
	Name   string
	Passed bool
	Detail string
}

func TestTier15FocusedEvaluationHarness(t *testing.T) {
	rows := []tier15EvalRow{
		evalStrictDeonticHit(t),
		evalBorderlineSemanticRescueHit(t),
		evalLowStabilityFalsePositiveGuard(t),
		evalPostCompactionRetrievalSurvival(t),
	}

	passed := 0
	for _, row := range rows {
		t.Logf("tier15_eval case=%s passed=%t detail=%s", row.Name, row.Passed, row.Detail)
		if !row.Passed {
			t.Fatalf("tier15_eval failed: %s (%s)", row.Name, row.Detail)
		}
		passed++
	}
	t.Logf("tier15_eval summary passed=%d total=%d", passed, len(rows))
}

func evalStrictDeonticHit(t *testing.T) tier15EvalRow {
	t.Helper()

	st := &fakeStore{
		results: []store.SearchResult{
			{ID: "a", Text: "Never use mutexes in the hot path.", Metadata: map[string]any{"sessionId": "s1", "userId": "u1", "ts": int64(10), "stability_weight": 0.8, "provenance_class": "session_turn"}},
			{ID: "b", Text: "background implementation detail", Metadata: map[string]any{"sessionId": "s1", "userId": "u1", "ts": int64(20), "stability_weight": 0.2, "provenance_class": "session_turn"}},
		},
	}
	sum := &fakeSummarizer{
		summaries: []summarize.Summary{{Text: "background detail", SourceIDs: []string{"b"}, Method: "extractive", TokenCount: 2, Confidence: 0.8}},
		embedder:  tier15EvalEmbedder{},
	}

	_, err := CompactSession(context.Background(), st, sum, nil, "s1", true, 2, ContinuityConfig{})
	if err != nil {
		return tier15EvalRow{Name: "strict_deontic_hit", Passed: false, Detail: err.Error()}
	}
	if len(st.insertCalls) == 0 || st.insertCalls[0].collection != "elevated:user:u1" {
		return tier15EvalRow{Name: "strict_deontic_hit", Passed: false, Detail: "strict hit did not persist to durable elevated namespace"}
	}
	return tier15EvalRow{Name: "strict_deontic_hit", Passed: true, Detail: st.insertCalls[0].collection}
}

func evalBorderlineSemanticRescueHit(t *testing.T) tier15EvalRow {
	t.Helper()

	st := &fakeStore{
		results: []store.SearchResult{
			{ID: "a", Text: "We should probably keep the router focused on stealth.", Metadata: map[string]any{"sessionId": "s1", "userId": "u1", "ts": int64(10), "stability_weight": 0.8, "provenance_class": "session_turn"}},
			{ID: "b", Text: "background implementation detail", Metadata: map[string]any{"sessionId": "s1", "userId": "u1", "ts": int64(20), "stability_weight": 0.2, "provenance_class": "session_turn"}},
		},
	}
	sum := &fakeSummarizer{
		summaries: []summarize.Summary{{Text: "background detail", SourceIDs: []string{"b"}, Method: "extractive", TokenCount: 2, Confidence: 0.8}},
		embedder:  tier15EvalEmbedder{},
	}

	_, err := CompactSession(context.Background(), st, sum, nil, "s1", true, 2, ContinuityConfig{})
	if err != nil {
		return tier15EvalRow{Name: "borderline_semantic_rescue_hit", Passed: false, Detail: err.Error()}
	}
	if len(st.insertCalls) == 0 || st.insertCalls[0].collection != "elevated:user:u1" {
		return tier15EvalRow{Name: "borderline_semantic_rescue_hit", Passed: false, Detail: "semantic rescue did not persist to durable elevated namespace"}
	}
	return tier15EvalRow{Name: "borderline_semantic_rescue_hit", Passed: true, Detail: st.insertCalls[0].collection}
}

func evalLowStabilityFalsePositiveGuard(t *testing.T) tier15EvalRow {
	t.Helper()

	st := &fakeStore{
		results: []store.SearchResult{
			{ID: "a", Text: "We should probably keep the router focused on stealth.", Metadata: map[string]any{"sessionId": "s1", "userId": "u1", "ts": int64(10), "stability_weight": 0.1, "provenance_class": "session_turn"}},
			{ID: "b", Text: "background implementation detail", Metadata: map[string]any{"sessionId": "s1", "userId": "u1", "ts": int64(20), "stability_weight": 0.1, "provenance_class": "session_turn"}},
		},
	}
	sum := &fakeSummarizer{
		summaries: []summarize.Summary{{Text: "condensed summary", SourceIDs: []string{"a", "b"}, Method: "extractive", TokenCount: 2, Confidence: 0.8}},
		embedder:  tier15EvalEmbedder{},
	}

	_, err := CompactSession(context.Background(), st, sum, nil, "s1", true, 2, ContinuityConfig{})
	if err != nil {
		return tier15EvalRow{Name: "low_stability_false_positive_guard", Passed: false, Detail: err.Error()}
	}
	if len(st.insertCalls) != 1 || st.insertCalls[0].collection != "session:s1" {
		return tier15EvalRow{Name: "low_stability_false_positive_guard", Passed: false, Detail: "low-stability turn incorrectly promoted into Tier 1.5"}
	}
	return tier15EvalRow{Name: "low_stability_false_positive_guard", Passed: true, Detail: st.insertCalls[0].collection}
}

func evalPostCompactionRetrievalSurvival(t *testing.T) tier15EvalRow {
	t.Helper()

	ctx := context.Background()
	st, err := store.Open(filepath.Join(t.TempDir(), "tier15-eval.libravdb"), tier15EvalEmbedder{})
	if err != nil {
		return tier15EvalRow{Name: "post_compaction_retrieval_survival", Passed: false, Detail: err.Error()}
	}

	if err := st.InsertText(ctx, "session:s1", "a", "Prefer arena allocators for the radix tree.", map[string]any{
		"type":             "turn",
		"sessionId":        "s1",
		"userId":           "u1",
		"ts":               int64(10),
		"stability_weight": 0.8,
		"provenance_class": "session_turn",
	}); err != nil {
		return tier15EvalRow{Name: "post_compaction_retrieval_survival", Passed: false, Detail: err.Error()}
	}
	if err := st.InsertText(ctx, "session:s1", "b", "background implementation detail", map[string]any{
		"type":             "turn",
		"sessionId":        "s1",
		"userId":           "u1",
		"ts":               int64(20),
		"stability_weight": 0.2,
		"provenance_class": "session_turn",
	}); err != nil {
		return tier15EvalRow{Name: "post_compaction_retrieval_survival", Passed: false, Detail: err.Error()}
	}

	sum := &fakeSummarizer{
		summaries: []summarize.Summary{{Text: "background detail", SourceIDs: []string{"b"}, Method: "extractive", TokenCount: 2, Confidence: 0.8}},
		embedder:  tier15EvalEmbedder{},
	}

	if _, err := CompactSession(ctx, st, sum, nil, "s1", true, 2, ContinuityConfig{}); err != nil {
		return tier15EvalRow{Name: "post_compaction_retrieval_survival", Passed: false, Detail: err.Error()}
	}

	hits, err := st.SearchText(ctx, "elevated:user:u1", "What allocator should the radix tree use?", 3, nil)
	if err != nil {
		return tier15EvalRow{Name: "post_compaction_retrieval_survival", Passed: false, Detail: err.Error()}
	}
	if len(hits) == 0 || hits[0].Text != "Prefer arena allocators for the radix tree." {
		return tier15EvalRow{Name: "post_compaction_retrieval_survival", Passed: false, Detail: "durable elevated shard was not retrievable after compaction"}
	}
	return tier15EvalRow{Name: "post_compaction_retrieval_survival", Passed: true, Detail: hits[0].ID}
}
