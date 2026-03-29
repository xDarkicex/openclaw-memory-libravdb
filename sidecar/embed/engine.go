package embed

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/sugarme/tokenizer"
)

const (
	DefaultBackend    = "bundled"
	DefaultDimensions = 768
	longDocWindowSize = 512
	longDocStride     = 256
)

type Config struct {
	Backend         string
	Profile         string
	FallbackProfile string
	RuntimePath     string
	ModelPath       string
	TokenizerPath   string
	Dimensions      int
	Normalize       bool
}

type Embedder interface {
	EmbedDocument(ctx context.Context, text string) ([]float32, error)
	EmbedQuery(ctx context.Context, text string) ([]float32, error)
	Dimensions() int
	Profile() Profile
	Ready() bool
	Reason() string
	Mode() string
}

type Engine struct {
	dimensions int
	ready      bool
	reason     string
	mode       string
	backend    embeddingBackend
	profile    Profile
}

type embeddingBackend interface {
	Embed(text string, dimensions int) ([]float32, error)
}

type deterministicBackend struct {
	normalize bool
}

type miniLMModel interface {
	Compute(sentence string, addSpecialTokens bool) ([]float32, error)
	TokenCount(sentence string, addSpecialTokens bool) (int, error)
	Encode(sentence string, addSpecialTokens bool) (*tokenizer.Encoding, error)
	ComputeEncoding(encoding tokenizer.Encoding) ([]float32, error)
}

type miniLMBackend struct {
	model     miniLMModel
	normalize bool
}

var resolveBundledModelDir = func(profile string) (string, error) {
	profile = strings.TrimSpace(profile)
	if profile == "" {
		profile = DefaultEmbeddingProfile
	}

	candidates := make([]string, 0, 16)
	if exe, err := os.Executable(); err == nil && strings.TrimSpace(exe) != "" {
		exeDir := filepath.Dir(exe)
		candidates = append(candidates,
			filepath.Join(exeDir, "models", profile),
			filepath.Join(exeDir, "..", ".models", profile),
			filepath.Join(exeDir, "..", "models", profile),
		)
		candidates = append(candidates, ancestorModelDirCandidates(exeDir, profile)...)
	}
	if cwd, err := os.Getwd(); err == nil && strings.TrimSpace(cwd) != "" {
		candidates = append(candidates,
			filepath.Join(cwd, "..", ".models", profile),
			filepath.Join(cwd, ".models", profile),
			filepath.Join(cwd, "models", profile),
		)
		candidates = append(candidates, ancestorModelDirCandidates(cwd, profile)...)
	}

	seen := map[string]struct{}{}
	for _, candidate := range candidates {
		candidate = filepath.Clean(candidate)
		if _, ok := seen[candidate]; ok {
			continue
		}
		seen[candidate] = struct{}{}
		if info, err := os.Stat(candidate); err == nil && info.IsDir() {
			manifestPath := filepath.Join(candidate, defaultManifestName)
			if _, err := os.Stat(manifestPath); err == nil {
				return candidate, nil
			}
		}
	}

	return "", fmt.Errorf("bundled profile %q assets not found; expected embedding.json under a shipped model directory", profile)
}

var resolveBundledSpec = func(cfg Config) (onnxLocalSpec, error) {
	profileName := strings.TrimSpace(cfg.Profile)
	if profileName == "" {
		profileName = DefaultEmbeddingProfile
	}
	modelDir := strings.TrimSpace(cfg.ModelPath)
	if modelDir == "" {
		var err error
		modelDir, err = resolveBundledModelDir(profileName)
		if err != nil {
			return onnxLocalSpec{}, err
		}
	}

	runtimePath := strings.TrimSpace(cfg.RuntimePath)
	if runtimePath == "" {
		var err error
		runtimePath, err = resolveBundledRuntimePath()
		if err != nil {
			return onnxLocalSpec{}, err
		}
	}

	return resolveONNXLocalSpec(Config{
		Backend:       "onnx-local",
		Profile:       profileName,
		RuntimePath:   runtimePath,
		ModelPath:     modelDir,
		TokenizerPath: cfg.TokenizerPath,
		Dimensions:    cfg.Dimensions,
		Normalize:     cfg.Normalize,
	})
}

