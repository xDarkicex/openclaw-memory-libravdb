package compact

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/xDarkicex/openclaw-memory-libravdb/sidecar/astv2"
	"github.com/xDarkicex/openclaw-memory-libravdb/sidecar/embed"
	"github.com/xDarkicex/openclaw-memory-libravdb/sidecar/store"
	"github.com/xDarkicex/openclaw-memory-libravdb/sidecar/summarize"
)

const (
	DefaultTargetSize            = 20
	DefaultMaxOutputTokens       = 64
	AbstractiveRoutingThreshold  = 0.60
	PreservationThreshold        = 0.65
	NomicConfidenceWeight        = 0.80
	DefaultContinuityMinTurns    = 4
	DefaultContinuityTailTokens  = 128
	DefaultContinuityPriorTokens = 96
	guidanceShardType            = "guidance_shard"
	sessionStateRecordKey        = "__session_state__"
	ElevatedGuidanceMinStability = 0.35
	ElevatedGuidanceBoosterFloor = 0.78
)

var (
	longBase64ishTokenPattern  = regexp.MustCompile(`(?i)\b(?:[A-Z0-9+/=_-]{80,})\b`)
	longHexTokenPattern        = regexp.MustCompile(`(?i)\b[0-9a-f]{64,}\b`)
	guidanceSurfaceHintPattern = regexp.MustCompile(`(?i)\b(?:prefer|prioriti[sz]e|focus|avoid|reject|keep|ensure|consider|should|must|never|do not|don't|use)\b`)
	guidancePrototypeTexts     = []string{
		"Prefer deterministic operational guidance over generic defaults.",
		"Avoid unsafe or undesired implementation choices in hot paths.",
		"Use the specified approach when implementing core project logic.",
		"Keep the implementation aligned with project-specific engineering rules.",
	}
)

type Store interface {
	ListByMeta(ctx context.Context, collection, key, value string) ([]store.SearchResult, error)
	InsertText(ctx context.Context, collection, id, text string, meta map[string]any) error
	DeleteBatch(ctx context.Context, collection string, ids []string) error
	EnsureLosslessSessionCollections(ctx context.Context, sessionID string) error
	Get(ctx context.Context, collection, id string) (store.Record, error)
	WithTx(ctx context.Context, fn func(tx store.TxWriter) error) error
	ExpandSummary(ctx context.Context, sessionID, summaryID string, maxDepth int) ([]store.SearchResult, error)
}

type Result struct {
	DidCompact       bool    `json:"didCompact"`
	ClustersFormed   int     `json:"clustersFormed"`
	ClustersDeclined int     `json:"clustersDeclined"`
	TurnsRemoved     int     `json:"turnsRemoved"`
	SummaryMethod    string  `json:"summaryMethod,omitempty"`
	MeanConfidence   float64 `json:"meanConfidence"`
}

type cluster struct {
	turns []turnRecord
}

type priorSummaryRecord struct {
	id         string
	text       string
	tokenCount int
	ts         int64
}

type priorContextSelection struct {
	summaryIDs []string
	text       string
	tokens     int
}

type turnRecord struct {
	id       string
	text     string
	metadata map[string]any
	ts       int64
}

type qualityMetadata struct {
	Align     float64
	Cover     float64
	ConfT5    float64
	ConfNomic float64
}

type summarizeAttempt struct {
	label      string
	summarizer summarize.Summarizer
	opts       summarize.SummaryOpts
}

type ContinuityConfig struct {
	MinTurns           int
	TailBudgetTokens   int
	PriorContextTokens int
}

