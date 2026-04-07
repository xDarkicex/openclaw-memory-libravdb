package embed

import (
	"context"
	"errors"
	"testing"

	"github.com/sugarme/tokenizer"
)

type fakeMiniLMModel struct {
	vector []float32
	err    error
}

func (m fakeMiniLMModel) Compute(_ string, _ bool) ([]float32, error) {
	if m.err != nil {
		return nil, m.err
	}
	return append([]float32(nil), m.vector...), nil
}

func (m fakeMiniLMModel) TokenCount(_ string, _ bool) (int, error) {
	if m.err != nil {
		return 0, m.err
	}
	return 4, nil
}

func (m fakeMiniLMModel) Encode(_ string, _ bool) (*tokenizer.Encoding, error) {
	if m.err != nil {
		return nil, m.err
	}
	return &tokenizer.Encoding{
		Ids:           []int{1, 2, 3, 4},
		TypeIds:       []int{0, 0, 0, 0},
		AttentionMask: []int{1, 1, 1, 1},
		Tokens:        []string{"a", "b", "c", "d"},
		Offsets:       [][]int{{0, 1}, {1, 2}, {2, 3}, {3, 4}},
		Words:         []int{0, 1, 2, 3},
	}, nil
}

func (m fakeMiniLMModel) ComputeEncoding(_ tokenizer.Encoding) ([]float32, error) {
	return m.Compute("", true)
}

type countingMiniLMModel struct {
	encodeEncoding tokenizer.Encoding
	vector         []float32
	encodeCalls    int
	computeCalls   int
}

func (m *countingMiniLMModel) Compute(_ string, _ bool) ([]float32, error) {
	m.computeCalls++
	return append([]float32(nil), m.vector...), nil
}

func (m *countingMiniLMModel) TokenCount(_ string, _ bool) (int, error) {
	return len(m.encodeEncoding.Ids), nil
}

func (m *countingMiniLMModel) Encode(_ string, _ bool) (*tokenizer.Encoding, error) {
	m.encodeCalls++
	encoding := m.encodeEncoding
	return &encoding, nil
}

func (m *countingMiniLMModel) ComputeEncoding(_ tokenizer.Encoding) ([]float32, error) {
	m.computeCalls++
	return append([]float32(nil), m.vector...), nil
}

func TestNewUnavailableIsNotReady(t *testing.T) {
	engine := NewUnavailable("missing runtime")
	if engine.Ready() {
		t.Fatalf("expected unavailable engine to be not ready")
	}
	if engine.Dimensions() != DefaultDimensions {
		t.Fatalf("expected dimensions %d, got %d", DefaultDimensions, engine.Dimensions())
	}
}

func TestNewPrimaryRequiresRuntimePath(t *testing.T) {
	originalResolver := resolveBundledSpec
	originalFactory := newONNXLocalBackend
	t.Cleanup(func() {
		resolveBundledSpec = originalResolver
		newONNXLocalBackend = originalFactory
	})

	resolveBundledSpec = func(cfg Config) (onnxLocalSpec, error) {
		return onnxLocalSpec{}, errors.New("missing bundled runtime")
	}
	engine := NewPrimary("")
	if !engine.Ready() {
		t.Fatalf("expected missing runtime path to fall back to a ready local embedder")
	}
	if engine.Mode() != "fallback" {
		t.Fatalf("expected fallback mode, got %q", engine.Mode())
	}

	resolveBundledSpec = func(cfg Config) (onnxLocalSpec, error) {
		if cfg.RuntimePath != "/tmp/libonnxruntime.dylib" {
			t.Fatalf("unexpected runtime path %q", cfg.RuntimePath)
		}
		if cfg.Profile != DefaultEmbeddingProfile {
			t.Fatalf("expected default profile %q, got %q", DefaultEmbeddingProfile, cfg.Profile)
		}
		return onnxLocalSpec{RuntimePath: cfg.RuntimePath, Dimensions: 768, Normalize: true, Profile: buildProfile(Profile{
			Backend:    "bundled",
			Family:     DefaultEmbeddingProfile,
			Dimensions: 768,
			Normalize:  true,
		})}, nil
	}
	newONNXLocalBackend = func(spec onnxLocalSpec) (embeddingBackend, error) {
		return fakeONNXLocalBackend{vector: make([]float32, 768)}, nil
	}
	engine = NewPrimary("/tmp/libonnxruntime.dylib")
	if !engine.Ready() {
		t.Fatalf("expected non-empty runtime path to mark engine ready")
	}
	if engine.Mode() != "primary" {
		t.Fatalf("expected primary mode, got %q", engine.Mode())
	}
	if engine.Dimensions() != 768 {
		t.Fatalf("expected dimensions 768, got %d", engine.Dimensions())
	}
}