var resolveBundledRuntimePath = func() (string, error) {
	libName := bundledRuntimeLibName()
	if libName == "" {
		return "", fmt.Errorf("unsupported platform for bundled onnx runtime: %s/%s", runtime.GOOS, runtime.GOARCH)
	}

	candidates := make([]string, 0, 20)
	if exe, err := os.Executable(); err == nil && strings.TrimSpace(exe) != "" {
		exeDir := filepath.Dir(exe)
		candidates = append(candidates,
			filepath.Join(exeDir, "onnxruntime", "lib", libName),
			filepath.Join(exeDir, "..", ".models", "onnxruntime", "*", "lib", libName),
			filepath.Join(exeDir, "..", "models", "onnxruntime", "*", "lib", libName),
		)
		candidates = append(candidates, ancestorRuntimeCandidates(exeDir, libName)...)
	}
	if cwd, err := os.Getwd(); err == nil && strings.TrimSpace(cwd) != "" {
		candidates = append(candidates,
			filepath.Join(cwd, "..", ".models", "onnxruntime", "*", "lib", libName),
			filepath.Join(cwd, ".models", "onnxruntime", "*", "lib", libName),
			filepath.Join(cwd, "models", "onnxruntime", "*", "lib", libName),
		)
		candidates = append(candidates, ancestorRuntimeCandidates(cwd, libName)...)
	}

	seen := map[string]struct{}{}
	for _, pattern := range candidates {
		matches := []string{pattern}
		if strings.Contains(pattern, "*") {
			globbed, _ := filepath.Glob(pattern)
			matches = globbed
		}
		for _, match := range matches {
			match = filepath.Clean(match)
			if _, ok := seen[match]; ok {
				continue
			}
			seen[match] = struct{}{}
			if info, err := os.Stat(match); err == nil && !info.IsDir() {
				return match, nil
			}
		}
	}

	return "", fmt.Errorf("bundled onnx runtime library %q not found in shipped asset locations", libName)
}

func bundledRuntimeLibName() string {
	switch runtime.GOOS {
	case "darwin":
		return "libonnxruntime.dylib"
	case "linux":
		return "libonnxruntime.so"
	case "windows":
		return "onnxruntime.dll"
	default:
		return ""
	}
}

func ResolveRuntimePath(cfg Config) (string, error) {
	runtimePath := strings.TrimSpace(cfg.RuntimePath)
	if runtimePath != "" {
		return runtimePath, nil
	}

	switch strings.TrimSpace(cfg.Backend) {
	case "", "bundled":
		return resolveBundledRuntimePath()
	case "onnx-local":
		return "", fmt.Errorf("onnx-local embedder requires runtime path or unpacked bundled runtime")
	default:
		return "", fmt.Errorf("backend %q does not use ONNX runtime resolution", cfg.Backend)
	}
}

func ancestorModelDirCandidates(start, profile string) []string {
	return walkAncestors(start, func(dir string) []string {
		return []string{
			filepath.Join(dir, ".models", profile),
			filepath.Join(dir, "models", profile),
		}
	})
}

func ancestorRuntimeCandidates(start, libName string) []string {
	return walkAncestors(start, func(dir string) []string {
		return []string{
			filepath.Join(dir, ".models", "onnxruntime", "*", "lib", libName),
			filepath.Join(dir, "models", "onnxruntime", "*", "lib", libName),
		}
	})
}

