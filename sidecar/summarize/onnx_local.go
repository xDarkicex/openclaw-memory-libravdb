package summarize

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/xDarkicex/openclaw-memory-libravdb/sidecar/model"
	ort "github.com/yalue/onnxruntime_go"
)

const defaultManifestName = "summarizer.json"

const (
	t5SmallHiddenDim = 512
	t5SmallVocabSize = 32128

	t5EncoderInputIDs    = "input_ids"
	t5EncoderAttnMask    = "attention_mask"
	t5EncoderHiddenState = "last_hidden_state"

	t5DecoderInputIDs      = "input_ids"
	t5DecoderEncoderHidden = "encoder_hidden_states"
	t5DecoderEncoderMask   = "encoder_attention_mask"
	t5DecoderLogits        = "logits"
)

// --- ONNX Graph Record ---
// Model:    encoder_model.onnx
// Inspected: 2026-03-28 22:23:28 PDT
//
// INPUTS:
//   input_ids                                ONNX_TENSOR_ELEMENT_DATA_TYPE_INT64 [-1 -1]
//   attention_mask                           ONNX_TENSOR_ELEMENT_DATA_TYPE_INT64 [-1 -1]
//
// OUTPUTS:
//   last_hidden_state                        ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT [-1 -1 512]
// -------------------------
//
// --- ONNX Graph Record ---
// Model:    decoder_model.onnx
// Inspected: 2026-03-28 22:23:29 PDT
//
// INPUTS:
//   encoder_attention_mask                   ONNX_TENSOR_ELEMENT_DATA_TYPE_INT64 [-1 -1]
//   input_ids                                ONNX_TENSOR_ELEMENT_DATA_TYPE_INT64 [-1 -1]
//   encoder_hidden_states                    ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT [-1 -1 512]
//
// OUTPUTS:
//   logits                                   ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT [-1 -1 32128]
//   present.0.decoder.key                    ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT [-1 -1 -1 -1]
//   present.0.decoder.value                  ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT [-1 -1 -1 -1]
//   present.0.encoder.key                    ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT [-1 -1 -1 -1]
//   present.0.encoder.value                  ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT [-1 -1 -1 -1]
//   present.1.decoder.key                    ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT [-1 -1 -1 -1]
//   present.1.decoder.value                  ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT [-1 -1 -1 -1]
//   present.1.encoder.key                    ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT [-1 -1 -1 -1]
//   present.1.encoder.value                  ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT [-1 -1 -1 -1]
//   present.2.decoder.key                    ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT [-1 -1 -1 -1]
//   present.2.decoder.value                  ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT [-1 -1 -1 -1]
//   present.2.encoder.key                    ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT [-1 -1 -1 -1]
//   present.2.encoder.value                  ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT [-1 -1 -1 -1]
//   present.3.decoder.key                    ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT [-1 -1 -1 -1]
//   present.3.decoder.value                  ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT [-1 -1 -1 -1]
//   present.3.encoder.key                    ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT [-1 -1 -1 -1]
//   present.3.encoder.value                  ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT [-1 -1 -1 -1]
//   present.4.decoder.key                    ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT [-1 -1 -1 -1]
//   present.4.decoder.value                  ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT [-1 -1 -1 -1]
//   present.4.encoder.key                    ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT [-1 -1 -1 -1]
//   present.4.encoder.value                  ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT [-1 -1 -1 -1]
//   present.5.decoder.key                    ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT [-1 -1 -1 -1]
//   present.5.decoder.value                  ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT [-1 -1 -1 -1]
//   present.5.encoder.key                    ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT [-1 -1 -1 -1]
//   present.5.encoder.value                  ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT [-1 -1 -1 -1]
//   encoder_last_hidden_state                ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT [-1 -1 512]
// -------------------------

type summaryManifest struct {
	Backend          string `json:"backend,omitempty"`
	Profile          string `json:"profile,omitempty"`
	Family           string `json:"family,omitempty"`
	Model            string `json:"model,omitempty"`
	Encoder          string `json:"encoder,omitempty"`
	Decoder          string `json:"decoder,omitempty"`
	Tokenizer        string `json:"tokenizer,omitempty"`
	MaxContextTokens int    `json:"maxContextTokens,omitempty"`
}

