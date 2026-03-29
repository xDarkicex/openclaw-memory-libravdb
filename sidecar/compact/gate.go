package compact

import (
	"math"
	"regexp"
	"strings"

	"github.com/xDarkicex/openclaw-memory-libravdb/sidecar/store"
)

const (
	inputFrequencyThreshold = 0.80
	inputFrequencyCap       = 5.0
	memSaturationThreshold  = 0.85
	memSaturationCap        = 3.0
)

// GatingConfig holds all weights and normalization constants.
// All weights within each branch must sum to 1.0 by convention.
type GatingConfig struct {
	W1c float64
	W2c float64
	W3c float64

	W1t float64
	W2t float64
	W3t float64

	TechNorm  float64
	Threshold float64
}

func DefaultGatingConfig() GatingConfig {
	return GatingConfig{
		W1c: 0.35, W2c: 0.40, W3c: 0.25,
		W1t: 0.40, W2t: 0.35, W3t: 0.25,
		TechNorm:  1.5,
		Threshold: 0.35,
	}
}

// GatingSignals holds all decomposed values for observability.
// Every field is stored in record metadata.
type GatingSignals struct {
	G float64 `json:"g"`
	T float64 `json:"t"`

	H float64 `json:"h"`
	R float64 `json:"r"`
	D float64 `json:"d"`

	InputFreq     float64 `json:"inputFreq"`
	MemSaturation float64 `json:"memSaturation"`

	P     float64 `json:"p"`
	A     float64 `json:"a"`
	Dtech float64 `json:"dtech"`

	Gconv float64 `json:"gconv"`
	Gtech float64 `json:"gtech"`
}

var (
	datePattern          = regexp.MustCompile(`\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}/\d{1,2}/\d{2,4})\b`)
	quantityPattern      = regexp.MustCompile(`\b\d+(?:\.\d+)?\b`)
	humanNamePattern     = regexp.MustCompile(`(?i)\b(?:mr|mrs|ms|dr|prof)\.?\s+[A-Z][a-z]+\b|\b(?:my (?:manager|teammate|friend|colleague))\s+[A-Z][a-z]+\b`)
	preferencePattern    = regexp.MustCompile(`(?i)\b(?:i prefer|i like|i love|my favorite|i enjoy)\b`)
	factAssertionPattern = regexp.MustCompile(`(?i)\b(?:i work at|my [a-z]+ is|i live in|i am|i have)\b`)

	codeFencePattern      = regexp.MustCompile("(?s)```.+?```")
	filePathPattern       = regexp.MustCompile(`(?:\./|\.\./|/)?[\w.-]+(?:/[\w.-]+)+(?:\.[A-Za-z0-9]+)?`)
	functionDefPattern    = regexp.MustCompile(`(?m)\b(?:func|def|class)\b|\b[A-Za-z_][A-Za-z0-9_]*\s*\(`)
	shellCommandPattern   = regexp.MustCompile(`(?m)(?:^\s*\$|\b(?:git|npm|pnpm|yarn|go|docker|make|kubectl)\b)`)
	urlOrEndpointPattern  = regexp.MustCompile(`https?://\S+|/[A-Za-z0-9._~/-]+`)
	stackTracePattern     = regexp.MustCompile(`(?i)\b(?:panic:|goroutine \d+|stack trace|traceback|exception:|at [^:\s]+:\d+)\b`)
	hexOrHashPattern      = regexp.MustCompile(`\b(?:[a-f0-9]{7,40}|0x[a-fA-F0-9]+)\b`)
	functionRefPattern    = regexp.MustCompile(`\b[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?\s*\(`)
	errorCodePattern      = regexp.MustCompile(`(?i)\b(?:ERR_[A-Z0-9_]+|E[A-Z0-9_]{2,}|HTTP\s+[45]\d{2}|[45]\d{2})\b`)
	gitRefPattern         = regexp.MustCompile(`\b(?:[a-f0-9]{7,40}|HEAD|main|master|origin/[A-Za-z0-9._/-]+)\b`)
	archDecisionPattern   = regexp.MustCompile(`(?i)\b(?:switched to|use .+ instead|migrated to|replaced with|decided to|standardize on)\b`)
	resolutionPattern     = regexp.MustCompile(`(?i)\b(?:fixed|resolved|patched|corrected|unblocked)\b`)
	milestonePattern      = regexp.MustCompile(`(?i)\b(?:deployed|merged|released|shipped|rolled out)\b`)
	configChangePattern   = regexp.MustCompile(`(?i)\b(?:set [A-Za-z0-9_]+ to|configured|configuration changed|env(?:ironment)? var)\b`)
	dataStructurePattern  = regexp.MustCompile(`(?i)\b(?:struct|interface|type|enum|map\[)\b`)
	dependencyPattern     = regexp.MustCompile(`(?i)\b(?:import|require|go\.mod|package\.json|dependency|depends on)\b`)
	testCasePattern       = regexp.MustCompile(`(?i)\b(?:func Test\w+|it\(|describe\(|test\()\b`)
	docCommentPattern     = regexp.MustCompile(`(?m)(?:^\s*//|/\*\*|///)`)
)