func CompactSession(
	ctx context.Context,
	st Store,
	extractive summarize.Summarizer,
	abstractive summarize.Summarizer,
	sessionID string,
	force bool,
	targetSize int,
	continuity ContinuityConfig,
) (Result, error) {
	if strings.TrimSpace(sessionID) == "" {
		return Result{}, fmt.Errorf("session ID is required")
	}
	if st == nil {
		return Result{}, fmt.Errorf("store is required")
	}
	if extractive == nil {
		return Result{}, fmt.Errorf("extractive summarizer is required")
	}
	if !extractive.Ready() {
		return Result{}, fmt.Errorf("extractive summarizer not ready: %s", extractive.Reason())
	}

	targetSize = normalizedTargetSize(targetSize)
	collection := "session:" + sessionID
	if err := st.EnsureLosslessSessionCollections(ctx, sessionID); err != nil {
		return Result{}, err
	}
	results, err := st.ListByMeta(ctx, collection, "sessionId", sessionID)
	if err != nil {
		return Result{}, err
	}
	priorSummaryResults, err := st.ListByMeta(ctx, store.SessionSummaryCollection(sessionID), "sessionId", sessionID)
	if err != nil {
		return Result{}, err
	}

	turns := eligibleTurns(results)
	priorSummaries := eligiblePriorSummaries(priorSummaryResults)
	if len(turns) < 2 {
		return Result{DidCompact: false}, nil
	}
	tail := selectRecentTail(turns, continuity)
	compactable := tail.older
	if len(compactable) < 2 {
		return Result{DidCompact: false}, nil
	}
	if !force && len(compactable) < targetSize {
		return Result{DidCompact: false}, nil
	}

	clusters := partitionChronological(compactable, targetSize)
	if len(clusters) == 0 {
		return Result{DidCompact: false}, nil
	}

	now := time.Now().UnixMilli()
	out := Result{
		ClustersFormed: len(clusters),
	}
	var totalConfidence float64
	replacedClusters := 0
	deonticFrame := astv2.NewDeonticFrame()

	for idx, group := range clusters {
		if len(group.turns) == 0 {
			continue
		}

		if len(group.turns) == 1 {
			out.ClustersDeclined++
			log.Printf("compaction: cluster_id=%d declined=strict-progress-singleton", idx)
			continue
		}

		protectedTurns, compressibleTurns := partitionProtectedTurns(ctx, group.turns, deonticFrame, canonicalEmbedder(extractive))

		if len(compressibleTurns) == 0 {
			sourceIDs := turnIDs(group.turns)
			if err := commitCompactionCluster(ctx, st, sessionID, now, protectedTurns, nil, summarize.Summary{}, qualityMetadata{}, priorContextSelection{}, sourceIDs); err != nil {
				return Result{}, fmt.Errorf("cluster %d protected shard compact commit failed: %w", idx, err)
			}
			out.TurnsRemoved += len(sourceIDs)
			totalConfidence += 1.0
			replacedClusters++
			out.SummaryMethod = mergeMethod(out.SummaryMethod, guidanceShardType)
			continue
		}

		summaryTurns := make([]summarize.Turn, 0, len(compressibleTurns))
		sourceIDs := make([]string, 0, len(compressibleTurns))
		for _, turn := range compressibleTurns {
			summaryTurns = append(summaryTurns, summarize.Turn{
				ID:   turn.id,
				Text: sanitizeContinuityText(turn.text),
			})
			sourceIDs = append(sourceIDs, turn.id)
		}

		summarizer, meanGating := routeSummarizer(group.turns, extractive, abstractive)
		priorContext := selectPriorCompactedContext(priorSummaries, group.turns, continuity)
		summary, quality, err := summarizeWithEscalation(ctx, extractive, summarizer, summaryTurns, group.turns, priorContext)
		if errors.Is(err, errStrictProgressDeclined) {
			out.ClustersDeclined++
			log.Printf("compaction: cluster_id=%d declined=strict-progress-after-escalation mean_gating_score=%.3f", idx, meanGating)
			continue
		}
		if err != nil {
			return Result{}, fmt.Errorf("cluster %d summarize failed: %w", idx, err)
		}
		log.Printf("compaction: cluster_id=%d mean_gating_score=%.3f summarizer_used=%s", idx, meanGating, summary.Method)

		summary.SourceIDs = append([]string(nil), sourceIDs...)
		allSourceIDs := turnIDs(group.turns)
		if err := commitCompactionCluster(ctx, st, sessionID, now, protectedTurns, compressibleTurns, summary, quality, priorContext, allSourceIDs); err != nil {
			return Result{}, fmt.Errorf("cluster %d compact commit failed: %w", idx, err)
		}
		out.TurnsRemoved += len(allSourceIDs)
		totalConfidence += summary.Confidence
		replacedClusters++
		out.SummaryMethod = mergeMethod(out.SummaryMethod, summary.Method)
	}

	out.DidCompact = replacedClusters > 0
	if replacedClusters > 0 {
		out.MeanConfidence = clamp01(totalConfidence / float64(replacedClusters))
	}
	return out, nil
}

func commitCompactionCluster(
	ctx context.Context,
	st Store,
	sessionID string,
	compactedAt int64,
	protectedTurns []turnRecord,
	compressibleTurns []turnRecord,
	summary summarize.Summary,
	quality qualityMetadata,
	prior priorContextSelection,
	deleteIDs []string,
) error {
	stateRecord, err := st.Get(ctx, store.SessionStateCollection(sessionID), sessionStateRecordKey)
	if err != nil {
		return err
	}
	stateMeta := cloneMeta(stateRecord.Metadata)
	stateMeta["updated_at"] = compactedAt
	stateMeta["last_compacted_at"] = compactedAt
	stateMeta["compaction_generation"] = metadataInt(stateRecord.Metadata, "compaction_generation") + 1
	stateMeta["last_summary_id"] = ""
	if summary.Text != "" {
		stateMeta["last_summary_id"] = summaryRecordID(sessionID, summary.SourceIDs)
	}

	return st.WithTx(ctx, func(tx store.TxWriter) error {
		for _, turn := range protectedTurns {
			targetCollection := elevatedGuidanceCollection(sessionID, []turnRecord{turn})
			if err := tx.InsertText(ctx, targetCollection, guidanceShardRecordID(sessionID, turn.id), strings.TrimSpace(turn.text), guidanceShardMetadata(sessionID, compactedAt, turn, strings.TrimSpace(turn.text))); err != nil {
				return err
			}
		}
		if summary.Text != "" {
			summaryCollection := store.SessionSummaryCollection(sessionID)
			summaryID := summaryRecordID(sessionID, summary.SourceIDs)
			if err := tx.InsertText(ctx, summaryCollection, summaryID, summary.Text, summaryMetadata(sessionID, compactedAt, summary, append([]turnRecord(nil), compressibleTurns...), quality, prior)); err != nil {
				return err
			}
			for idx, turn := range compressibleTurns {
				if err := tx.InsertRecord(ctx, store.SessionEdgeCollection(sessionID), coverageEdgeRecordID(summaryID, turn.id), []float32{0}, coverageEdgeMetadata(sessionID, compactedAt, summaryID, turn, idx)); err != nil {
					return err
				}
			}
		}
		return tx.UpdateRecordIfVersion(ctx, store.SessionStateCollection(sessionID), sessionStateRecordKey, []float32{0}, stateMeta, stateRecord.Version)
	})
}