func TestBundledBackendUsesRealModelFactory(t *testing.T) {
	originalResolver := resolveBundledSpec
	originalFactory := newONNXLocalBackend
	t.Cleanup(func() {
		resolveBundledSpec = originalResolver
		newONNXLocalBackend = originalFactory
	})

	resolveBundledSpec = func(cfg Config) (onnxLocalSpec, error) {
		return onnxLocalSpec{
			RuntimePath: cfg.RuntimePath,
			Dimensions:  384,
			Normalize:   true,
			Profile: buildProfile(Profile{
				Backend:    "bundled",
				Family:     "all-minilm-l6-v2",
				Dimensions: 384,
				Normalize:  true,
			}),
		}, nil
	}
	newONNXLocalBackend = func(spec onnxLocalSpec) (embeddingBackend, error) {
		if spec.RuntimePath != "/opt/onnx/libonnxruntime.so" {
			t.Fatalf("unexpected runtime path %q", spec.RuntimePath)
		}
		vec := make([]float32, 384)
		vec[0] = 3
		vec[1] = 4
		return miniLMBackend{
			model:     fakeMiniLMModel{vector: vec},
			normalize: spec.Normalize,
		}, nil
	}

	engine := NewWithConfig(Config{
		Backend:     "bundled",
		RuntimePath: "/opt/onnx/libonnxruntime.so",
		Dimensions:  384,
		Normalize:   true,
	})
	if !engine.Ready() {
		t.Fatalf("expected bundled engine to be ready")
	}
	if engine.Mode() != "primary" {
		t.Fatalf("expected primary mode, got %q", engine.Mode())
	}

	vec, err := engine.EmbedDocument(context.Background(), "hello")
	if err != nil {
		t.Fatalf("EmbedDocument() error = %v", err)
	}
	if len(vec) != 384 {
		t.Fatalf("expected 384 dimensions, got %d", len(vec))
	}
	if vec[0] == 3 || vec[1] == 4 {
		t.Fatalf("expected normalized output from bundled backend")
	}
}

func TestNewWithConfigSupportsPowerUserSeam(t *testing.T) {
	engine := NewWithConfig(Config{
		Backend:    "custom-local",
		ModelPath:  "/models/custom.onnx",
		Dimensions: 768,
		Normalize:  true,
	})
	if !engine.Ready() {
		t.Fatalf("expected custom-local engine to be ready")
	}
	if engine.Mode() != "custom-local" {
		t.Fatalf("expected custom-local mode, got %q", engine.Mode())
	}
	if engine.Dimensions() != 768 {
		t.Fatalf("expected dimensions 768, got %d", engine.Dimensions())
	}

	fallback := NewWithConfig(Config{
		Backend:    "custom-local",
		Dimensions: 512,
	})
	if fallback.Mode() != "fallback" {
		t.Fatalf("expected missing model path to fall back, got %q", fallback.Mode())
	}
	if fallback.Dimensions() != 512 {
		t.Fatalf("expected fallback dimensions 512, got %d", fallback.Dimensions())
	}

	unavailable := NewWithConfig(Config{
		Backend:    "made-up-backend",
		Dimensions: 256,
	})
	if unavailable.Ready() {
		t.Fatalf("expected unsupported backend to be unavailable")
	}
}

func TestEmbedDeterministic384Dimensions(t *testing.T) {
	engine := NewFallback("test fallback")
	first, err := engine.EmbedDocument(context.Background(), "remember the red book")
	if err != nil {
		t.Fatalf("EmbedDocument(first) error = %v", err)
	}
	second, err := engine.EmbedDocument(context.Background(), "remember the red book")
	if err != nil {
		t.Fatalf("EmbedDocument(second) error = %v", err)
	}
	other, err := engine.EmbedDocument(context.Background(), "different text entirely")
	if err != nil {
		t.Fatalf("EmbedDocument(other) error = %v", err)
	}

	if len(first) != DefaultDimensions {
		t.Fatalf("expected %d dimensions, got %d", DefaultDimensions, len(first))
	}
	if len(second) != DefaultDimensions || len(other) != DefaultDimensions {
		t.Fatalf("expected stable %d-dimensional output", DefaultDimensions)
	}
	for i := range first {
		if first[i] != second[i] {
			t.Fatalf("expected deterministic embedding at index %d", i)
		}
	}

	var differs bool
	for i := range first {
		if first[i] != other[i] {
			differs = true
			break
		}
	}
	if !differs {
		t.Fatalf("expected different text to change the embedding")
	}
}

