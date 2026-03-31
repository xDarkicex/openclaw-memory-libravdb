package summarize

import (
	"context"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/xDarkicex/openclaw-memory-libravdb/sidecar/embed"
	"github.com/xDarkicex/openclaw-memory-libravdb/sidecar/model"
)

const DefaultBackend = "bundled"

type Config struct {
	Backend       string
	Profile       string
	RuntimePath   string
	ModelPath     string
	TokenizerPath string
	Model         string
	Endpoint      string
}

type Turn struct {
	ID   string
	Text string
}

type Summary struct {
	Text       string
	SourceIDs  []string
	Method     string
	TokenCount int

	// Confidence ∈ [0,1] — quality signal fed into temporal decay rate
	// of the inserted summary record in the vector store.
	//
	// Extractive: mean cosine similarity of selected turns to cluster centroid.
	// Abstractive (ONNX): normalized mean log-probability of generated tokens.
	// A higher confidence summary decays more slowly in the retrieval model.
	Confidence float64
}

type SummaryOpts struct {
	MaxOutputTokens int
	MinInputTurns   int
	TargetDensity   float64
}

type Profile struct {
	Backend     string `json:"backend"`
	Family      string `json:"family,omitempty"`
	Model       string `json:"model,omitempty"`
	ModelPath   string `json:"modelPath,omitempty"`
	Endpoint    string `json:"endpoint,omitempty"`
	Fingerprint string `json:"fingerprint,omitempty"`
}

type Summarizer interface {
	Summarize(context.Context, []Turn, SummaryOpts) (Summary, error)
	Profile() Profile
	Warmup(context.Context) error
	Unload()
	Close() error
	Ready() bool
	Reason() string
	Mode() string
}

type Engine struct {
	backend summarizerBackend
}

type summarizerBackend interface {
	Summarize(context.Context, []Turn, SummaryOpts) (Summary, error)
	Warmup(context.Context) error
	Unload()
	Close() error
	Profile() Profile
	Ready() bool
	Reason() string
	Mode() string
}

type Dependencies struct {
	Embedder        embed.Embedder
	Registry        *model.Registry
	TokenizerLoader func(string) (Tokenizer, error)
}

type unavailableBackend struct {
	reason  string
	mode    string
	profile Profile
}

type ExtractiveSummarizer struct {
	embedder embed.Embedder
	profile  Profile
}

func NewWithConfig(cfg Config) *Engine {
	return NewWithDeps(cfg, Dependencies{})
}

func NewWithDeps(cfg Config, deps Dependencies) *Engine {
	cfg.Backend = strings.TrimSpace(cfg.Backend)
	if cfg.Backend == "" {
		cfg.Backend = DefaultBackend
	}
	cfg.Profile = strings.TrimSpace(cfg.Profile)

	if strings.EqualFold(cfg.Backend, "extractive") {
		return NewExtractive(deps.Embedder, cfg.Profile)
	}

	if cfg.Backend == "onnx-local" {
		backend, err := newONNXLocalBackend(cfg, deps)
		if err == nil {
			return &Engine{backend: backend}
		}
		return &Engine{backend: unavailable(cfg, err.Error())}
	}

	if cfg.Backend == "bundled" {
		if deps.Embedder != nil && strings.EqualFold(cfg.Profile, "extractive") {
			return NewExtractive(deps.Embedder, firstNonEmpty(cfg.Profile, "extractive"))
		}
		resolved, err := resolveBundledSummarizer(cfg, deps)
		if err == nil {
			return resolved
		}
	}

	return &Engine{
		backend: unavailable(cfg, unavailableReason(cfg)),
	}
}

func NewExtractive(embedder embed.Embedder, profileName string) *Engine {
	if embedder == nil {
		return &Engine{
			backend: unavailableBackend{
				reason: "extractive summarizer requires embedder",
				mode:   "unavailable",
				profile: Profile{
					Backend: "extractive",
					Family:  firstNonEmpty(profileName, "extractive"),
				},
			},
		}
	}
	profile := Profile{
		Backend: "extractive",
		Family:  firstNonEmpty(profileName, "extractive"),
	}
	return &Engine{
		backend: &ExtractiveSummarizer{
			embedder: embedder,
			profile:  profile,
		},
	}
}

