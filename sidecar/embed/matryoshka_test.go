package embed

import (
	"context"
	"math"
	"math/rand"
	"os"
	"strings"
	"testing"
)

func TestTruncateAndNormalize(t *testing.T) {
	full := randomUnitVec(DimsL3)
	mv, err := NewMatryoshkaVec(full)
	if err != nil {
		t.Fatal(err)
	}

	for _, tc := range []struct {
		name string
		v    []float32
	}{
		{"L1", mv.L1},
		{"L2", mv.L2},
		{"L3", mv.L3},
	} {
		var norm float64
		for _, x := range tc.v {
			norm += float64(x) * float64(x)
		}
		norm = math.Sqrt(norm)
		if math.Abs(norm-1.0) > 1e-5 {
			t.Errorf("%s: L2 norm = %.8f, want 1.0", tc.name, norm)
		}
	}
}

func TestMatryoshkaSimilarityPreservation(t *testing.T) {
	if testing.Short() {
		t.Skip("requires real Nomic model")
	}

	engine := loadNomicEngine(t)
	ctx := context.Background()

	pairs := []struct {
		doc   string
		query string
	}{
		{
			doc:   "The eviction formula uses logarithmic frequency damping.",
			query: "how does the system decide which model to remove",
		},
		{
			doc:   "Compaction clusters session turns into summarized records.",
			query: "memory cleanup after a conversation ends",
		},
		{
			doc:   "Nomic embeddings support Matryoshka representation learning.",
			query: "truncated vectors for fast approximate search",
		},
	}

	tiers := []struct {
		label     string
		threshold float64
		selectVec func(MatryoshkaVec) []float32
	}{
		{
			label:     "L2 (256d)",
			threshold: 0.90,
			selectVec: func(v MatryoshkaVec) []float32 { return v.L2 },
		},
		{
			label:     "L1 (64d)",
			threshold: 0.70,
			selectVec: func(v MatryoshkaVec) []float32 { return v.L1 },
		},
	}

	for _, pair := range pairs {
		dFull, err := engine.EmbedDocumentM(ctx, pair.doc)
		if err != nil {
			t.Fatalf("EmbedDocumentM() error = %v", err)
		}
		qFull, err := engine.EmbedQueryM(ctx, pair.query)
		if err != nil {
			t.Fatalf("EmbedQueryM() error = %v", err)
		}

		simFull := cosineEval(dFull.L3, qFull.L3)
		for _, tier := range tiers {
			simTier := cosineEval(tier.selectVec(dFull), tier.selectVec(qFull))
			if math.Abs(simFull) < 0.05 {
				continue
			}

			ratio := simTier / simFull
			if ratio < tier.threshold {
				label := pair.doc
				if len(label) > 40 {
					label = label[:40]
				}
				t.Errorf("%s preservation below threshold for pair %q: full=%.4f tier=%.4f ratio=%.4f threshold=%.2f",
					tier.label, label, simFull, simTier, ratio, tier.threshold)
			}
		}
	}
}

func randomUnitVec(dims int) []float32 {
	rng := rand.New(rand.NewSource(42))
	vec := make([]float32, dims)
	var norm float64
	for i := range vec {
		value := rng.NormFloat64()
		vec[i] = float32(value)
		norm += value * value
	}
	norm = math.Sqrt(norm)
	scale := float32(norm)
	for i := range vec {
		vec[i] /= scale
	}
	return vec
}

func loadNomicEngine(t *testing.T) *Engine {
	t.Helper()

	runtimePath := strings.TrimSpace(os.Getenv("LIBRAVDB_EVAL_ONNX_RUNTIME"))
	modelDir := strings.TrimSpace(os.Getenv("LIBRAVDB_EVAL_NOMIC_DIR"))
	if runtimePath == "" || modelDir == "" {
		t.Skip("set LIBRAVDB_EVAL_ONNX_RUNTIME and LIBRAVDB_EVAL_NOMIC_DIR to run real Nomic Matryoshka tests")
	}

	engine := NewWithConfig(Config{
		Backend:     "onnx-local",
		Profile:     "nomic-embed-text-v1.5",
		RuntimePath: runtimePath,
		ModelPath:   modelDir,
	})
	if !engine.Ready() {
		t.Fatalf("engine not ready: %s", engine.Reason())
	}
	if !SupportsMatryoshka(engine) {
		t.Fatalf("expected Nomic engine to support Matryoshka")
	}
	return engine
}
