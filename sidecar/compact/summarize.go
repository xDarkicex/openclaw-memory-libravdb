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

	"github.com/xDarkicex/openclaw-memory-libravdb/sidecar/store"
	"github.com/xDarkicex/openclaw-memory-libravdb/sidecar/summarize"
)

const (
	DefaultTargetSize     = 20
	DefaultMaxOutputTokens = 64
	AbstractiveRoutingThreshold = 0.60
)

type Store interface {
	ListByMeta(ctx context.Context, collection, key, value string) ([]store.SearchResult, error)
	InsertText(ctx context.Context, collection, id, text string, meta map[string]any) error
	DeleteBatch(ctx context.Context, collection string, ids []string) error
}

type Result struct {
	DidCompact     bool    `json:"didCompact"`
	ClustersFormed int     `json:"clustersFormed"`
	TurnsRemoved   int     `json:"turnsRemoved"`
	SummaryMethod  string  `json:"summaryMethod,omitempty"`
	MeanConfidence float64 `json:"meanConfidence"`
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

func CompactSession(
	ctx context.Context,
	st Store,
	extractive summarize.Summarizer,
	abstractive summarize.Summarizer,
	sessionID string,
	force bool,
	targetSize int,
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
	if !force && len(turns) < targetSize {
		return Result{DidCompact: false}, nil
	}

	clusters := partitionChronological(turns, targetSize)
	if len(clusters) == 0 {
		return Result{DidCompact: false}, nil
	}

	now := time.Now().UnixMilli()
	out := Result{
		DidCompact:     true,
		ClustersFormed: len(clusters),
	}
	var totalConfidence float64

	for idx, group := range clusters {
		if len(group.turns) == 0 {
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
		log.Printf("compaction: cluster_id=%d mean_gating_score=%.3f summarizer_used=%s", idx, meanGating, summarizer.Mode())

		summary, err := summarizer.Summarize(ctx, summaryTurns, summarize.SummaryOpts{
			MinInputTurns:   1,
			MaxOutputTokens: DefaultMaxOutputTokens,
		})
		if err != nil {
			return Result{}, fmt.Errorf("cluster %d summarize failed: %w", idx, err)
		}
		if strings.TrimSpace(summary.Text) == "" {
			return Result{}, fmt.Errorf("cluster %d summarize produced empty text", idx)
		}

		summary.SourceIDs = append([]string(nil), sourceIDs...)

		metadata := summaryMetadata(sessionID, now, summary, group.turns)
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
		out.SummaryMethod = mergeMethod(out.SummaryMethod, summary.Method)
	}

	if out.ClustersFormed > 0 {
		out.MeanConfidence = clamp01(totalConfidence / float64(out.ClustersFormed))
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

func summaryMetadata(sessionID string, compactedAt int64, summary summarize.Summary, turns []turnRecord) map[string]any {
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