type onnxLocalSpec struct {
	RuntimePath      string
	ModelPath        string
	EncoderPath      string
	DecoderPath      string
	TokenizerPath    string
	MaxContextTokens int
	Profile          Profile
}

type onnxLocalBackend struct {
	mu       sync.Mutex
	registry *model.Registry
	spec     onnxLocalSpec
	tok      Tokenizer
	loaded   *model.Seq2SeqModel
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
	modelPath := resolveManifestAsset(baseDir, manifest.Model)
	encoderPath := resolveManifestAsset(baseDir, manifest.Encoder)
	decoderPath := resolveManifestAsset(baseDir, manifest.Decoder)
	tokenizerPath := resolveManifestAsset(baseDir, cfg.TokenizerPath, manifest.Tokenizer)
	if tokenizerPath == "" {
		return onnxLocalSpec{}, fmt.Errorf("onnx-local summarizer manifest missing tokenizer path")
	}
	if modelPath == "" && encoderPath == "" && decoderPath == "" {
		return onnxLocalSpec{}, fmt.Errorf("onnx-local summarizer manifest missing model path")
	}

	maxCtx := manifest.MaxContextTokens
	if maxCtx <= 0 && hasProfile {
		maxCtx = selectedProfile.MaxContextTokens
	}

	profile := buildProfile(Profile{
		Backend:   "onnx-local",
		Family:    firstNonEmpty(strings.TrimSpace(manifest.Family), selectedProfile.Family, "onnx-local"),
		Model:     firstNonEmpty(filepath.Base(modelPath), filepath.Base(encoderPath), selectedProfile.Name),
		ModelPath: firstNonEmpty(modelPath, encoderPath, filepath.Dir(manifestPath)),
	})

	return onnxLocalSpec{
		RuntimePath:      strings.TrimSpace(cfg.RuntimePath),
		ModelPath:        modelPath,
		EncoderPath:      encoderPath,
		DecoderPath:      decoderPath,
		TokenizerPath:    tokenizerPath,
		MaxContextTokens: maxCtx,
		Profile:          profile,
	}, nil
}

func newONNXLocalBackend(cfg Config, deps Dependencies) (summarizerBackend, error) {
	if strings.TrimSpace(cfg.RuntimePath) == "" {
		return nil, fmt.Errorf("onnx-local summarizer requires ONNX runtime path")
	}
	spec, err := resolveONNXLocalSpec(cfg)
	if err != nil {
		return nil, err
	}
	registry := deps.Registry
	if registry == nil {
		registry = model.DefaultRegistry()
	}
	tokenizerLoader := deps.TokenizerLoader
	if tokenizerLoader == nil {
		tokenizerLoader = newTokenizer
	}
	tok, err := tokenizerLoader(spec.TokenizerPath)
	if err != nil {
		return nil, err
	}
	return &onnxLocalBackend{
		registry: registry,
		spec:     spec,
		tok:      tok,
	}, nil
}

func (b *onnxLocalBackend) Summarize(ctx context.Context, turns []Turn, opts SummaryOpts) (Summary, error) {
	opts = normalizeSummaryOpts(opts)
	if len(turns) == 0 {
		return Summary{}, fmt.Errorf("no turns to summarize")
	}
	if len(turns) < opts.MinInputTurns {
		return Summary{}, fmt.Errorf("need at least %d turns for summarization, got %d", opts.MinInputTurns, len(turns))
	}
	if err := b.Warmup(ctx); err != nil {
		return Summary{}, err
	}

	text := summarizeInput(turns)
	inputIDs, err := b.tok.Encode("summarize: " + text)
	if err != nil {
		return Summary{}, fmt.Errorf("tokenize input: %w", err)
	}
	if len(inputIDs) == 0 {
		return Summary{}, fmt.Errorf("tokenizer returned no input ids")
	}

	encMask := make([]int64, len(inputIDs))
	for i := range encMask {
		encMask[i] = 1
	}

	encHidden, err := b.runEncoder(inputIDs, encMask, len(inputIDs))
	if err != nil {
		return Summary{}, err
	}

	decodedIDs, confidence, err := b.decode(ctx, encHidden, encMask, len(inputIDs), opts.MaxOutputTokens)
	if err != nil {
		return Summary{}, err
	}
	summaryText, err := b.tok.Decode(decodedIDs)
	if err != nil {
		return Summary{}, fmt.Errorf("decode tokens: %w", err)
	}
	summaryText = strings.TrimSpace(summaryText)
	if summaryText == "" {
		return Summary{}, fmt.Errorf("summarizer produced empty output")
	}

	sourceIDs := make([]string, 0, len(turns))
	for _, turn := range turns {
		sourceIDs = append(sourceIDs, turn.ID)
	}
	return Summary{
		Text:       summaryText,
		SourceIDs:  sourceIDs,
		Method:     "onnx-t5",
		TokenCount: len(decodedIDs),
		Confidence: confidence,
	}, nil
}