func TestEmbedLongDocumentUsesSafeSlidingWindows(t *testing.T) {
	model := &countingMiniLMModel{
		encodeEncoding: tokenizer.Encoding{
			Ids:           make([]int, 513),
			TypeIds:       make([]int, 513),
			AttentionMask: make([]int, 513),
			Tokens:        make([]string, 513),
			Offsets:       make([][]int, 513),
			Words:         make([]int, 513),
		},
		vector: make([]float32, 768),
	}
	for i := range model.encodeEncoding.Ids {
		model.encodeEncoding.Ids[i] = i + 1
		model.encodeEncoding.AttentionMask[i] = 1
		model.encodeEncoding.Tokens[i] = "t"
		model.encodeEncoding.Offsets[i] = []int{i, i + 1}
		model.encodeEncoding.Words[i] = i
	}
	model.vector[0] = 1

	engine := &Engine{
		dimensions: 768,
		ready:      true,
		backend: miniLMBackend{
			model:     model,
			normalize: true,
		},
		profile: buildProfile(Profile{
			Backend:          "bundled",
			Family:           "nomic-embed-text-v1.5",
			Dimensions:       768,
			Normalize:        true,
			MaxContextTokens: 0,
		}),
	}

	vec, ok, err := engine.embedLongDocument("long input")
	if err != nil {
		t.Fatalf("embedLongDocument() error = %v", err)
	}
	if !ok {
		t.Fatalf("expected long-document path to be used")
	}
	if len(vec) != 768 {
		t.Fatalf("expected 768-dim vector, got %d", len(vec))
	}
	if model.computeCalls < 2 {
		t.Fatalf("expected multiple window embeddings, got %d", model.computeCalls)
	}
}

func TestBundledFallsBackToConfiguredFallbackProfile(t *testing.T) {
	originalResolver := resolveBundledSpec
	originalFactory := newONNXLocalBackend
	t.Cleanup(func() {
		resolveBundledSpec = originalResolver
		newONNXLocalBackend = originalFactory
	})

	resolveCalls := make([]string, 0, 2)
	resolveBundledSpec = func(cfg Config) (onnxLocalSpec, error) {
		resolveCalls = append(resolveCalls, cfg.Profile)
		if cfg.Profile == DefaultEmbeddingProfile {
			return onnxLocalSpec{}, errors.New("primary profile unavailable")
		}
		return onnxLocalSpec{
			RuntimePath: cfg.RuntimePath,
			Dimensions:  384,
			Normalize:   true,
			Profile: buildProfile(Profile{
				Backend:    "bundled",
				Family:     FallbackEmbeddingProfile,
				Dimensions: 384,
				Normalize:  true,
			}),
		}, nil
	}
	newONNXLocalBackend = func(spec onnxLocalSpec) (embeddingBackend, error) {
		return fakeONNXLocalBackend{vector: make([]float32, spec.Dimensions)}, nil
	}

	engine := NewWithConfig(Config{
		Backend:         "bundled",
		Profile:         DefaultEmbeddingProfile,
		FallbackProfile: FallbackEmbeddingProfile,
		RuntimePath:     "/opt/onnx/libonnxruntime.so",
	})
	if !engine.Ready() {
		t.Fatalf("expected bundled engine to be ready via fallback profile")
	}
	if engine.Profile().Family != FallbackEmbeddingProfile {
		t.Fatalf("expected fallback family %q, got %q", FallbackEmbeddingProfile, engine.Profile().Family)
	}
	if len(resolveCalls) != 2 || resolveCalls[0] != DefaultEmbeddingProfile || resolveCalls[1] != FallbackEmbeddingProfile {
		t.Fatalf("unexpected resolve order %v", resolveCalls)
	}
}

func TestNomicUsesAsymmetricDocumentAndQueryPrefixes(t *testing.T) {
	originalResolver := resolveBundledSpec
	originalFactory := newONNXLocalBackend
	t.Cleanup(func() {
		resolveBundledSpec = originalResolver
		newONNXLocalBackend = originalFactory
	})

	resolveBundledSpec = func(cfg Config) (onnxLocalSpec, error) {
		return onnxLocalSpec{
			Family:     "nomic-embed-text-v1.5",
			Dimensions: 768,
			Normalize:  true,
			Profile: buildProfile(Profile{
				Backend:    "onnx-local",
				Family:     "nomic-embed-text-v1.5",
				Dimensions: 768,
				Normalize:  true,
			}),
		}, nil
	}

	var calls []string
	newONNXLocalBackend = func(spec onnxLocalSpec) (embeddingBackend, error) {
		return deterministicRecorderBackend{calls: &calls}, nil
	}

	engine := NewWithConfig(Config{
		Backend:     "bundled",
		Profile:     "nomic-embed-text-v1.5",
		RuntimePath: "/opt/onnx/libonnxruntime.so",
	})
	if !engine.Ready() {
		t.Fatalf("expected nomic engine to be ready")
	}

	if _, err := engine.EmbedDocument(context.Background(), "project note"); err != nil {
		t.Fatalf("EmbedDocument() error = %v", err)
	}
	if _, err := engine.EmbedQuery(context.Background(), "project note"); err != nil {
		t.Fatalf("EmbedQuery() error = %v", err)
	}

	if len(calls) != 3 {
		t.Fatalf("expected 3 backend calls including dimension probe, got %d", len(calls))
	}
	if calls[1] != "search_document: project note" {
		t.Fatalf("unexpected document prefix call %q", calls[1])
	}
	if calls[2] != "search_query: project note" {
		t.Fatalf("unexpected query prefix call %q", calls[2])
	}
}

type deterministicRecorderBackend struct {
	calls *[]string
}

func (b deterministicRecorderBackend) Embed(text string, dimensions int) ([]float32, error) {
	*b.calls = append(*b.calls, text)
	return make([]float32, dimensions), nil
}