func routeSummarizer(turns []turnRecord, extractive summarize.Summarizer, abstractive summarize.Summarizer) (summarize.Summarizer, float64) {
	meanGating := meanGatingScore(turns)
	if abstractive == nil || !abstractive.Ready() {
		return extractive, meanGating
	}
	if meanGating >= AbstractiveRoutingThreshold {
		return abstractive, meanGating
	}
	return extractive, meanGating
}

func summarizeWithEscalation(
	ctx context.Context,
	extractive summarize.Summarizer,
	primary summarize.Summarizer,
	summaryTurns []summarize.Turn,
	sourceTurns []turnRecord,
	priorContext priorContextSelection,
) (summarize.Summary, qualityMetadata, error) {
	attempts := buildSummarizeAttempts(extractive, primary)
	for _, attempt := range attempts {
		turns := applyPriorCompactedContext(summaryTurns, priorContext, attempt.summarizer)
		summary, err := attempt.summarizer.Summarize(ctx, turns, attempt.opts)
		if err != nil {
			return summarize.Summary{}, qualityMetadata{}, fmt.Errorf("%s summarize failed: %w", attempt.label, err)
		}
		quality, summary, err := finalizeSummaryQuality(ctx, extractive, attempt.summarizer, summaryTurns, summary)
		if err != nil {
			return summarize.Summary{}, qualityMetadata{}, fmt.Errorf("%s quality evaluation failed: %w", attempt.label, err)
		}
		if strings.TrimSpace(summary.Text) == "" {
			return summarize.Summary{}, qualityMetadata{}, fmt.Errorf("%s produced empty text", attempt.label)
		}
		if hasStrictCompactionProgress(sourceTurns, summary) {
			return summary, quality, nil
		}
	}
	return summarize.Summary{}, qualityMetadata{}, errStrictProgressDeclined
}

func buildSummarizeAttempts(extractive summarize.Summarizer, primary summarize.Summarizer) []summarizeAttempt {
	attempts := []summarizeAttempt{{
		label:      "primary",
		summarizer: primary,
		opts: summarize.SummaryOpts{
			MinInputTurns:   1,
			MaxOutputTokens: DefaultMaxOutputTokens,
		},
	}}

	primaryAggressive := summarizeAttempt{
		label:      "aggressive",
		summarizer: primary,
		opts: summarize.SummaryOpts{
			MinInputTurns:   1,
			MaxOutputTokens: DefaultMaxOutputTokens / 2,
			TargetDensity:   0.25,
		},
	}
	if primaryAggressive.opts.MaxOutputTokens < 16 {
		primaryAggressive.opts.MaxOutputTokens = 16
	}
	attempts = append(attempts, primaryAggressive)

	if extractive != nil && extractive.Ready() && primary != extractive {
		attempts = append(attempts, summarizeAttempt{
			label:      "deterministic-fallback",
			summarizer: extractive,
			opts: summarize.SummaryOpts{
				MinInputTurns:   1,
				MaxOutputTokens: 16,
				TargetDensity:   0.25,
			},
		})
	}
	return attempts
}

var errStrictProgressDeclined = errors.New("strict progress not achieved after escalation ladder")

