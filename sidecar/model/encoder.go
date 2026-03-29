package model

import (
	"fmt"
	"os"
	"strings"

	"github.com/sugarme/tokenizer"
	"github.com/sugarme/tokenizer/pretrained"
	ort "github.com/yalue/onnxruntime_go"
)

type EncoderSpec struct {
	Key              string
	Profile          Profile
	RuntimePath      string
	ModelPath        string
	TokenizerPath    string
	InputNames       []string
	OutputName       string
	Dimensions       int
	AddSpecialTokens bool
	Pooling          string
}

type EncoderModel struct {
	key              string
	registry         *Registry
	tokenizer        tokenizer.Tokenizer
	session          *ort.DynamicAdvancedSession
	inputNames       []string
	dimensions       int
	addSpecialTokens bool
	pooling          string
}

func (r *Registry) LoadEncoder(spec EncoderSpec) (*EncoderModel, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if err := r.ensureRuntimeLocked(strings.TrimSpace(spec.RuntimePath)); err != nil {
		return nil, fmt.Errorf("failed to initialize onnx runtime: %w", err)
	}
	if spec.Key == "" {
		spec.Key = spec.Profile.Name
	}
	if loaded, ok := r.loaded[spec.Key]; ok && loaded.encoder != nil {
		loaded.lastAccess = timeNow()
		return loaded.encoder, nil
	}

	tk, err := pretrained.FromFile(spec.TokenizerPath)
	if err != nil {
		return nil, fmt.Errorf("failed to load tokenizer: %w", err)
	}
	session, err := ort.NewDynamicAdvancedSession(spec.ModelPath, spec.InputNames, []string{spec.OutputName}, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create onnx session: %w", err)
	}

	encoder := &EncoderModel{
		key:              spec.Key,
		registry:         r,
		tokenizer:        *tk,
		session:          session,
		inputNames:       append([]string(nil), spec.InputNames...),
		dimensions:       spec.Dimensions,
		addSpecialTokens: spec.AddSpecialTokens,
		pooling:          spec.Pooling,
	}
	r.loaded[spec.Key] = &loadedModel{
		key:           spec.Key,
		profile:       spec.Profile,
		lastAccess:    timeNow(),
		useCount:      0,
		reservedBytes: fileSize(spec.ModelPath) + fileSize(spec.TokenizerPath),
		closeFn:       session.Destroy,
		encoder:       encoder,
	}
	if err := r.maybeEvictLocked(timeNow()); err != nil {
		return nil, err
	}
	return encoder, nil
}

func (m *EncoderModel) EmbedText(text string) ([]float32, error) {
	encoding, err := m.EncodeText(text, m.addSpecialTokens)
	if err != nil {
		return nil, err
	}
	return m.EmbedEncoding(*encoding)
}

func (m *EncoderModel) TokenCount(text string) (int, error) {
	encoding, err := m.EncodeText(text, m.addSpecialTokens)
	if err != nil {
		return 0, err
	}
	return len(encoding.Ids), nil
}

func (m *EncoderModel) EncodeText(text string, addSpecialTokens bool) (*tokenizer.Encoding, error) {
	m.registry.mu.Lock()
	m.registry.touchLocked(m.key)
	m.registry.mu.Unlock()

	input := tokenizer.NewSingleEncodeInput(tokenizer.NewRawInputSequence(text))
	encoding, err := m.tokenizer.Encode(input, addSpecialTokens)
	if err != nil {
		return nil, fmt.Errorf("failed to tokenize sentence: %w", err)
	}
	if encoding == nil || len(encoding.Ids) == 0 {
		return nil, fmt.Errorf("tokenizer returned no encodings")
	}
	return encoding, nil
}

func (m *EncoderModel) EmbedEncoding(encoding tokenizer.Encoding) ([]float32, error) {
	batchSize := 1
	seqLength := len(encoding.Ids)
	inputShape := ort.NewShape(int64(batchSize), int64(seqLength))
	inputs := make([]ort.Value, 0, len(m.inputNames))
	encodings := []tokenizer.Encoding{encoding}

	for _, name := range m.inputNames {
		data, err := inputTensorData(name, encodings, seqLength)
		if err != nil {
			return nil, err
		}
		tensor, err := ort.NewTensor(inputShape, data)
		if err != nil {
			return nil, fmt.Errorf("failed creating %s tensor: %w", name, err)
		}
		defer tensor.Destroy()
		inputs = append(inputs, tensor)
	}

	outputShape := ort.NewShape(int64(batchSize), int64(m.dimensions))
	useMeanPooling := m.pooling == "mean"
	if useMeanPooling {
		outputShape = ort.NewShape(int64(batchSize), int64(seqLength), int64(m.dimensions))
	}
	outputTensor, err := ort.NewEmptyTensor[float32](outputShape)
	if err != nil {
		return nil, fmt.Errorf("failed creating output tensor: %w", err)
	}
	defer outputTensor.Destroy()

	if err := m.session.Run(inputs, []ort.Value{outputTensor}); err != nil {
		return nil, fmt.Errorf("failed to run onnx session: %w", err)
	}

	flat := outputTensor.GetData()
	expected := batchSize * m.dimensions
	if useMeanPooling {
		expected = batchSize * seqLength * m.dimensions
	}
	if len(flat) != expected {
		return nil, fmt.Errorf("unexpected output tensor size: got %d elements, expected %d", len(flat), expected)
	}

	if useMeanPooling {
		return meanPoolLastHiddenState(flat, encoding.AttentionMask, seqLength, m.dimensions), nil
	}

	vec := make([]float32, m.dimensions)
	copy(vec, flat[:m.dimensions])
	return vec, nil
}

func inputTensorData(name string, encodings []tokenizer.Encoding, seqLength int) ([]int64, error) {
	data := make([]int64, len(encodings)*seqLength)
	for batch := range encodings {
		switch name {
		case "input_ids":
			for i, id := range encodings[batch].Ids {
				data[batch*seqLength+i] = int64(id)
			}
		case "attention_mask":
			for i, mask := range encodings[batch].AttentionMask {
				data[batch*seqLength+i] = int64(mask)
			}
		case "token_type_ids":
			for i, typeID := range encodings[batch].TypeIds {
				data[batch*seqLength+i] = int64(typeID)
			}
		default:
			return nil, fmt.Errorf("unsupported input tensor name %q", name)
		}
	}
	return data, nil
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

func fileSize(path string) int64 {
	info, err := os.Stat(path)
	if err != nil {
		return 0
	}
	return info.Size()
}
