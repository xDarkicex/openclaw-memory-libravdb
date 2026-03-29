package config

import "testing"

func TestFromEnvDefaults(t *testing.T) {
	t.Setenv("LIBRAVDB_DB_PATH", "")
	t.Setenv("LIBRAVDB_ONNX_RUNTIME", "")
	t.Setenv("LIBRAVDB_EMBEDDING_BACKEND", "")
	t.Setenv("LIBRAVDB_EMBEDDING_PROFILE", "")
	t.Setenv("LIBRAVDB_EMBEDDING_MODEL", "")
	t.Setenv("LIBRAVDB_EMBEDDING_TOKENIZER", "")
	t.Setenv("LIBRAVDB_EMBEDDING_DIMENSIONS", "")
	t.Setenv("LIBRAVDB_EMBEDDING_NORMALIZE", "")

	cfg := FromEnv()
	if cfg.DBPath == "" {
		t.Fatalf("expected non-empty default db path")
	}
	if cfg.EmbeddingBackend != "bundled" {
		t.Fatalf("expected bundled backend, got %q", cfg.EmbeddingBackend)
	}
	if cfg.EmbeddingProfile != "nomic-embed-text-v1.5" {
		t.Fatalf("expected Nomic default profile, got %q", cfg.EmbeddingProfile)
	}
	if cfg.FallbackProfile != "all-minilm-l6-v2" {
		t.Fatalf("expected MiniLM fallback profile, got %q", cfg.FallbackProfile)
	}
	if cfg.EmbeddingDimensions != 0 {
		t.Fatalf("expected unspecified dimensions to default to 0, got %d", cfg.EmbeddingDimensions)
	}
	if !cfg.EmbeddingNormalize {
		t.Fatalf("expected normalize=true by default")
	}
}

func TestFromEnvReadsPowerUserEmbeddingSettings(t *testing.T) {
	t.Setenv("LIBRAVDB_DB_PATH", "/tmp/libravdb")
	t.Setenv("LIBRAVDB_ONNX_RUNTIME", "/opt/onnx/libonnxruntime.so")
	t.Setenv("LIBRAVDB_EMBEDDING_BACKEND", "custom-local")
	t.Setenv("LIBRAVDB_EMBEDDING_PROFILE", "nomic-embed-text-v1.5")
	t.Setenv("LIBRAVDB_FALLBACK_PROFILE", "all-minilm-l6-v2")
	t.Setenv("LIBRAVDB_EMBEDDING_MODEL", "/models/custom.onnx")
	t.Setenv("LIBRAVDB_EMBEDDING_TOKENIZER", "/models/tokenizer.json")
	t.Setenv("LIBRAVDB_EMBEDDING_DIMENSIONS", "768")
	t.Setenv("LIBRAVDB_EMBEDDING_NORMALIZE", "false")

	cfg := FromEnv()
	if cfg.DBPath != "/tmp/libravdb" {
		t.Fatalf("unexpected db path %q", cfg.DBPath)
	}
	if cfg.ONNXRuntimePath != "/opt/onnx/libonnxruntime.so" {
		t.Fatalf("unexpected runtime path %q", cfg.ONNXRuntimePath)
	}
	if cfg.EmbeddingBackend != "custom-local" {
		t.Fatalf("unexpected backend %q", cfg.EmbeddingBackend)
	}
	if cfg.EmbeddingProfile != "nomic-embed-text-v1.5" {
		t.Fatalf("unexpected profile %q", cfg.EmbeddingProfile)
	}
	if cfg.FallbackProfile != "all-minilm-l6-v2" {
		t.Fatalf("unexpected fallback profile %q", cfg.FallbackProfile)
	}
	if cfg.EmbeddingModelPath != "/models/custom.onnx" {
		t.Fatalf("unexpected model path %q", cfg.EmbeddingModelPath)
	}
	if cfg.EmbeddingTokenizerPath != "/models/tokenizer.json" {
		t.Fatalf("unexpected tokenizer path %q", cfg.EmbeddingTokenizerPath)
	}
	if cfg.EmbeddingDimensions != 768 {
		t.Fatalf("unexpected dimensions %d", cfg.EmbeddingDimensions)
	}
	if cfg.EmbeddingNormalize {
		t.Fatalf("expected normalize=false")
	}
}