func finalizeSummaryQuality(ctx context.Context, extractive summarize.Summarizer, used summarize.Summarizer, turns []summarize.Turn, summary summarize.Summary) (qualityMetadata, summarize.Summary, error) {
	e := canonicalEmbedder(extractive)
	if e == nil {
		return qualityMetadata{}, summary, nil
	}
	metrics, err := summarize.EvaluatePreservation(ctx, e, turns, summary.Text)
	if err != nil {
		return qualityMetadata{}, summarize.Summary{}, err
	}
	confNomic := clamp01((metrics.Align + metrics.Cover) / 2.0)
	confT5 := clamp01(summary.Confidence)

	if summary.Method == "onnx-t5" && !passesPreservationGate(metrics.Align) {
		fallback, err := extractive.Summarize(ctx, turns, summarize.SummaryOpts{
			MinInputTurns:   1,
			MaxOutputTokens: DefaultMaxOutputTokens,
		})
		if err != nil {
			return qualityMetadata{}, summarize.Summary{}, fmt.Errorf("preservation fallback summarize failed: %w", err)
		}
		fallbackMetrics, err := summarize.EvaluatePreservation(ctx, e, turns, fallback.Text)
		if err != nil {
			return qualityMetadata{}, summarize.Summary{}, fmt.Errorf("preservation fallback metrics failed: %w", err)
		}
		fallbackConf := clamp01((fallbackMetrics.Align + fallbackMetrics.Cover) / 2.0)
		fallback.Confidence = fallbackConf
		return qualityMetadata{
			Align:     fallbackMetrics.Align,
			Cover:     fallbackMetrics.Cover,
			ConfT5:    confT5,
			ConfNomic: fallbackConf,
		}, fallback, nil
	}

	if summary.Method == "onnx-t5" {
		summary.Confidence = clamp01(NomicConfidenceWeight*confNomic + (1.0-NomicConfidenceWeight)*confT5)
	} else {
		summary.Confidence = confNomic
	}
	_ = used
	return qualityMetadata{
		Align:     metrics.Align,
		Cover:     metrics.Cover,
		ConfT5:    confT5,
		ConfNomic: confNomic,
	}, summary, nil
}

func passesPreservationGate(align float64) bool {
	return align >= PreservationThreshold
}

func canonicalEmbedder(s summarize.Summarizer) embed.Embedder {
	provider, ok := s.(interface {
		CanonicalEmbedder() embed.Embedder
	})
	if !ok {
		return nil
	}
	return provider.CanonicalEmbedder()
}

func meanGatingScore(turns []turnRecord) float64 {
	if len(turns) == 0 {
		return 0.0
	}
	var sum float64
	for _, turn := range turns {
		sum += metaFloat(turn.metadata, "gating_score")
	}
	return clamp01(sum / float64(len(turns)))
}

func normalizedTargetSize(targetSize int) int {
	if targetSize <= 0 {
		return DefaultTargetSize
	}
	return targetSize
}

func trivialSummary(turn turnRecord) summarize.Summary {
	return summarize.Summary{
		Text:       strings.TrimSpace(turn.text),
		SourceIDs:  []string{turn.id},
		Method:     "trivial",
		TokenCount: len(strings.Fields(turn.text)),
		Confidence: 1.0,
	}
}

func hasStrictCompactionProgress(turns []turnRecord, summary summarize.Summary) bool {
	if len(turns) == 0 {
		return false
	}
	sourceTokens := turnTokenCostSum(turns)
	summaryTokens := summary.TokenCount
	if summaryTokens <= 0 {
		summaryTokens = EstimateTokens(summary.Text)
	}
	return summaryTokens < sourceTokens
}

func eligibleTurns(results []store.SearchResult) []turnRecord {
	turns := make([]turnRecord, 0, len(results))
	for _, result := range results {
		typed, ok := result.Metadata["type"].(string)
		if ok && (typed == "summary" || typed == guidanceShardType) {
			continue
		}

		turns = append(turns, turnRecord{
			id:       result.ID,
			text:     result.Text,
			metadata: cloneMeta(result.Metadata),
			ts:       metadataTimestamp(result.Metadata),
		})
	}

	sort.Slice(turns, func(i, j int) bool {
		if turns[i].ts == turns[j].ts {
			return turns[i].id < turns[j].id
		}
		return turns[i].ts < turns[j].ts
	})
	return turns
}

func partitionProtectedTurns(ctx context.Context, turns []turnRecord, frame *astv2.DeonticFrame, guidanceEmbedder embed.Embedder) ([]turnRecord, []turnRecord) {
	protected := make([]turnRecord, 0, len(turns))
	compressible := make([]turnRecord, 0, len(turns))
	for _, turn := range turns {
		if isProtectedGuidanceTurn(ctx, turn, frame, guidanceEmbedder) {
			protected = append(protected, turn)
			continue
		}
		compressible = append(compressible, turn)
	}
	return protected, compressible
}

// GuidanceEvalTrace records the per-gate decision trace for a single turn evaluated
// by the Tier 1.5 protection path. Used for debugging false positives and tuning.
type GuidanceEvalTrace struct {
	TurnText           string
	StabilityWeight    float64
	StabilityOK        bool
	SigmaPromoted      bool
	SigmaMask          uint8
	SurfaceHintMatched bool
	BoosterSimilarity  float64
	BoosterAdmitted    bool
	FinalAdmission     bool
	AdmissionPath      string // "sigma", "booster", or "none"
}

