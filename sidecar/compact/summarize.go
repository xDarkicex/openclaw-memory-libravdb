package compact

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/xDarkicex/openclaw-memory-libravdb/sidecar/embed"
	"github.com/xDarkicex/openclaw-memory-libravdb/sidecar/store"
	"github.com/xDarkicex/openclaw-memory-libravdb/sidecar/summarize"
)

const (
	DefaultTargetSize           = 20
	DefaultMaxOutputTokens      = 64
	AbstractiveRoutingThreshold = 0.60
	PreservationThreshold       = 0.65
	NomicConfidenceWeight       = 0.80
	DefaultContinuityMinTurns   = 4
	DefaultContinuityTailTokens = 128
)

type Store interface {
	ListByMeta(ctx context.Context, collection, key, value string) ([]store.SearchResult, error)
	InsertText(ctx context.Context, collection, id, text string, meta map[string]any) error
	DeleteBatch(ctx context.Context, collection string, ids []string) error
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

type ContinuityConfig struct {
	MinTurns         int
	TailBudgetTokens int
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
	results, err := st.ListByMeta(ctx, collection, "sessionId", sessionID)
	if err != nil {
		return Result{}, err
	}

	turns := eligibleTurns(results)
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

	for idx, group := range clusters {
		if len(group.turns) == 0 {
			continue
		}

		if len(group.turns) == 1 {
			out.ClustersDeclined++
			log.Printf("compaction: cluster_id=%d declined=strict-progress-singleton", idx)
			continue
		}

		summaryTurns := make([]summarize.Turn, 0, len(group.turns))
		sourceIDs := make([]string, 0, len(group.turns))
		for _, turn := range group.turns {
			summaryTurns = append(summaryTurns, summarize.Turn{
				ID:   turn.id,
				Text: turn.text,
			})
			sourceIDs = append(sourceIDs, turn.id)
		}

		summarizer, meanGating := routeSummarizer(group.turns, extractive, abstractive)

		summary, err := summarizer.Summarize(ctx, summaryTurns, summarize.SummaryOpts{
			MinInputTurns:   1,
			MaxOutputTokens: DefaultMaxOutputTokens,
		})
		if err != nil {
			return Result{}, fmt.Errorf("cluster %d summarize failed: %w", idx, err)
		}
		quality, summary, err := finalizeSummaryQuality(ctx, extractive, summarizer, summaryTurns, summary)
		if err != nil {
			return Result{}, fmt.Errorf("cluster %d quality evaluation failed: %w", idx, err)
		}
		log.Printf("compaction: cluster_id=%d mean_gating_score=%.3f summarizer_used=%s", idx, meanGating, summary.Method)
		if strings.TrimSpace(summary.Text) == "" {
			return Result{}, fmt.Errorf("cluster %d summarize produced empty text", idx)
		}

		summary.SourceIDs = append([]string(nil), sourceIDs...)
		if !hasStrictCompactionProgress(group.turns, summary) {
			out.ClustersDeclined++
			log.Printf("compaction: cluster_id=%d declined=strict-progress mean_gating_score=%.3f summarizer_used=%s", idx, meanGating, summary.Method)
			continue
		}

		metadata := summaryMetadata(sessionID, now, summary, group.turns, quality)
		summaryID := summaryRecordID(sessionID, summary.SourceIDs)
		if err := st.InsertText(ctx, collection, summaryID, summary.Text, metadata); err != nil {
			return Result{}, fmt.Errorf("summary insert failed, source turns preserved: %w", err)
		}

		if err := st.DeleteBatch(ctx, collection, summary.SourceIDs); err != nil {
			log.Printf("compaction: summary %s inserted but source delete failed: %v", summaryID, err)
		} else {
			out.TurnsRemoved += len(summary.SourceIDs)
		}

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
		if ok && typed == "summary" {
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

func summaryMetadata(sessionID string, compactedAt int64, summary summarize.Summary, turns []turnRecord, quality qualityMetadata) map[string]any {
	meta := map[string]any{
		"type":         "summary",
		"ts":           compactedAt,
		"sessionId":    sessionID,
		"source_ids":   append([]string(nil), summary.SourceIDs...),
		"method":       summary.Method,
		"token_count":  summary.TokenCount,
		"confidence":   clamp01(summary.Confidence),
		"compacted_at": compactedAt,
		"decay_rate":   clamp01(1.0 - summary.Confidence),
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