func (e *Engine) Summarize(ctx context.Context, turns []Turn, opts SummaryOpts) (Summary, error) {
	if !e.backend.Ready() {
		return Summary{}, fmt.Errorf("summarizer not ready: %s", e.backend.Reason())
	}
	return e.backend.Summarize(ctx, turns, normalizeSummaryOpts(opts))
}

func (e *Engine) Profile() Profile                 { return e.backend.Profile() }
func (e *Engine) Ready() bool                      { return e.backend.Ready() }
func (e *Engine) Reason() string                   { return e.backend.Reason() }
func (e *Engine) Mode() string                     { return e.backend.Mode() }
func (e *Engine) Warmup(ctx context.Context) error { return e.backend.Warmup(ctx) }
func (e *Engine) Unload()                          { e.backend.Unload() }
func (e *Engine) Close() error                     { return e.backend.Close() }

func (b unavailableBackend) Summarize(_ context.Context, _ []Turn, _ SummaryOpts) (Summary, error) {
	return Summary{}, fmt.Errorf("summarizer backend is unavailable: %s", b.reason)
}

func (b unavailableBackend) Warmup(_ context.Context) error {
	return fmt.Errorf("summarizer backend is unavailable: %s", b.reason)
}
func (b unavailableBackend) Unload()          {}
func (b unavailableBackend) Close() error     { return nil }
func (b unavailableBackend) Profile() Profile { return b.profile }
func (b unavailableBackend) Ready() bool      { return false }
func (b unavailableBackend) Reason() string   { return b.reason }
func (b unavailableBackend) Mode() string     { return b.mode }

func (s *ExtractiveSummarizer) Summarize(_ context.Context, turns []Turn, opts SummaryOpts) (Summary, error) {
	opts = normalizeSummaryOpts(opts)
	if len(turns) == 0 {
		return Summary{}, fmt.Errorf("no turns to summarize")
	}
	if len(turns) < opts.MinInputTurns {
		return Summary{}, fmt.Errorf("need at least %d turns for summarization, got %d", opts.MinInputTurns, len(turns))
	}

	embeddings := make([][]float32, 0, len(turns))
	for _, turn := range turns {
		vec, err := s.embedder.EmbedDocument(context.Background(), turn.Text)
		if err != nil {
			return Summary{}, err
		}
		embeddings = append(embeddings, vec)
	}

	centroid := meanVector(embeddings)
	type scoredTurn struct {
		index int
		score float64
	}
	scored := make([]scoredTurn, 0, len(turns))
	for i, vec := range embeddings {
		scored = append(scored, scoredTurn{
			index: i,
			score: cosine(vec, centroid),
		})
	}
	sort.Slice(scored, func(i, j int) bool {
		if scored[i].score == scored[j].score {
			return scored[i].index < scored[j].index
		}
		return scored[i].score > scored[j].score
	})

	targetCount := int(math.Ceil(float64(len(turns)) * opts.TargetDensity))
	if targetCount < 1 {
		targetCount = 1
	}
	if targetCount > len(turns) {
		targetCount = len(turns)
	}
	selected := scored[:targetCount]
	sort.Slice(selected, func(i, j int) bool { return selected[i].index < selected[j].index })

	sourceIDs := make([]string, 0, len(selected))
	parts := make([]string, 0, len(selected))
	var totalConfidence float64
	for _, pick := range selected {
		sourceIDs = append(sourceIDs, turns[pick.index].ID)
		parts = append(parts, strings.TrimSpace(turns[pick.index].Text))
		totalConfidence += pick.score
	}
	text := strings.TrimSpace(strings.Join(parts, " "))
	return Summary{
		Text:       text,
		SourceIDs:  sourceIDs,
		Method:     "extractive",
		TokenCount: tokenCount(text),
		Confidence: clamp01(totalConfidence / float64(len(selected))),
	}, nil
}

func (s *ExtractiveSummarizer) Profile() Profile               { return s.profile }
func (s *ExtractiveSummarizer) Warmup(_ context.Context) error { return nil }
func (s *ExtractiveSummarizer) Unload()                        {}
func (s *ExtractiveSummarizer) Close() error                   { return nil }
func (s *ExtractiveSummarizer) Ready() bool                    { return true }
func (s *ExtractiveSummarizer) Reason() string                 { return "" }
func (s *ExtractiveSummarizer) Mode() string                   { return "extractive" }