// evaluateProtectedGuidanceTurn is the internal evaluator that returns both the
// boolean decision and the full trace struct. Production callers use the bool;
// tests assert on the trace.
func evaluateProtectedGuidanceTurn(ctx context.Context, turn turnRecord, frame *astv2.DeonticFrame, guidanceEmbedder embed.Embedder) (bool, GuidanceEvalTrace) {
	text := strings.TrimSpace(turn.text)
	stability := stabilityWeight(turn.metadata)

	trace := GuidanceEvalTrace{
		TurnText:        text,
		StabilityWeight: stability,
	}

	if frame == nil || text == "" {
		trace.AdmissionPath = "none"
		return false, trace
	}

	trace.StabilityOK = stability >= ElevatedGuidanceMinStability
	if !trace.StabilityOK {
		trace.AdmissionPath = "none"
		return false, trace
	}

	eval := frame.EvaluateText([]byte(text))
	trace.SigmaPromoted = eval.Promoted
	trace.SigmaMask = uint8(eval.Mask)

	if eval.Promoted {
		trace.FinalAdmission = true
		trace.AdmissionPath = "sigma"
		return true, trace
	}

	trace.SurfaceHintMatched = hasGuidanceSurfaceHint(text)
	if !trace.SurfaceHintMatched {
		trace.AdmissionPath = "none"
		trace.FinalAdmission = false
		return false, trace
	}

	sim := semanticGuidanceBooster(ctx, guidanceEmbedder, text)
	trace.BoosterSimilarity = sim
	trace.BoosterAdmitted = sim >= ElevatedGuidanceBoosterFloor

	if trace.BoosterAdmitted {
		trace.FinalAdmission = true
		trace.AdmissionPath = "booster"
		return true, trace
	}

	trace.AdmissionPath = "none"
	trace.FinalAdmission = false
	return false, trace
}

// isProtectedGuidanceTurn is the production boolean gate. Internally it calls
// evaluateProtectedGuidanceTurn and discards the trace.
func isProtectedGuidanceTurn(ctx context.Context, turn turnRecord, frame *astv2.DeonticFrame, guidanceEmbedder embed.Embedder) bool {
	ok, _ := evaluateProtectedGuidanceTurn(ctx, turn, frame, guidanceEmbedder)
	return ok
}

func persistProtectedGuidanceShards(
	ctx context.Context,
	st Store,
	_ string,
	sessionID string,
	turns []turnRecord,
	compactedAt int64,
) ([]string, error) {
	if len(turns) == 0 {
		return nil, nil
	}

	targetCollection := elevatedGuidanceCollection(sessionID, turns)
	inserted := make([]string, 0, len(turns))
	for _, turn := range turns {
		id := guidanceShardRecordID(sessionID, turn.id)
		text := strings.TrimSpace(turn.text)
		meta := guidanceShardMetadata(sessionID, compactedAt, turn, text)
		if err := st.InsertText(ctx, targetCollection, id, text, meta); err != nil {
			rollbackShardInserts(ctx, st, targetCollection, inserted)
			return nil, err
		}
		inserted = append(inserted, id)
	}
	return inserted, nil
}

func rollbackShardInserts(ctx context.Context, st Store, collection string, ids []string) {
	if len(ids) == 0 {
		return
	}
	if err := st.DeleteBatch(ctx, collection, ids); err != nil {
		log.Printf("compaction: protected shard rollback failed: %v", err)
	}
}

func turnIDs(turns []turnRecord) []string {
	ids := make([]string, 0, len(turns))
	for _, turn := range turns {
		ids = append(ids, turn.id)
	}
	return ids
}

func guidanceShardRecordID(sessionID, sourceTurnID string) string {
	return fmt.Sprintf("guidance:%s:%s", sessionID, sourceTurnID)
}

func coverageEdgeRecordID(parentSummaryID, childID string) string {
	return fmt.Sprintf("edge:%s:%s", parentSummaryID, childID)
}

func guidanceShardMetadata(sessionID string, compactedAt int64, turn turnRecord, text string) map[string]any {
	stability := stabilityWeight(turn.metadata)
	meta := map[string]any{
		"type":                guidanceShardType,
		"ts":                  compactedAt,
		"sessionId":           sessionID,
		"source_turn_id":      turn.id,
		"source_turn_ts":      turn.ts,
		"token_count":         EstimateTokens(text),
		"token_estimate":      EstimateTokens(text),
		"elevated_guidance":   true,
		"protection_reason":   "deontic_surface",
		"guidance_confidence": 1.0,
		"authority":           stability,
		"stability_weight":    stability,
		"provenance_class":    turnMetaString(turn.metadata, "provenance_class"),
	}
	for key, value := range turn.metadata {
		switch key {
		case "sessionId", "ts", "type", "token_count", "token_estimate":
			continue
		case "userId", "role":
			meta[key] = value
		}
	}
	return meta
}

func coverageEdgeMetadata(sessionID string, compactedAt int64, parentSummaryID string, turn turnRecord, edgeOrder int) map[string]any {
	childCollection := store.SessionRawCollection(sessionID)
	childType := "turn"
	if turnMetaString(turn.metadata, "type") == "summary" {
		childCollection = store.SessionSummaryCollection(sessionID)
		childType = "summary"
	}
	meta := map[string]any{
		"type":              "coverage_edge",
		"ts":                compactedAt,
		"sessionId":         sessionID,
		"parent_summary_id": parentSummaryID,
		"child_id":          turn.id,
		"child_type":        childType,
		"child_collection":  childCollection,
		"child_ts":          turn.ts,
		"edge_order":        edgeOrder,
		"compacted_at":      compactedAt,
	}
	if userID, ok := turn.metadata["userId"]; ok && userID != nil {
		meta["userId"] = userID
	}
	return meta
}