func (b *onnxLocalBackend) Warmup(_ context.Context) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.loaded != nil {
		return nil
	}
	loaded, err := b.registry.LoadSeq2Seq(model.Seq2SeqSpec{
		Key: b.spec.Profile.Fingerprint,
		Profile: model.Profile{
			Name:          b.spec.Profile.Fingerprint,
			Family:        b.spec.Profile.Family,
			Task:          model.TaskSummarization,
			MaxCtxTokens:  b.spec.MaxContextTokens,
			ModelPath:     b.spec.ModelPath,
			TokenizerPath: b.spec.TokenizerPath,
			OrtLibPath:    b.spec.RuntimePath,
		},
		RuntimePath:    b.spec.RuntimePath,
		ModelPath:      b.spec.ModelPath,
		EncoderPath:    b.spec.EncoderPath,
		DecoderPath:    b.spec.DecoderPath,
		TokenizerPath:  b.spec.TokenizerPath,
		EncoderInputs:  []string{t5EncoderInputIDs, t5EncoderAttnMask},
		EncoderOutputs: []string{t5EncoderHiddenState},
		DecoderInputs:  []string{t5DecoderEncoderMask, t5DecoderInputIDs, t5DecoderEncoderHidden},
		DecoderOutputs: []string{t5DecoderLogits},
	})
	if err != nil {
		return err
	}
	b.loaded = loaded
	return nil
}

func (b *onnxLocalBackend) Unload() {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.loaded == nil {
		return
	}
	_ = b.registry.Unload(b.spec.Profile.Fingerprint)
	b.loaded = nil
}

func (b *onnxLocalBackend) Close() error {
	b.Unload()
	return nil
}

func (b *onnxLocalBackend) Profile() Profile { return b.spec.Profile }
func (b *onnxLocalBackend) Ready() bool      { return true }
func (b *onnxLocalBackend) Reason() string   { return "" }
func (b *onnxLocalBackend) Mode() string     { return "onnx-local" }

func resolveManifestPath(modelPath string) (string, error) {
	raw := strings.TrimSpace(modelPath)
	if raw == "" {
		return "", fmt.Errorf("onnx-local summarizer requires summarizerModelPath pointing to a model directory or summarizer.json")
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

func readManifest(path string) (summaryManifest, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return summaryManifest{}, fmt.Errorf("failed to read %s: %w", path, err)
	}
	var manifest summaryManifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		return summaryManifest{}, fmt.Errorf("failed to parse %s: %w", path, err)
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
		profile.Model,
		profile.ModelPath,
	}, "|")))
	profile.Fingerprint = hex.EncodeToString(hash[:8])
	return profile
}

func (b *onnxLocalBackend) runEncoder(inputIDs, attnMask []int64, seqLen int) ([]float32, error) {
	if b.loaded == nil {
		return nil, fmt.Errorf("onnx summarizer model not loaded")
	}
	shape2D := ort.NewShape(1, int64(seqLen))
	shape3D := ort.NewShape(1, int64(seqLen), t5SmallHiddenDim)

	inIDs, err := ort.NewTensor(shape2D, inputIDs)
	if err != nil {
		return nil, fmt.Errorf("create encoder input_ids tensor: %w", err)
	}
	defer inIDs.Destroy()
	inMask, err := ort.NewTensor(shape2D, attnMask)
	if err != nil {
		return nil, fmt.Errorf("create encoder attention_mask tensor: %w", err)
	}
	defer inMask.Destroy()
	outHidden, err := ort.NewEmptyTensor[float32](shape3D)
	if err != nil {
		return nil, fmt.Errorf("create encoder output tensor: %w", err)
	}
	defer outHidden.Destroy()

	if err := b.loaded.RunEncoder([]ort.Value{inIDs, inMask}, []ort.Value{outHidden}); err != nil {
		return nil, fmt.Errorf("encoder run: %w", err)
	}

	data := outHidden.GetData()
	out := make([]float32, len(data))
	copy(out, data)
	return out, nil
}

