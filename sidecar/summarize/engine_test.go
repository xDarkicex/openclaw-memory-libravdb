package summarize

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/xDarkicex/openclaw-memory-libravdb/sidecar/embed"
)

type fakeEmbedder struct {
	vectors map[string][]float32
}

type fakeTokenizer struct{}

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
	return embed.Profile{
		Backend:    "test",
		Family:     "test",
		Dimensions: 2,
	}
}
func (f fakeEmbedder) Ready() bool     { return true }

func (f fakeTokenizer) Encode(text string) ([]int64, error) { return []int64{0, 1}, nil }
func (f fakeTokenizer) Decode(ids []int64) (string, error)  { return "decoded", nil }
func (f fakeTokenizer) VocabSize() int                      { return 32_128 }
func (f fakeTokenizer) BOS() int64                          { return 0 }
func (f fakeTokenizer) EOS() int64                          { return 1 }
func (f fakeTokenizer) PAD() int64                          { return 0 }

func TestNewWithConfigOllamaLocalRequiresEndpointAndModel(t *testing.T) {
	engine := NewWithConfig(Config{
		Backend: "ollama-local",
		Model:   "llama3",
	})
	if engine.Ready() {
		t.Fatalf("expected ollama-local without endpoint to be unavailable")
	}
	if engine.Mode() != "unavailable" {
		t.Fatalf("unexpected mode %q", engine.Mode())
	}
}

func TestNewExtractiveSummarizerComputesConfidenceFromCentroidSimilarity(t *testing.T) {
	engine := NewExtractive(fakeEmbedder{
		vectors: map[string][]float32{
			"a": {1, 0},
			"b": {0.9, 0.1},
			"c": {0, 1},
		},
	}, "extractive-test")

	summary, err := engine.Summarize(context.Background(), []Turn{
		{ID: "a", Text: "a"},
		{ID: "b", Text: "b"},
		{ID: "c", Text: "c"},
	}, SummaryOpts{
		MinInputTurns: 2,
		TargetDensity: 1.0 / 3.0,
	})
	if err != nil {
		t.Fatalf("Summarize() error = %v", err)
	}
	if summary.Method != "extractive" {
		t.Fatalf("unexpected method %q", summary.Method)
	}
	if len(summary.SourceIDs) != 1 || summary.SourceIDs[0] != "b" {
		t.Fatalf("unexpected source ids %#v", summary.SourceIDs)
	}
	if summary.Confidence <= 0 || summary.Confidence > 1 {
		t.Fatalf("expected confidence in (0,1], got %f", summary.Confidence)
	}
}

func TestNewExtractiveRequiresEmbedder(t *testing.T) {
	engine := NewExtractive(nil, "extractive")
	if engine.Ready() {
		t.Fatalf("expected nil-embedder extractive summarizer to be unavailable")
	}
}

func TestNewWithDepsONNXLocalLoadsManifestMetadata(t *testing.T) {
	dir := t.TempDir()
	manifest := `{
		"backend":"onnx-local",
		"profile":"t5-small",
		"family":"t5-small",
		"encoder":"encoder.onnx",
		"decoder":"decoder.onnx",
		"tokenizer":"tokenizer.json",
		"maxContextTokens":512
	}`
	if err := os.WriteFile(filepath.Join(dir, "summarizer.json"), []byte(manifest), 0o644); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}

	engine := NewWithDeps(Config{
		Backend:     "onnx-local",
		Profile:     "t5-small",
		RuntimePath: "/tmp/libonnxruntime.dylib",
		ModelPath:   dir,
	}, Dependencies{
		TokenizerLoader: func(path string) (Tokenizer, error) { return fakeTokenizer{}, nil },
	})

	if !engine.Ready() {
		t.Fatalf("expected onnx-local engine to be ready, reason=%q", engine.Reason())
	}
	if engine.Mode() != "onnx-local" {
		t.Fatalf("unexpected mode %q", engine.Mode())
	}
	if engine.Profile().Family != "t5-small" {
		t.Fatalf("unexpected family %q", engine.Profile().Family)
	}
	if engine.Profile().Fingerprint == "" {
		t.Fatalf("expected fingerprint to be populated")
	}
}

func TestNewWithDepsONNXLocalRequiresRuntime(t *testing.T) {
	engine := NewWithDeps(Config{
		Backend:   "onnx-local",
		ModelPath: t.TempDir(),
	}, Dependencies{
		TokenizerLoader: func(path string) (Tokenizer, error) { return fakeTokenizer{}, nil },
	})

	if engine.Ready() {
		t.Fatalf("expected onnx-local without runtime to be unavailable")
	}
}