// ComputeGating is a pure function.
// turnHits: SearchText(turns:userId, text, 10)
// memHits:  SearchText(user:userId, text, 5)
func ComputeGating(turnHits, memHits []store.SearchResult, text string, cfg GatingConfig) GatingSignals {
	techT := computeT(text, cfg.TechNorm)

	h := computeH(memHits)
	inputFreq := math.Min(float64(countAbove(turnHits, inputFrequencyThreshold))/inputFrequencyCap, 1.0)
	memSaturation := math.Min(float64(countAbove(memHits, memSaturationThreshold))/memSaturationCap, 1.0)
	r := inputFreq * (1.0 - memSaturation)
	dnl := computeDNL(text)

	p := computeP(text)
	a := computeA(text)
	dtech := computeDTech(text)

	gConv := cfg.W1c*h + cfg.W2c*r + cfg.W3c*dnl
	gTech := cfg.W1t*p + cfg.W2t*a + cfg.W3t*dtech
	g := (1.0-techT)*gConv + techT*gTech

	return GatingSignals{
		G: g, T: techT,
		H: h, R: r, D: dnl,
		InputFreq:     inputFreq,
		MemSaturation: memSaturation,
		P:             p,
		A:             a,
		Dtech:         dtech,
		Gconv:         gConv,
		Gtech:         gTech,
	}
}

func (s GatingSignals) Passes(cfg GatingConfig) bool {
	return s.G >= cfg.Threshold
}

func countAbove(hits []store.SearchResult, threshold float64) int {
	count := 0
	for _, hit := range hits {
		if hit.Score >= threshold {
			count++
		}
	}
	return count
}

func computeH(hits []store.SearchResult) float64 {
	if len(hits) == 0 {
		return 1.0
	}
	var sum float64
	for _, hit := range hits {
		sum += hit.Score
	}
	return 1.0 - (sum / float64(len(hits)))
}

func computeT(text string, norm float64) float64 {
	text = strings.TrimSpace(text)
	if text == "" {
		return 0.0
	}
	if norm <= 0 {
		norm = 1.5
	}

	score := 0.0
	if codeFencePattern.MatchString(text) {
		score += 0.5
	}
	if filePathPattern.MatchString(text) {
		score += 0.4
	}
	if functionDefPattern.MatchString(text) {
		score += 0.4
	}
	if shellCommandPattern.MatchString(text) {
		score += 0.4
	}
	if urlOrEndpointPattern.MatchString(text) {
		score += 0.3
	}
	if stackTracePattern.MatchString(text) {
		score += 0.5
	}
	if hexOrHashPattern.MatchString(text) {
		score += 0.3
	}
	return math.Min(score/norm, 1.0)
}

func computeDNL(text string) float64 {
	text = strings.TrimSpace(text)
	if text == "" {
		return 0.0
	}

	score := 0.0
	if datePattern.MatchString(text) {
		score += 0.3
	}
	if quantityPattern.MatchString(text) {
		score += 0.2
	}
	if humanNamePattern.MatchString(text) {
		score += 0.3
	}
	if preferencePattern.MatchString(text) {
		score += 0.4
	}
	if factAssertionPattern.MatchString(text) {
		score += 0.3
	}
	return math.Min(score, 1.0)
}

func computeP(text string) float64 {
	text = strings.TrimSpace(text)
	if text == "" {
		return 0.0
	}

	norm := math.Max(float64(EstimateTokens(text))/100.0, 1.0)
	score := 0.0
	score += float64(countMatches(filePathPattern, text)) * 0.4
	score += float64(countMatches(functionRefPattern, text)) * 0.3
	score += float64(countMatches(errorCodePattern, text)) * 0.5
	score += float64(countMatches(gitRefPattern, text)) * 0.4
	score += float64(countMatches(urlOrEndpointPattern, text)) * 0.3

	return math.Min(score/norm, 1.0)
}

func computeA(text string) float64 {
	text = strings.TrimSpace(text)
	if text == "" {
		return 0.0
	}

	score := 0.0
	if archDecisionPattern.MatchString(text) {
		score += 0.5
	}
	if resolutionPattern.MatchString(text) {
		score += 0.4
	}
	if milestonePattern.MatchString(text) {
		score += 0.3
	}
	if configChangePattern.MatchString(text) {
		score += 0.4
	}
	return math.Min(score, 1.0)
}

func computeDTech(text string) float64 {
	text = strings.TrimSpace(text)
	if text == "" {
		return 0.0
	}

	score := 0.0
	if functionDefPattern.MatchString(text) {
		score += 0.4
	}
	if dataStructurePattern.MatchString(text) {
		score += 0.3
	}
	if dependencyPattern.MatchString(text) {
		score += 0.3
	}
	if testCasePattern.MatchString(text) {
		score += 0.2
	}
	if docCommentPattern.MatchString(text) {
		score += 0.2
	}
	return math.Min(score, 1.0)
}

func countMatches(pattern *regexp.Regexp, text string) int {
	return len(pattern.FindAllString(text, -1))
}