func elevatedGuidanceCollection(sessionID string, turns []turnRecord) string {
	for _, turn := range turns {
		userID := turnMetaString(turn.metadata, "userId")
		if userID != "" {
			return "elevated:user:" + userID
		}
	}
	return "elevated:session:" + sessionID
}

func stabilityWeight(meta map[string]any) float64 {
	if meta == nil {
		return 0
	}
	if raw, ok := meta["stability_weight"]; ok {
		return clamp01(metaFloat(map[string]any{"value": raw}, "value"))
	}
	return 0
}

func hasGuidanceSurfaceHint(text string) bool {
	return guidanceSurfaceHintPattern.MatchString(text)
}

func semanticGuidanceBooster(ctx context.Context, e embed.Embedder, text string) float64 {
	if e == nil || strings.TrimSpace(text) == "" {
		return 0
	}
	docVec, err := e.EmbedDocument(ctx, text)
	if err != nil {
		return 0
	}
	best := 0.0
	for _, prototype := range guidancePrototypeTexts {
		protoVec, err := e.EmbedDocument(ctx, prototype)
		if err != nil {
			continue
		}
		if score := clamp01(cosine(docVec, protoVec)); score > best {
			best = score
		}
	}
	return best
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

func eligiblePriorSummaries(results []store.SearchResult) []priorSummaryRecord {
	out := make([]priorSummaryRecord, 0, len(results))
	for _, result := range results {
		typed, _ := result.Metadata["type"].(string)
		if typed != "summary" {
			continue
		}
		out = append(out, priorSummaryRecord{
			id:         result.ID,
			text:       sanitizeContinuityText(result.Text),
			tokenCount: metadataInt(result.Metadata, "token_count"),
			ts:         metadataTimestamp(result.Metadata),
		})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].ts == out[j].ts {
			return out[i].id < out[j].id
		}
		return out[i].ts < out[j].ts
	})
	return out
}

func partitionChronological(turns []turnRecord, targetSize int) []cluster {
	if len(turns) == 0 {
		return nil
	}
	targetSize = normalizedTargetSize(targetSize)
	clusterCount := int(math.Ceil(float64(len(turns)) / float64(targetSize)))
	if clusterCount < 1 {
		clusterCount = 1
	}

	clusters := make([]cluster, clusterCount)
	for i, turn := range turns {
		index := i * clusterCount / len(turns)
		clusters[index].turns = append(clusters[index].turns, turn)
	}

	out := make([]cluster, 0, len(clusters))
	for _, group := range clusters {
		if len(group.turns) > 0 {
			out = append(out, group)
		}
	}
	return out
}

func selectPriorCompactedContext(prior []priorSummaryRecord, turns []turnRecord, cfg ContinuityConfig) priorContextSelection {
	if len(prior) == 0 || len(turns) == 0 {
		return priorContextSelection{}
	}
	limit := cfg.PriorContextTokens
	if limit <= 0 {
		limit = DefaultContinuityPriorTokens
	}
	clusterStart := turns[0].ts
	selected := make([]priorSummaryRecord, 0, 2)
	used := 0
	for i := len(prior) - 1; i >= 0; i-- {
		item := prior[i]
		if item.ts >= clusterStart {
			continue
		}
		tokens := item.tokenCount
		if tokens <= 0 {
			tokens = EstimateTokens(item.text)
		}
		if tokens <= 0 || used+tokens > limit {
			continue
		}
		selected = append(selected, item)
		used += tokens
	}
	if len(selected) == 0 {
		return priorContextSelection{}
	}
	sort.Slice(selected, func(i, j int) bool {
		if selected[i].ts == selected[j].ts {
			return selected[i].id < selected[j].id
		}
		return selected[i].ts < selected[j].ts
	})
	parts := make([]string, 0, len(selected))
	ids := make([]string, 0, len(selected))
	for _, item := range selected {
		ids = append(ids, item.id)
		parts = append(parts, item.text)
	}
	return priorContextSelection{
		summaryIDs: ids,
		text:       strings.TrimSpace(strings.Join(parts, "\n\n")),
		tokens:     used,
	}
}

func applyPriorCompactedContext(turns []summarize.Turn, prior priorContextSelection, summarizer summarize.Summarizer) []summarize.Turn {
	if len(turns) == 0 || len(prior.summaryIDs) == 0 || strings.TrimSpace(prior.text) == "" {
		return turns
	}
	if summarizer == nil || summarizer.Mode() == "extractive" {
		return turns
	}
	out := make([]summarize.Turn, 0, len(turns)+1)
	out = append(out, summarize.Turn{
		ID:   "__continuity_prior__",
		Text: "Prior compacted context:\n" + prior.text,
	})
	out = append(out, turns...)
	return out
}

type recentTailSelection struct {
	older  []turnRecord
	base   []turnRecord
	recent []turnRecord
}