func normalizeSummaryOpts(opts SummaryOpts) SummaryOpts {
	if opts.MinInputTurns <= 0 {
		opts.MinInputTurns = 2
	}
	if opts.MaxOutputTokens <= 0 {
		opts.MaxOutputTokens = 64
	}
	if opts.TargetDensity <= 0 || opts.TargetDensity > 1 {
		opts.TargetDensity = 0.4
	}
	return opts
}

func resolveBundledSummarizer(cfg Config, deps Dependencies) (*Engine, error) {
	profile := strings.TrimSpace(cfg.Profile)
	if profile == "" {
		profile = "t5-small"
	}
	modelDir, err := resolveBundledSummarizerModelDir(profile)
	if err != nil {
		return nil, err
	}
	runtimePath := strings.TrimSpace(cfg.RuntimePath)
	backend, err := newONNXLocalBackend(Config{
		Backend:       "onnx-local",
		Profile:       profile,
		RuntimePath:   runtimePath,
		ModelPath:     modelDir,
		TokenizerPath: cfg.TokenizerPath,
	}, deps)
	if err != nil {
		return nil, err
	}
	return &Engine{backend: backend}, nil
}

var resolveBundledSummarizerModelDir = func(profile string) (string, error) {
	profile = strings.TrimSpace(profile)
	if profile == "" {
		profile = "t5-small"
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

	return "", fmt.Errorf("bundled summarizer profile %q assets not found; expected summarizer.json under a shipped model directory", profile)
}

func ancestorModelDirCandidates(start, profile string) []string {
	start = filepath.Clean(start)
	var results []string
	dir := start
	for {
		results = append(results,
			filepath.Join(dir, ".models", profile),
			filepath.Join(dir, "models", profile),
		)
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return results
}

func unavailableReason(cfg Config) string {
	switch cfg.Backend {
	case "bundled":
		return "bundled summarizer profile not implemented yet"
	case "onnx-local":
		return "onnx-local summarizer requires ONNX runtime path and summarizer model directory/manifest"
	case "ollama-local":
		if strings.TrimSpace(cfg.Model) == "" || strings.TrimSpace(cfg.Endpoint) == "" {
			return "ollama-local summarizer requires endpoint and model"
		}
		return "ollama-local summarizer backend not implemented yet"
	case "custom-local":
		return "custom-local summarizer backend not implemented yet"
	default:
		return fmt.Sprintf("unsupported summarizer backend: %s", cfg.Backend)
	}
}

func unavailable(cfg Config, reason string) unavailableBackend {
	return unavailableBackend{
		reason: reason,
		mode:   "unavailable",
		profile: Profile{
			Backend:   cfg.Backend,
			Family:    firstNonEmpty(cfg.Profile, cfg.Backend),
			Model:     strings.TrimSpace(cfg.Model),
			ModelPath: strings.TrimSpace(cfg.ModelPath),
			Endpoint:  strings.TrimSpace(cfg.Endpoint),
		},
	}
}

func meanVector(vectors [][]float32) []float32 {
	if len(vectors) == 0 {
		return nil
	}
	centroid := make([]float32, len(vectors[0]))
	for _, vec := range vectors {
		for i := range vec {
			centroid[i] += vec[i]
		}
	}
	scale := float32(len(vectors))
	for i := range centroid {
		centroid[i] /= scale
	}
	return centroid
}

func cosine(a, b []float32) float64 {
	if len(a) == 0 || len(a) != len(b) {
		return 0
	}
	var dot, normA, normB float64
	for i := range a {
		av := float64(a[i])
		bv := float64(b[i])
		dot += av * bv
		normA += av * av
		normB += bv * bv
	}
	if normA == 0 || normB == 0 {
		return 0
	}
	return dot / (math.Sqrt(normA) * math.Sqrt(normB))
}

func tokenCount(text string) int {
	if strings.TrimSpace(text) == "" {
		return 0
	}
	return len(strings.Fields(text))
}

func clamp01(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 1 {
		return 1
	}
	return v
}
