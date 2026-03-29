package embed

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/sugarme/tokenizer"
	"github.com/xDarkicex/openclaw-memory-libravdb/sidecar/model"
)

const defaultManifestName = "embedding.json"

type Profile struct {
	Backend     string `json:"backend"`
	Family      string `json:"family,omitempty"`
	Dimensions  int    `json:"dimensions"`
	Normalize   bool   `json:"normalize"`
	MaxContextTokens int `json:"maxContextTokens,omitempty"`
	ModelPath   string `json:"modelPath,omitempty"`
	Tokenizer   string `json:"tokenizerPath,omitempty"`
	Fingerprint string `json:"fingerprint"`
}

type embeddingManifest struct {
	Backend          string   `json:"backend,omitempty"`
	Profile          string   `json:"profile,omitempty"`
	Family           string   `json:"family,omitempty"`
	Model            string   `json:"model"`
	Tokenizer        string   `json:"tokenizer,omitempty"`
	Dimensions       int      `json:"dimensions"`
	Normalize        *bool    `json:"normalize,omitempty"`
	InputNames       []string `json:"inputNames,omitempty"`
	OutputName       string   `json:"outputName,omitempty"`
	AddSpecialTokens *bool    `json:"addSpecialTokens,omitempty"`
	Pooling          string   `json:"pooling,omitempty"`
}

type onnxLocalSpec struct {
	Backend          string
	Family           string
	RuntimePath      string
	ModelPath        string
	TokenizerPath    string
	Dimensions       int
	Normalize        bool
	InputNames       []string
	OutputName       string
	AddSpecialTokens bool
	Pooling          string
	Profile          Profile
}

type onnxLocalModel struct {
	encoder *model.EncoderModel
}

var newONNXLocalBackend = func(spec onnxLocalSpec) (embeddingBackend, error) {
	return newFileONNXBackend(spec)
}

func resolveONNXLocalSpec(cfg Config) (onnxLocalSpec, error) {
	manifestPath, err := resolveManifestPath(cfg.ModelPath)
	if err != nil {
		return onnxLocalSpec{}, err
	}

	manifest, err := readManifest(manifestPath)
	if err != nil {
		return onnxLocalSpec{}, err
	}
	selectedProfile, hasProfile := lookupProfile(firstNonEmpty(cfg.Profile, manifest.Profile))

	baseDir := filepath.Dir(manifestPath)
	modelPath := resolveManifestAsset(baseDir, cfg.modelAssetOverride(), manifest.Model)
	if modelPath == "" {
		return onnxLocalSpec{}, fmt.Errorf("onnx-local manifest missing model path")
	}

	tokenizerPath := resolveManifestAsset(baseDir, cfg.tokenizerAssetOverride(), manifest.Tokenizer)
	if tokenizerPath == "" {
		return onnxLocalSpec{}, fmt.Errorf("onnx-local manifest missing tokenizer path")
	}

	if cfg.Dimensions > 0 && manifest.Dimensions > 0 && cfg.Dimensions != manifest.Dimensions {
		return onnxLocalSpec{}, fmt.Errorf("onnx-local manifest dimensions %d do not match configured dimensions %d", manifest.Dimensions, cfg.Dimensions)
	}

	dimensions := manifest.Dimensions
	if dimensions <= 0 && hasProfile {
		dimensions = selectedProfile.Dimensions
	}
	if dimensions <= 0 {
		dimensions = cfg.Dimensions
	}
	if dimensions <= 0 {
		return onnxLocalSpec{}, fmt.Errorf("onnx-local dimensions must be configured in embedding.json or plugin config")
	}

	normalize := cfg.Normalize
	if manifest.Normalize != nil {
		normalize = *manifest.Normalize
	} else if hasProfile {
		normalize = selectedProfile.Normalize
	}

	inputNames := manifest.InputNames
	if len(inputNames) == 0 {
		inputNames = []string{"input_ids", "attention_mask", "token_type_ids"}
	}

	outputName := strings.TrimSpace(manifest.OutputName)
	if outputName == "" {
		outputName = "sentence_embedding"
	}

	addSpecialTokens := true
	if manifest.AddSpecialTokens != nil {
		addSpecialTokens = *manifest.AddSpecialTokens
	}
	pooling := strings.TrimSpace(manifest.Pooling)
	if pooling == "" && outputName == "last_hidden_state" {
		pooling = "mean"
	}

	profile := buildProfile(Profile{
		Backend:          "onnx-local",
		Family:           firstNonEmpty(strings.TrimSpace(manifest.Family), selectedProfile.Family, strings.TrimSpace(manifest.Backend), "onnx-local"),
		Dimensions:       dimensions,
		Normalize:        normalize,
		MaxContextTokens: selectedProfile.MaxContextTokens,
		ModelPath:        modelPath,
		Tokenizer:        tokenizerPath,
	})

	return onnxLocalSpec{
		Backend:          "onnx-local",
		Family:           profile.Family,
		RuntimePath:      strings.TrimSpace(cfg.RuntimePath),
		ModelPath:        modelPath,
		TokenizerPath:    tokenizerPath,
		Dimensions:       dimensions,
		Normalize:        normalize,
		InputNames:       append([]string(nil), inputNames...),
		OutputName:       outputName,
		AddSpecialTokens: addSpecialTokens,
		Pooling:          pooling,
		Profile:          profile,
	}, nil
}

