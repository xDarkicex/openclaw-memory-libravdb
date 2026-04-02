package config

import (
	"os"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
)

type Config struct {
	DBPath                  string
	RPCEndpoint             string
	ONNXRuntimePath         string
	EmbeddingBackend        string
	EmbeddingProfile        string
	FallbackProfile         string
	EmbeddingModelPath      string
	EmbeddingTokenizerPath  string
	EmbeddingDimensions     int
	EmbeddingNormalize      bool
	SummarizerBackend       string
	SummarizerProfile       string
	SummarizerRuntimePath   string
	SummarizerModelPath     string
	SummarizerTokenizerPath string
	SummarizerModel         string
	SummarizerEndpoint      string
	GatingW1c               float64
	GatingW2c               float64
	GatingW3c               float64
	GatingW1t               float64
	GatingW2t               float64
	GatingW3t               float64
	GatingTechNorm          float64
	GatingThreshold         float64
	GatingCentroidK         int
}

func FromEnv() Config {
	return Config{
		DBPath:                  envOrDefault("LIBRAVDB_DB_PATH", defaultDBPath()),
		RPCEndpoint:             envOrDefault("LIBRAVDB_RPC_ENDPOINT", defaultRPCEndpoint()),
		ONNXRuntimePath:         os.Getenv("LIBRAVDB_ONNX_RUNTIME"),
		EmbeddingBackend:        envOrDefault("LIBRAVDB_EMBEDDING_BACKEND", "bundled"),
		EmbeddingProfile:        envOrDefault("LIBRAVDB_EMBEDDING_PROFILE", "nomic-embed-text-v1.5"),
		FallbackProfile:         envOrDefault("LIBRAVDB_FALLBACK_PROFILE", "all-minilm-l6-v2"),
		EmbeddingModelPath:      os.Getenv("LIBRAVDB_EMBEDDING_MODEL"),
		EmbeddingTokenizerPath:  os.Getenv("LIBRAVDB_EMBEDDING_TOKENIZER"),
		EmbeddingDimensions:     envIntOrDefault("LIBRAVDB_EMBEDDING_DIMENSIONS", 0),
		EmbeddingNormalize:      envBoolOrDefault("LIBRAVDB_EMBEDDING_NORMALIZE", true),
		SummarizerBackend:       envOrDefault("LIBRAVDB_SUMMARIZER_BACKEND", "bundled"),
		SummarizerProfile:       strings.TrimSpace(os.Getenv("LIBRAVDB_SUMMARIZER_PROFILE")),
		SummarizerRuntimePath:   os.Getenv("LIBRAVDB_SUMMARIZER_RUNTIME"),
		SummarizerModelPath:     os.Getenv("LIBRAVDB_SUMMARIZER_MODEL_PATH"),
		SummarizerTokenizerPath: os.Getenv("LIBRAVDB_SUMMARIZER_TOKENIZER"),
		SummarizerModel:         os.Getenv("LIBRAVDB_SUMMARIZER_MODEL"),
		SummarizerEndpoint:      os.Getenv("LIBRAVDB_SUMMARIZER_ENDPOINT"),
		GatingW1c:               envFloatOrDefault("LIBRAVDB_GATING_W1C", 0.35),
		GatingW2c:               envFloatOrDefault("LIBRAVDB_GATING_W2C", 0.40),
		GatingW3c:               envFloatOrDefault("LIBRAVDB_GATING_W3C", 0.25),
		GatingW1t:               envFloatOrDefault("LIBRAVDB_GATING_W1T", 0.40),
		GatingW2t:               envFloatOrDefault("LIBRAVDB_GATING_W2T", 0.35),
		GatingW3t:               envFloatOrDefault("LIBRAVDB_GATING_W3T", 0.25),
		GatingTechNorm:          envFloatOrDefault("LIBRAVDB_GATING_TECH_NORM", 1.5),
		GatingThreshold:         envFloatOrDefault("LIBRAVDB_GATING_THRESHOLD", 0.35),
		GatingCentroidK:         envIntOrDefault("LIBRAVDB_GATING_CENTROID_K", 10),
	}
}

func defaultRPCEndpoint() string {
	homeDir, err := os.UserHomeDir()
	if err != nil || strings.TrimSpace(homeDir) == "" {
		if isWindows() {
			return "tcp:127.0.0.1:37421"
		}
		return "unix:./.clawdb/run/libravdb.sock"
	}
	if isWindows() {
		return "tcp:127.0.0.1:37421"
	}
	return "unix:" + filepath.Join(homeDir, ".clawdb", "run", "libravdb.sock")
}

func envOrDefault(key, fallback string) string {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	return value
}

func envIntOrDefault(key string, fallback int) int {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value <= 0 {
		return fallback
	}
	return value
}

func envBoolOrDefault(key string, fallback bool) bool {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	value, err := strconv.ParseBool(raw)
	if err != nil {
		return fallback
	}
	return value
}

func envFloatOrDefault(key string, fallback float64) float64 {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	value, err := strconv.ParseFloat(raw, 64)
	if err != nil {
		return fallback
	}
	return value
}

func defaultDBPath() string {
	currentUser, err := user.Current()
	if err != nil || strings.TrimSpace(currentUser.HomeDir) == "" {
		return "./libravdb-data.libravdb"
	}
	return filepath.Join(currentUser.HomeDir, ".clawdb", "data.libravdb")
}

func isWindows() bool {
	return os.PathSeparator == '\\'
}
