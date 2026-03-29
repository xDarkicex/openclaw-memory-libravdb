package embed

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type fakeONNXLocalBackend struct {
	vector []float32
}

func (b fakeONNXLocalBackend) Embed(_ string, dimensions int) ([]float32, error) {
	if len(b.vector) != dimensions {
		return nil, nil
	}
	return append([]float32(nil), b.vector...), nil
}

func TestONNXLocalLoadsManifestDirectory(t *testing.T) {
	dir := t.TempDir()
	err := os.WriteFile(filepath.Join(dir, "embedding.json"), []byte(`{
		"backend":"onnx-local",
		"profile":"nomic-embed-text-v1.5",
		"family":"nomic-embed-text-v1.5",
		"model":"model.onnx",
		"tokenizer":"tokenizer.json",
		"dimensions":768,
		"normalize":true,
		"inputNames":["input_ids","attention_mask"],
		"outputName":"sentence_embedding"
	}`), 0o644)
	if err != nil {
		t.Fatalf("write manifest: %v", err)
	}

	original := newONNXLocalBackend
	t.Cleanup(func() { newONNXLocalBackend = original })
	newONNXLocalBackend = func(spec onnxLocalSpec) (embeddingBackend, error) {
		if spec.Family != "nomic-embed-text-v1.5" {
			t.Fatalf("unexpected family %q", spec.Family)
		}
		if !strings.HasSuffix(spec.ModelPath, "model.onnx") {
			t.Fatalf("unexpected model path %q", spec.ModelPath)
		}
		if !strings.HasSuffix(spec.TokenizerPath, "tokenizer.json") {
			t.Fatalf("unexpected tokenizer path %q", spec.TokenizerPath)
		}
		if spec.Dimensions != 768 {
			t.Fatalf("unexpected dimensions %d", spec.Dimensions)
		}
		if len(spec.InputNames) != 2 {
			t.Fatalf("unexpected input names %#v", spec.InputNames)
		}
		if spec.RuntimePath != "/opt/onnx/libonnxruntime.so" {
			t.Fatalf("unexpected runtime path %q", spec.RuntimePath)
		}
		return fakeONNXLocalBackend{vector: make([]float32, 768)}, nil
	}

	engine := NewWithConfig(Config{
		Backend:     "onnx-local",
		RuntimePath: "/opt/onnx/libonnxruntime.so",
		ModelPath:   dir,
		Normalize:   true,
	})
	if !engine.Ready() {
		t.Fatalf("expected onnx-local engine to be ready, reason=%q", engine.Reason())
	}
	if engine.Mode() != "onnx-local" {
		t.Fatalf("unexpected mode %q", engine.Mode())
	}
	if engine.Dimensions() != 768 {
		t.Fatalf("expected manifest dimensions 768, got %d", engine.Dimensions())
	}
	if engine.Profile().Fingerprint == "" {
		t.Fatalf("expected embedding fingerprint")
	}
}

func TestONNXLocalRejectsManifestDimensionMismatch(t *testing.T) {
	dir := t.TempDir()
	err := os.WriteFile(filepath.Join(dir, "embedding.json"), []byte(`{
		"model":"model.onnx",
		"tokenizer":"tokenizer.json",
		"dimensions":768
	}`), 0o644)
	if err != nil {
		t.Fatalf("write manifest: %v", err)
	}

	original := newONNXLocalBackend
	t.Cleanup(func() { newONNXLocalBackend = original })
	newONNXLocalBackend = func(spec onnxLocalSpec) (embeddingBackend, error) {
		return fakeONNXLocalBackend{vector: make([]float32, spec.Dimensions)}, nil
	}

	engine := NewWithConfig(Config{
		Backend:     "onnx-local",
		RuntimePath: "/opt/onnx/libonnxruntime.so",
		ModelPath:   dir,
		Dimensions:  384,
	})
	if engine.Ready() {
		t.Fatalf("expected mismatched dimensions to fail readiness")
	}
}

func TestONNXLocalCanUseShippedProfileDefaults(t *testing.T) {
	dir := t.TempDir()
	err := os.WriteFile(filepath.Join(dir, "embedding.json"), []byte(`{
		"profile":"nomic-embed-text-v1.5",
		"model":"model.onnx",
		"tokenizer":"tokenizer.json"
	}`), 0o644)
	if err != nil {
		t.Fatalf("write manifest: %v", err)
	}

	original := newONNXLocalBackend
	t.Cleanup(func() { newONNXLocalBackend = original })
	newONNXLocalBackend = func(spec onnxLocalSpec) (embeddingBackend, error) {
		if spec.Dimensions != 768 {
			t.Fatalf("expected profile dimensions 768, got %d", spec.Dimensions)
		}
		if spec.Family != "nomic-embed-text-v1.5" {
			t.Fatalf("expected profile family, got %q", spec.Family)
		}
		return fakeONNXLocalBackend{vector: make([]float32, 768)}, nil
	}

	engine := NewWithConfig(Config{
		Backend:     "onnx-local",
		RuntimePath: "/opt/onnx/libonnxruntime.so",
		ModelPath:   dir,
	})
	if !engine.Ready() {
		t.Fatalf("expected profile-backed onnx-local engine to be ready, reason=%q", engine.Reason())
	}
}

func TestMeanPoolLastHiddenStateUsesAttentionMask(t *testing.T) {
	flat := []float32{
		1, 2,
		3, 4,
		100, 200,
	}
	mask := []int{1, 1, 0}

	got := meanPoolLastHiddenState(flat, mask, 3, 2)

	if len(got) != 2 {
		t.Fatalf("unexpected pooled vector length %d", len(got))
	}
	if got[0] != 2 || got[1] != 3 {
		t.Fatalf("unexpected pooled vector %#v", got)
	}
}