func walkAncestors(start string, build func(string) []string) []string {
	start = filepath.Clean(start)
	var results []string
	dir := start
	for {
		results = append(results, build(dir)...)
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return results
}

func New(dimensions int) *Engine {
	return &Engine{dimensions: dimensions}
}

func (e *Engine) Dimensions() int {
	return e.dimensions
}

func (e *Engine) Ready() bool {
	return e.ready
}

func (e *Engine) Reason() string {
	return e.reason
}

func (e *Engine) Mode() string {
	return e.mode
}

func (e *Engine) Profile() Profile {
	return e.profile
}

func NewUnavailable(reason string) *Engine {
	return &Engine{
		dimensions: DefaultDimensions,
		ready:      false,
		reason:     reason,
		mode:       "unavailable",
	}
}

func NewPrimary(runtimePath string) *Engine {
	return NewWithConfig(Config{
		Backend:         DefaultBackend,
		Profile:         DefaultEmbeddingProfile,
		FallbackProfile: FallbackEmbeddingProfile,
		RuntimePath:     runtimePath,
		Dimensions:      DefaultDimensions,
		Normalize:       true,
	})
}

func NewWithConfig(cfg Config) *Engine {
	cfg = normalizeConfig(cfg)

	switch cfg.Backend {
	case "bundled":
		engine, err := newBundledEngine(cfg)
		if err != nil {
			return NewFallbackWithConfig(cfg, fmt.Sprintf("bundled embedder unavailable (%v); using deterministic local fallback", err))
		}
		return engine
	case "onnx-local":
		if cfg.RuntimePath == "" || cfg.ModelPath == "" {
			return NewUnavailable("onnx-local requires ONNX runtime path and embedding model directory/manifest")
		}
		spec, err := resolveONNXLocalSpec(cfg)
		if err != nil {
			return NewUnavailable(err.Error())
		}
		backend, err := newONNXLocalBackend(spec)
		if err != nil {
			return NewUnavailable(err.Error())
		}
		engine := &Engine{
			dimensions: spec.Dimensions,
			ready:      true,
			reason:     "",
			mode:       "onnx-local",
			backend:    backend,
			profile:    spec.Profile,
		}
		if err := verifyDimensions(engine); err != nil {
			return NewUnavailable(err.Error())
		}
		return engine
	case "custom-local":
		if cfg.ModelPath == "" {
			return NewFallbackWithConfig(cfg, "missing custom embedding model path; using deterministic local fallback")
		}
		engine := &Engine{
			dimensions: cfg.Dimensions,
			ready:      true,
			reason:     "",
			mode:       "custom-local",
			backend:    deterministicBackend{normalize: cfg.Normalize},
			profile: buildProfile(Profile{
				Backend:          "custom-local",
				Family:           "custom-local",
				Dimensions:       cfg.Dimensions,
				Normalize:        cfg.Normalize,
				MaxContextTokens: 0,
				ModelPath:        cfg.ModelPath,
				Tokenizer:        cfg.TokenizerPath,
			}),
		}
		if err := verifyDimensions(engine); err != nil {
			return NewUnavailable(err.Error())
		}
		return engine
	default:
		return NewUnavailable(fmt.Sprintf("unsupported embedding backend: %s", cfg.Backend))
	}
}

func normalizeConfig(cfg Config) Config {
	cfg.Backend = strings.TrimSpace(cfg.Backend)
	if cfg.Backend == "" {
		cfg.Backend = DefaultBackend
	}
	cfg.Profile = strings.TrimSpace(cfg.Profile)
	cfg.FallbackProfile = strings.TrimSpace(cfg.FallbackProfile)
	if cfg.Profile == "" && cfg.Backend == "bundled" {
		cfg.Profile = DefaultEmbeddingProfile
	}
	if cfg.FallbackProfile == "" && cfg.Backend == "bundled" {
		cfg.FallbackProfile = FallbackEmbeddingProfile
	}
	if cfg.Dimensions <= 0 && cfg.Backend != "onnx-local" {
		if profile, ok := lookupProfile(cfg.Profile); ok {
			cfg.Dimensions = profile.Dimensions
			cfg.Normalize = profile.Normalize
		} else {
			cfg.Dimensions = DefaultDimensions
		}
	}
	return cfg
}

func newBundledEngine(cfg Config) (*Engine, error) {
	profiles := []string{cfg.Profile}
	if cfg.ModelPath == "" && cfg.FallbackProfile != "" && cfg.FallbackProfile != cfg.Profile {
		profiles = append(profiles, cfg.FallbackProfile)
	}

	var failures []string
	for i, profile := range profiles {
		candidate := cfg
		candidate.Profile = profile
		if i > 0 {
			candidate.ModelPath = ""
			candidate.TokenizerPath = ""
			candidate.Dimensions = 0
		}

		spec, err := resolveBundledSpec(candidate)
		if err != nil {
			failures = append(failures, fmt.Sprintf("%s: %v", profile, err))
			continue
		}
		backend, err := newONNXLocalBackend(spec)
		if err != nil {
			failures = append(failures, fmt.Sprintf("%s: %v", profile, err))
			continue
		}
		engine := &Engine{
			dimensions: spec.Dimensions,
			ready:      true,
			reason:     "",
			mode:       "primary",
			backend:    backend,
			profile:    spec.Profile,
		}
		if err := verifyDimensions(engine); err != nil {
			failures = append(failures, fmt.Sprintf("%s: %v", profile, err))
			continue
		}
		return engine, nil
	}

	return nil, errors.New(strings.Join(failures, "; "))
}

func NewFallback(reason string) *Engine {
	return NewFallbackWithConfig(Config{
		Backend:    DefaultBackend,
		Dimensions: DefaultDimensions,
		Normalize:  true,
	}, reason)
}

func NewFallbackWithConfig(cfg Config, reason string) *Engine {
	cfg = normalizeConfig(cfg)
	engine := &Engine{
		dimensions: cfg.Dimensions,
		ready:      true,
		reason:     reason,
		mode:       "fallback",
		backend:    deterministicBackend{normalize: cfg.Normalize},
		profile: buildProfile(Profile{
			Backend:          "fallback",
			Family:           "deterministic-local",
			Dimensions:       cfg.Dimensions,
			Normalize:        cfg.Normalize,
			MaxContextTokens: 0,
		}),
	}
	if err := verifyDimensions(engine); err != nil {
		return NewUnavailable(err.Error())
	}
	return engine
}

func verifyDimensions(e *Engine) error {
	vec, err := e.EmbedDocument(context.Background(), "dimension probe")
	if err != nil {
		return fmt.Errorf("dimension verification failed: %w", err)
	}
	if got := len(vec); got != e.dimensions {
		return fmt.Errorf("dimension verification failed: got %d, want %d", got, e.dimensions)
	}
	return nil
}

func (e *Engine) EmbedDocument(_ context.Context, text string) ([]float32, error) {
	prefixed := e.documentPrefix() + text
	if vec, ok, err := e.embedLongDocument(prefixed); ok {
		return vec, err
	}
	return e.embed(prefixed)
}

func (e *Engine) EmbedQuery(_ context.Context, text string) ([]float32, error) {
	return e.embed(e.queryPrefix() + text)
}

func (e *Engine) documentPrefix() string {
	switch e.profile.Family {
	case "nomic-embed-text-v1.5":
		return "search_document: "
	default:
		return ""
	}
}

func (e *Engine) queryPrefix() string {
	switch e.profile.Family {
	case "nomic-embed-text-v1.5":
		return "search_query: "
	default:
		return ""
	}
}

func (e *Engine) embed(text string) ([]float32, error) {
	if !e.ready {
		return nil, fmt.Errorf("embedding engine not ready: %s", e.reason)
	}

	if e.backend == nil {
		return nil, errors.New("embedding backend not configured")
	}
	return e.backend.Embed(text, e.dimensions)
}

func (e *Engine) TokenCountDocument(_ context.Context, text string) (int, error) {
	return e.tokenCount(e.documentPrefix() + text)
}

func (e *Engine) TokenCountQuery(_ context.Context, text string) (int, error) {
	return e.tokenCount(e.queryPrefix() + text)
}

func (e *Engine) tokenCount(text string) (int, error) {
	if !e.ready {
		return 0, fmt.Errorf("embedding engine not ready: %s", e.reason)
	}

	counter, ok := e.backend.(interface {
		TokenCount(text string) (int, error)
	})
	if !ok {
		return 0, fmt.Errorf("token count unavailable for backend family %q", e.profile.Family)
	}
	return counter.TokenCount(text)
}

func (e *Engine) embedLongDocument(text string) ([]float32, bool, error) {
	if !strings.EqualFold(e.profile.Family, "nomic-embed-text-v1.5") {
		return nil, false, nil
	}

	tokenAware, ok := e.backend.(interface {
		Encode(text string) (*tokenizer.Encoding, error)
		EmbedEncoding(encoding tokenizer.Encoding, dimensions int) ([]float32, error)
	})
	if !ok {
		return nil, false, nil
	}

	encoding, err := tokenAware.Encode(text)
	if err != nil {
		return nil, true, err
	}

	windowSize := longDocWindowSize
	if e.profile.MaxContextTokens > 0 && windowSize > e.profile.MaxContextTokens {
		windowSize = e.profile.MaxContextTokens
	}
	if windowSize <= 0 {
		return nil, false, nil
	}
	if len(encoding.Ids) <= windowSize {
		vec, err := tokenAware.EmbedEncoding(*encoding, e.dimensions)
		return vec, true, err
	}

	stride := longDocStride
	if stride <= 0 || stride >= windowSize {
		stride = windowSize / 2
	}
	if stride <= 0 {
		stride = 1
	}

	windowed := encoding.Clone()
	if _, err := windowed.Truncate(windowSize, stride); err != nil {
		return nil, true, err
	}

	windows := make([]tokenizer.Encoding, 0, 1+len(windowed.Overflowing))
	windows = append(windows, *windowed)
	windows = append(windows, windowed.Overflowing...)

	vecs := make([][]float32, 0, len(windows))
	for _, window := range windows {
		vec, err := tokenAware.EmbedEncoding(window, e.dimensions)
		if err != nil {
			return nil, true, err
		}
		vecs = append(vecs, vec)
	}

	return meanPoolVectors(vecs), true, nil
}

func (b deterministicBackend) Embed(text string, dimensions int) ([]float32, error) {
	vec := deterministicEmbedding(text, dimensions)
	if b.normalize {
		normalizeEmbedding(vec)
	}
	return vec, nil
}

func (b miniLMBackend) Embed(text string, dimensions int) ([]float32, error) {
	vec, err := b.model.Compute(text, true)
	if err != nil {
		return nil, err
	}
	if len(vec) != dimensions {
		return nil, fmt.Errorf("unexpected embedding dimensions: got %d, want %d", len(vec), dimensions)
	}
	if b.normalize {
		normalizeEmbedding(vec)
	}
	return vec, nil
}

func (b miniLMBackend) TokenCount(text string) (int, error) {
	return b.model.TokenCount(text, true)
}

func (b miniLMBackend) Encode(text string) (*tokenizer.Encoding, error) {
	return b.model.Encode(text, true)
}

func (b miniLMBackend) EmbedEncoding(encoding tokenizer.Encoding, dimensions int) ([]float32, error) {
	vec, err := b.model.ComputeEncoding(encoding)
	if err != nil {
		return nil, err
	}
	if len(vec) != dimensions {
		return nil, fmt.Errorf("unexpected embedding dimensions: got %d, want %d", len(vec), dimensions)
	}
	if b.normalize {
		normalizeEmbedding(vec)
	}
	return vec, nil
}

func deterministicEmbedding(text string, dimensions int) []float32 {
	vec := make([]float32, dimensions)
	if dimensions <= 0 {
		return vec
	}

	tokens := strings.Fields(strings.ToLower(text))
	if len(tokens) == 0 {
		tokens = []string{text}
	}

	for _, token := range tokens {
		sum := sha256.Sum256([]byte(token))
		for i := 0; i < dimensions; i++ {
			b := sum[i%len(sum)]
			value := (float32(b) / 127.5) - 1.0
			vec[i] += value
		}
	}

	normalizeEmbedding(vec)
	return vec
}

func normalizeEmbedding(vec []float32) {
	var norm float64
	for _, v := range vec {
		norm += float64(v * v)
	}
	if norm == 0 {
		return
	}

	scale := float32(1.0 / math.Sqrt(norm))
	for i := range vec {
		vec[i] *= scale
	}
}

func meanPoolVectors(vecs [][]float32) []float32 {
	if len(vecs) == 0 {
		return nil
	}
	result := make([]float32, len(vecs[0]))
	for _, vec := range vecs {
		for i, value := range vec {
			result[i] += value
		}
	}
	denom := float32(len(vecs))
	for i := range result {
		result[i] /= denom
	}
	return result
}