func newFileONNXBackend(spec onnxLocalSpec) (embeddingBackend, error) {
	encoder, err := model.DefaultRegistry().LoadEncoder(model.EncoderSpec{
		Key: spec.Profile.Fingerprint,
		Profile: model.Profile{
			Name:          spec.Profile.Fingerprint,
			Family:        spec.Profile.Family,
			Task:          model.TaskEmbedding,
			Dims:          spec.Dimensions,
			Normalize:     spec.Normalize,
			ModelPath:     spec.ModelPath,
			TokenizerPath: spec.TokenizerPath,
			OrtLibPath:    spec.RuntimePath,
		},
		RuntimePath:      spec.RuntimePath,
		ModelPath:        spec.ModelPath,
		TokenizerPath:    spec.TokenizerPath,
		InputNames:       spec.InputNames,
		OutputName:       spec.OutputName,
		Dimensions:       spec.Dimensions,
		AddSpecialTokens: spec.AddSpecialTokens,
		Pooling:          spec.Pooling,
	})
	if err != nil {
		return nil, err
	}

	return miniLMBackend{
		model: onnxLocalModel{
			encoder: encoder,
		},
		normalize: spec.Normalize,
	}, nil
}

func (m onnxLocalModel) Compute(sentence string, _ bool) ([]float32, error) {
	if m.encoder == nil {
		return nil, fmt.Errorf("encoder model not loaded")
	}
	return m.encoder.EmbedText(sentence)
}

func (m onnxLocalModel) TokenCount(sentence string, _ bool) (int, error) {
	if m.encoder == nil {
		return 0, fmt.Errorf("encoder model not loaded")
	}
	return m.encoder.TokenCount(sentence)
}

func (m onnxLocalModel) Encode(sentence string, _ bool) (*tokenizer.Encoding, error) {
	if m.encoder == nil {
		return nil, fmt.Errorf("encoder model not loaded")
	}
	return m.encoder.EncodeText(sentence, true)
}

func (m onnxLocalModel) ComputeEncoding(encoding tokenizer.Encoding) ([]float32, error) {
	if m.encoder == nil {
		return nil, fmt.Errorf("encoder model not loaded")
	}
	return m.encoder.EmbedEncoding(encoding)
}

func meanPoolLastHiddenState(flat []float32, attentionMask []int, seqLength int, dimensions int) []float32 {
	vec := make([]float32, dimensions)
	var denom float32
	for tokenIdx := 0; tokenIdx < seqLength; tokenIdx++ {
		if tokenIdx >= len(attentionMask) || attentionMask[tokenIdx] == 0 {
			continue
		}
		denom++
		base := tokenIdx * dimensions
		for dim := 0; dim < dimensions; dim++ {
			vec[dim] += flat[base+dim]
		}
	}
	if denom == 0 {
		return vec
	}
	for dim := range vec {
		vec[dim] /= denom
	}
	return vec
}

func resolveManifestPath(modelPath string) (string, error) {
	raw := strings.TrimSpace(modelPath)
	if raw == "" {
		return "", fmt.Errorf("onnx-local requires embeddingModelPath pointing to a model directory or embedding.json")
	}

	info, err := os.Stat(raw)
	if err == nil && info.IsDir() {
		return filepath.Join(raw, defaultManifestName), nil
	}
	if err == nil && strings.EqualFold(filepath.Base(raw), defaultManifestName) {
		return raw, nil
	}
	if err == nil {
		return filepath.Join(filepath.Dir(raw), defaultManifestName), nil
	}
	return "", err
}

func readManifest(path string) (embeddingManifest, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return embeddingManifest{}, fmt.Errorf("failed to read %s: %w", path, err)
	}
	var manifest embeddingManifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		return embeddingManifest{}, fmt.Errorf("failed to parse %s: %w", path, err)
	}
	return manifest, nil
}

func resolveManifestAsset(baseDir string, values ...string) string {
	asset := firstNonEmpty(values...)
	if asset == "" {
		return ""
	}
	if filepath.IsAbs(asset) {
		return asset
	}
	return filepath.Join(baseDir, asset)
}

func buildProfile(profile Profile) Profile {
	hash := sha256.Sum256([]byte(strings.Join([]string{
		profile.Backend,
		profile.Family,
		fmt.Sprintf("%d", profile.Dimensions),
		fmt.Sprintf("%t", profile.Normalize),
		fmt.Sprintf("%d", profile.MaxContextTokens),
		profile.ModelPath,
		profile.Tokenizer,
	}, "\x00")))
	profile.Fingerprint = hex.EncodeToString(hash[:])
	return profile
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value != "" {
			return value
		}
	}
	return ""
}

func (cfg Config) modelAssetOverride() string {
	modelPath := strings.TrimSpace(cfg.ModelPath)
	if strings.EqualFold(filepath.Base(modelPath), defaultManifestName) {
		return ""
	}
	if strings.HasSuffix(strings.ToLower(modelPath), ".onnx") {
		return modelPath
	}
	return ""
}

func (cfg Config) tokenizerAssetOverride() string {
	return strings.TrimSpace(cfg.TokenizerPath)
}
