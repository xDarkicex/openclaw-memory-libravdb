package summarize

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestDecodeIsDeterministic(t *testing.T) {
	modelDir := filepath.Clean(filepath.Join("..", "..", ".models", "t5-small"))
	runtimePath := filepath.Clean(filepath.Join("..", "..", ".models", "onnxruntime", "onnxruntime-osx-arm64-1.23.0", "lib", "libonnxruntime.dylib"))

	if _, err := os.Stat(filepath.Join(modelDir, "summarizer.json")); os.IsNotExist(err) {
		t.Skip("t5 summarizer model not present")
	}
	if _, err := os.Stat(runtimePath); os.IsNotExist(err) {
		t.Skip("onnx runtime not present")
	}

	engine := NewWithDeps(Config{
		Backend:     "onnx-local",
		Profile:     "t5-small",
		RuntimePath: runtimePath,
		ModelPath:   modelDir,
	}, Dependencies{})

	input := []Turn{
		{ID: "turn-1", Text: "The tower is 324 metres tall and located in Paris."},
	}
	opts := SummaryOpts{MinInputTurns: 1, MaxOutputTokens: 32}

	r1, err := engine.Summarize(context.Background(), input, opts)
	if err != nil {
		t.Fatal(err)
	}
	r2, err := engine.Summarize(context.Background(), input, opts)
	if err != nil {
		t.Fatal(err)
	}

	if r1.Text != r2.Text {
		t.Fatalf("non-deterministic output:\n  run1: %q\n  run2: %q", r1.Text, r2.Text)
	}
	if r1.Confidence != r2.Confidence {
		t.Fatalf("non-deterministic confidence: %f vs %f", r1.Confidence, r2.Confidence)
	}
}