func selectRecentTail(turns []turnRecord, cfg ContinuityConfig) recentTailSelection {
	if len(turns) == 0 {
		return recentTailSelection{}
	}
	minTurns := cfg.MinTurns
	if minTurns <= 0 {
		return recentTailSelection{
			older: append([]turnRecord(nil), turns...),
		}
	}
	tailBudget := cfg.TailBudgetTokens
	if tailBudget <= 0 {
		tailBudget = DefaultContinuityTailTokens
	}
	baseStart := len(turns) - minTurns
	if baseStart < 0 {
		baseStart = 0
	}
	base := append([]turnRecord(nil), turns[baseStart:]...)
	baseTokens := turnTokenCostSum(base)
	if baseTokens > tailBudget {
		recentStart := extendTurnBundleBoundary(turns, baseStart)
		return recentTailSelection{
			older:  append([]turnRecord(nil), turns[:recentStart]...),
			base:   base,
			recent: append([]turnRecord(nil), turns[recentStart:]...),
		}
	}

	start := baseStart
	used := baseTokens
	for i := baseStart - 1; i >= 0; i-- {
		next := estimateTurnTokens(turns[i])
		if used+next > tailBudget {
			break
		}
		used += next
		start = i
	}
	start = extendTurnBundleBoundary(turns, start)

	return recentTailSelection{
		older:  append([]turnRecord(nil), turns[:start]...),
		base:   base,
		recent: append([]turnRecord(nil), turns[start:]...),
	}
}

func turnTokenCostSum(turns []turnRecord) int {
	sum := 0
	for _, turn := range turns {
		sum += estimateTurnTokens(turn)
	}
	return sum
}

func estimateTurnTokens(turn turnRecord) int {
	return EstimateTokens(turn.text)
}

func extendTurnBundleBoundary(turns []turnRecord, start int) int {
	for start > 0 && coupledTurnBundle(turns[start-1], turns[start]) {
		start--
	}
	return start
}

func coupledTurnBundle(left, right turnRecord) bool {
	if leftBundle, rightBundle := turnMetaString(left.metadata, "continuity_bundle_id"), turnMetaString(right.metadata, "continuity_bundle_id"); leftBundle != "" && leftBundle == rightBundle {
		return true
	}
	leftRole := turnMetaString(left.metadata, "role")
	rightRole := turnMetaString(right.metadata, "role")
	return (leftRole == "user" && rightRole == "assistant") || (leftRole == "assistant" && rightRole == "user")
}

func turnMetaString(meta map[string]any, key string) string {
	if meta == nil {
		return ""
	}
	value, ok := meta[key]
	if !ok {
		return ""
	}
	typed, ok := value.(string)
	if !ok {
		return ""
	}
	return typed
}

func summaryMetadata(sessionID string, compactedAt int64, summary summarize.Summary, turns []turnRecord, quality qualityMetadata, prior priorContextSelection) map[string]any {
	lineage := continuityLineage(summary, turns, compactedAt, prior)
	meta := map[string]any{
		"type":               "summary",
		"ts":                 compactedAt,
		"sessionId":          sessionID,
		"source_ids":         append([]string(nil), summary.SourceIDs...),
		"method":             summary.Method,
		"token_count":        summary.TokenCount,
		"confidence":         clamp01(summary.Confidence),
		"compacted_at":       compactedAt,
		"decay_rate":         clamp01(1.0 - summary.Confidence),
		"continuity_lineage": lineage,
	}
	if len(prior.summaryIDs) > 0 {
		meta["continuity_support_summary_ids"] = append([]string(nil), prior.summaryIDs...)
		meta["continuity_support_tokens"] = prior.tokens
	}
	if quality.Align != 0 || quality.Cover != 0 || quality.ConfT5 != 0 || quality.ConfNomic != 0 {
		meta["nomic_align"] = quality.Align
		meta["nomic_cover"] = quality.Cover
		meta["confidence_nomic"] = quality.ConfNomic
		if summary.Method == "onnx-t5" || quality.ConfT5 > 0 {
			meta["confidence_t5"] = quality.ConfT5
		}
	}

	for _, turn := range turns {
		if userID, ok := turn.metadata["userId"]; ok && userID != nil {
			meta["userId"] = userID
			break
		}
	}
	return meta
}

func continuityLineage(summary summarize.Summary, turns []turnRecord, compactedAt int64, prior priorContextSelection) map[string]any {
	sourceIDs := append([]string(nil), summary.SourceIDs...)
	sourceTurnIDs := make([]string, 0, len(turns))
	parentSummaryIDs := make([]string, 0, len(turns))
	var sourceMinTS int64
	var sourceMaxTS int64
	for idx, turn := range turns {
		if idx == 0 || turn.ts < sourceMinTS {
			sourceMinTS = turn.ts
		}
		if idx == 0 || turn.ts > sourceMaxTS {
			sourceMaxTS = turn.ts
		}
		if turnMetaString(turn.metadata, "type") == "summary" {
			parentSummaryIDs = append(parentSummaryIDs, turn.id)
			continue
		}
		sourceTurnIDs = append(sourceTurnIDs, turn.id)
	}
	lineage := map[string]any{
		"source_ids":         sourceIDs,
		"source_turn_ids":    sourceTurnIDs,
		"parent_summary_ids": parentSummaryIDs,
		"source_ts_min":      sourceMinTS,
		"source_ts_max":      sourceMaxTS,
		"compacted_at":       compactedAt,
		"method":             summary.Method,
		"confidence":         clamp01(summary.Confidence),
	}
	if len(prior.summaryIDs) > 0 {
		lineage["support_summary_ids"] = append([]string(nil), prior.summaryIDs...)
		lineage["support_tokens"] = prior.tokens
	}
	return lineage
}

