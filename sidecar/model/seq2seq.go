package model

import (
	"fmt"
	"strings"

	ort "github.com/yalue/onnxruntime_go"
)

type Seq2SeqSpec struct {
	Key            string
	Profile        Profile
	RuntimePath    string
	ModelPath      string
	EncoderPath    string
	DecoderPath    string
	TokenizerPath  string
	EncoderInputs  []string
	EncoderOutputs []string
	DecoderInputs  []string
	DecoderOutputs []string
}

type Seq2SeqModel struct {
	key      string
	registry *Registry
	encoder  *ort.DynamicAdvancedSession
	decoder  *ort.DynamicAdvancedSession
}

func (r *Registry) LoadSeq2Seq(spec Seq2SeqSpec) (*Seq2SeqModel, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if err := r.ensureRuntimeLocked(strings.TrimSpace(spec.RuntimePath)); err != nil {
		return nil, fmt.Errorf("failed to initialize onnx runtime: %w", err)
	}
	if spec.Key == "" {
		spec.Key = spec.Profile.Name
	}
	if loaded, ok := r.loaded[spec.Key]; ok && loaded.seq2seq != nil {
		loaded.lastAccess = timeNow()
		return loaded.seq2seq, nil
	}

	encoderPath := strings.TrimSpace(spec.EncoderPath)
	decoderPath := strings.TrimSpace(spec.DecoderPath)
	modelPath := strings.TrimSpace(spec.ModelPath)

	if encoderPath == "" && decoderPath == "" && modelPath == "" {
		return nil, fmt.Errorf("seq2seq model requires encoder, decoder, or model path")
	}
	if encoderPath == "" && modelPath != "" {
		encoderPath = modelPath
	}

	var encoderSession *ort.DynamicAdvancedSession
	var err error
	if encoderPath != "" {
		encoderSession, err = ort.NewDynamicAdvancedSession(encoderPath, spec.EncoderInputs, spec.EncoderOutputs, nil)
		if err != nil {
			return nil, fmt.Errorf("failed to create encoder session: %w", err)
		}
	}

	var decoderSession *ort.DynamicAdvancedSession
	if decoderPath != "" {
		decoderSession, err = ort.NewDynamicAdvancedSession(decoderPath, spec.DecoderInputs, spec.DecoderOutputs, nil)
		if err != nil {
			if encoderSession != nil {
				_ = encoderSession.Destroy()
			}
			return nil, fmt.Errorf("failed to create decoder session: %w", err)
		}
	}

	seq2seq := &Seq2SeqModel{
		key:      spec.Key,
		registry: r,
		encoder:  encoderSession,
		decoder:  decoderSession,
	}
	r.loaded[spec.Key] = &loadedModel{
		key:           spec.Key,
		profile:       spec.Profile,
		lastAccess:    timeNow(),
		useCount:      0,
		reservedBytes: fileSize(encoderPath) + fileSize(decoderPath) + fileSize(spec.ModelPath) + fileSize(spec.TokenizerPath),
		closeFn: func() error {
			if decoderSession != nil {
				if err := decoderSession.Destroy(); err != nil {
					return err
				}
			}
			if encoderSession != nil {
				if err := encoderSession.Destroy(); err != nil {
					return err
				}
			}
			return nil
		},
		seq2seq: seq2seq,
	}
	if err := r.maybeEvictLocked(timeNow()); err != nil {
		return nil, err
	}
	return seq2seq, nil
}

func (m *Seq2SeqModel) Touch() {
	if m == nil || m.registry == nil {
		return
	}
	m.registry.mu.Lock()
	m.registry.touchLocked(m.key)
	m.registry.mu.Unlock()
}

func (m *Seq2SeqModel) RunEncoder(inputs, outputs []ort.Value) error {
	if m == nil || m.encoder == nil {
		return fmt.Errorf("encoder session not loaded")
	}
	m.Touch()
	return m.encoder.Run(inputs, outputs)
}

func (m *Seq2SeqModel) RunDecoder(inputs, outputs []ort.Value) error {
	if m == nil || m.decoder == nil {
		return fmt.Errorf("decoder session not loaded")
	}
	m.Touch()
	return m.decoder.Run(inputs, outputs)
}