func (b *onnxLocalBackend) runDecoderStep(decIDs []int64, encHidden []float32, encMask []int64, seqLen int) ([]float32, error) {
	if b.loaded == nil {
		return nil, fmt.Errorf("onnx summarizer model not loaded")
	}
	decLen := len(decIDs)
	shape2DDec := ort.NewShape(1, int64(decLen))
	shape2DEnc := ort.NewShape(1, int64(seqLen))
	shape3D := ort.NewShape(1, int64(seqLen), t5SmallHiddenDim)
	shapeLogits := ort.NewShape(1, int64(decLen), t5SmallVocabSize)

	inIDs, err := ort.NewTensor(shape2DDec, decIDs)
	if err != nil {
		return nil, fmt.Errorf("create decoder input_ids tensor: %w", err)
	}
	defer inIDs.Destroy()
	inMask, err := ort.NewTensor(shape2DEnc, encMask)
	if err != nil {
		return nil, fmt.Errorf("create decoder encoder_attention_mask tensor: %w", err)
	}
	defer inMask.Destroy()
	inHidden, err := ort.NewTensor(shape3D, encHidden)
	if err != nil {
		return nil, fmt.Errorf("create decoder encoder_hidden_states tensor: %w", err)
	}
	defer inHidden.Destroy()
	outLogits, err := ort.NewEmptyTensor[float32](shapeLogits)
	if err != nil {
		return nil, fmt.Errorf("create decoder logits tensor: %w", err)
	}
	defer outLogits.Destroy()

	if err := b.loaded.RunDecoder([]ort.Value{inMask, inIDs, inHidden}, []ort.Value{outLogits}); err != nil {
		return nil, fmt.Errorf("decoder step: %w", err)
	}

	data := outLogits.GetData()
	out := make([]float32, len(data))
	copy(out, data)
	return out, nil
}

func (b *onnxLocalBackend) decode(ctx context.Context, encHidden []float32, encMask []int64, seqLen int, maxTokens int) (ids []int64, confidence float64, err error) {
	decInput := []int64{b.tok.BOS()}
	var logProbSum float64
	var tokenCount int

	for step := 0; step < maxTokens; step++ {
		select {
		case <-ctx.Done():
			return nil, 0, ctx.Err()
		default:
		}

		logits, err := b.runDecoderStep(decInput, encHidden, encMask, seqLen)
		if err != nil {
			return nil, 0, err
		}

		offset := (len(decInput) - 1) * t5SmallVocabSize
		lastLogits := logits[offset : offset+t5SmallVocabSize]

		nextToken, logProb := greedySelect(lastLogits)
		if nextToken == b.tok.EOS() {
			break
		}
		decInput = append(decInput, nextToken)
		logProbSum += logProb
		tokenCount++
	}

	if tokenCount > 0 {
		confidence = math.Exp(logProbSum / float64(tokenCount))
	}
	return decInput[1:], confidence, nil
}

func greedySelect(logits []float32) (token int64, logProb float64) {
	maxV := logits[0]
	for _, v := range logits {
		if v > maxV {
			maxV = v
		}
	}

	var sumExp float64
	for _, v := range logits {
		sumExp += math.Exp(float64(v) - float64(maxV))
	}
	logSumExp := float64(maxV) + math.Log(sumExp)

	best := int64(0)
	bestLogit := logits[0]
	for i, v := range logits {
		if v > bestLogit {
			bestLogit = v
			best = int64(i)
		}
	}
	return best, float64(bestLogit) - logSumExp
}

func summarizeInput(turns []Turn) string {
	parts := make([]string, 0, len(turns))
	for _, turn := range turns {
		text := strings.TrimSpace(turn.Text)
		if text != "" {
			parts = append(parts, text)
		}
	}
	return strings.Join(parts, "\n")
}