func sanitizeContinuityText(text string) string {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return trimmed
	}

	sanitized := replaceLargeFencedBlocks(trimmed)
	sanitized = replaceOpaquePayloadLines(sanitized)
	sanitized = collapseBlankLines(sanitized)
	sanitized = strings.TrimSpace(sanitized)
	if sanitized == "" {
		return "[sanitized continuity payload]"
	}
	return sanitized
}

func replaceLargeFencedBlocks(text string) string {
	lines := strings.Split(text, "\n")
	var out []string
	for i := 0; i < len(lines); {
		line := lines[i]
		if !strings.HasPrefix(strings.TrimSpace(line), "```") {
			out = append(out, line)
			i++
			continue
		}

		start := i
		i++
		for i < len(lines) && !strings.HasPrefix(strings.TrimSpace(lines[i]), "```") {
			i++
		}
		end := i
		if i < len(lines) {
			i++
		}

		blockLines := lines[start:i]
		blockText := strings.Join(blockLines, "\n")
		innerLineCount := max(0, end-start-1)
		if len(blockText) >= 240 || innerLineCount >= 8 {
			out = append(out, "[sanitized fenced payload omitted for continuity]")
			continue
		}
		out = append(out, blockLines...)
	}
	return strings.Join(out, "\n")
}

func replaceOpaquePayloadLines(text string) string {
	lines := strings.Split(text, "\n")
	for idx, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		if strings.HasPrefix(trimmed, "data:") && len(trimmed) >= 64 {
			lines[idx] = "[sanitized transport payload omitted for continuity]"
			continue
		}
		if len(trimmed) >= 96 && (longBase64ishTokenPattern.MatchString(trimmed) || longHexTokenPattern.MatchString(trimmed)) {
			lines[idx] = "[sanitized opaque payload omitted for continuity]"
		}
	}
	return strings.Join(lines, "\n")
}

func collapseBlankLines(text string) string {
	lines := strings.Split(text, "\n")
	out := make([]string, 0, len(lines))
	previousBlank := false
	for _, line := range lines {
		blank := strings.TrimSpace(line) == ""
		if blank && previousBlank {
			continue
		}
		out = append(out, line)
		previousBlank = blank
	}
	return strings.Join(out, "\n")
}

func summaryRecordID(sessionID string, sourceIDs []string) string {
	hash := sha256.Sum256([]byte(sessionID + ":" + strings.Join(sourceIDs, ",")))
	return "summary:" + hex.EncodeToString(hash[:8])
}

func metadataTimestamp(meta map[string]any) int64 {
	value, ok := meta["ts"]
	if !ok {
		return 0
	}
	switch typed := value.(type) {
	case int:
		return int64(typed)
	case int64:
		return typed
	case int32:
		return int64(typed)
	case float64:
		return int64(typed)
	case float32:
		return int64(typed)
	case jsonNumber:
		n, _ := typed.Int64()
		return n
	case string:
		n, err := strconv.ParseInt(typed, 10, 64)
		if err == nil {
			return n
		}
	}
	return 0
}

func metadataInt(meta map[string]any, key string) int {
	value, ok := meta[key]
	if !ok {
		return 0
	}
	switch typed := value.(type) {
	case int:
		return typed
	case int64:
		return int(typed)
	case int32:
		return int(typed)
	case float64:
		return int(typed)
	case float32:
		return int(typed)
	case jsonNumber:
		n, err := typed.Int64()
		if err == nil {
			return int(n)
		}
	case string:
		n, err := strconv.Atoi(strings.TrimSpace(typed))
		if err == nil {
			return n
		}
	}
	return 0
}

func metaFloat(meta map[string]any, key string) float64 {
	value, ok := meta[key]
	if !ok {
		return 0.0
	}
	switch typed := value.(type) {
	case float64:
		return typed
	case float32:
		return float64(typed)
	case int:
		return float64(typed)
	case int64:
		return float64(typed)
	case int32:
		return float64(typed)
	case string:
		n, err := strconv.ParseFloat(strings.TrimSpace(typed), 64)
		if err == nil {
			return n
		}
	}
	return 0.0
}

type jsonNumber interface {
	Int64() (int64, error)
}

func cloneMeta(src map[string]any) map[string]any {
	if src == nil {
		return map[string]any{}
	}
	dst := make(map[string]any, len(src))
	for k, v := range src {
		dst[k] = v
	}
	return dst
}

func mergeMethod(current, next string) string {
	switch {
	case current == "":
		return next
	case current == next:
		return current
	default:
		return "mixed"
	}
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
