package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
)

const (
	DreamCollectionPrefix      = "dream:"
	dreamPromotionMinScore     = 0.6
	dreamPromotionMinRecall    = 2
	dreamPromotionMinUnique    = 2
	dreamPromotionMinTextBytes = 16
)

type DreamSourceMetadata struct {
	SourceRoot    string
	SourcePath    string
	SourceKind    string
	FileHash      string
	SourceSize    int64
	SourceMtimeMs int64
	IngestVersion int
	HashBackend   string
}

type DreamPromotionEntry struct {
	Text          string         `json:"text"`
	Score         float64        `json:"score"`
	RecallCount   int            `json:"recallCount"`
	UniqueQueries int            `json:"uniqueQueries"`
	Section       string         `json:"section,omitempty"`
	Line          int            `json:"line,omitempty"`
	Metadata      map[string]any `json:"metadata,omitempty"`
}

type DreamPromotionResult struct {
	Promoted int `json:"promoted"`
	Rejected int `json:"rejected"`
}

func DreamCollection(userID string) string {
	return DreamCollectionPrefix + strings.TrimSpace(userID)
}

func (s *Store) PromoteDreamEntries(ctx context.Context, userID, sourceDoc string, sourceMeta DreamSourceMetadata, entries []DreamPromotionEntry) (DreamPromotionResult, error) {
	userID = strings.TrimSpace(userID)
	sourceDoc = strings.TrimSpace(sourceDoc)
	if userID == "" {
		return DreamPromotionResult{}, errors.New("user ID is required")
	}
	if sourceDoc == "" {
		return DreamPromotionResult{}, errors.New("dream source doc is required")
	}

	collection := DreamCollection(userID)
	valid := make([]DreamPromotionEntry, 0, len(entries))
	result := DreamPromotionResult{}
	for _, entry := range entries {
		if !dreamPromotionEligible(entry) {
			result.Rejected++
			continue
		}
		valid = append(valid, entry)
	}
	if len(valid) == 0 {
		return result, nil
	}

	if err := s.EnsureCollection(ctx, collection); err != nil {
		return result, err
	}

	existing, err := s.ListByMeta(ctx, collection, "source_doc", sourceDoc)
	if err != nil {
		return result, err
	}
	existingIDs := make([]string, 0, len(existing))
	for _, record := range existing {
		existingIDs = append(existingIDs, record.ID)
	}

	now := time.Now().UnixMilli()
	if err := s.WithTx(ctx, func(tx TxWriter) error {
		if len(existingIDs) > 0 {
			if err := tx.DeleteBatch(ctx, collection, existingIDs); err != nil {
				return err
			}
		}
		for i, entry := range valid {
			meta := dreamMetadata(sourceDoc, sourceMeta, entry, now)
			id := dreamRecordID(sourceDoc, i)
			if err := tx.InsertText(ctx, collection, id, entry.Text, meta); err != nil {
				return err
			}
			result.Promoted++
		}
		return nil
	}); err != nil {
		return DreamPromotionResult{}, err
	}

	return result, nil
}

func dreamPromotionEligible(entry DreamPromotionEntry) bool {
	if strings.TrimSpace(entry.Text) == "" {
		return false
	}
	if len(strings.TrimSpace(entry.Text)) < dreamPromotionMinTextBytes {
		return false
	}
	if entry.Score < dreamPromotionMinScore {
		return false
	}
	if entry.RecallCount < dreamPromotionMinRecall {
		return false
	}
	if entry.UniqueQueries < dreamPromotionMinUnique {
		return false
	}
	return true
}

func dreamRecordID(sourceDoc string, ordinal int) string {
	return fmt.Sprintf("%s#dream#%06d", sourceDoc, ordinal)
}

func dreamMetadata(sourceDoc string, sourceMeta DreamSourceMetadata, entry DreamPromotionEntry, promotedAt int64) map[string]any {
	meta := map[string]any{
		"source_doc":           sourceDoc,
		"source_root":          sourceMeta.SourceRoot,
		"source_path":          sourceMeta.SourcePath,
		"source_kind":          sourceMeta.SourceKind,
		"file_hash":            sourceMeta.FileHash,
		"source_size":          sourceMeta.SourceSize,
		"source_mtime_ms":      sourceMeta.SourceMtimeMs,
		"ingest_version":       sourceMeta.IngestVersion,
		"hash_backend":         sourceMeta.HashBackend,
		"source_type":          "dream",
		"dream_score":          entry.Score,
		"dream_recall_count":   entry.RecallCount,
		"dream_unique_queries": entry.UniqueQueries,
		"dream_section":        entry.Section,
		"dream_line":           entry.Line,
		"dream_promoted_at":    promotedAt,
		"authored":             true,
		"type":                 "dream_promotion",
		"access_count":         0,
	}
	if entry.Metadata != nil {
		for key, value := range entry.Metadata {
			if key == "" {
				continue
			}
			meta[key] = value
		}
	}
	meta["source_doc"] = sourceDoc
	meta["source_root"] = sourceMeta.SourceRoot
	meta["source_path"] = sourceMeta.SourcePath
	meta["source_kind"] = sourceMeta.SourceKind
	meta["file_hash"] = sourceMeta.FileHash
	meta["source_size"] = sourceMeta.SourceSize
	meta["source_mtime_ms"] = sourceMeta.SourceMtimeMs
	meta["ingest_version"] = sourceMeta.IngestVersion
	meta["hash_backend"] = sourceMeta.HashBackend
	meta["source_type"] = "dream"
	meta["dream_score"] = entry.Score
	meta["dream_recall_count"] = entry.RecallCount
	meta["dream_unique_queries"] = entry.UniqueQueries
	meta["dream_section"] = entry.Section
	meta["dream_line"] = entry.Line
	meta["dream_promoted_at"] = promotedAt
	meta["authored"] = true
	meta["type"] = "dream_promotion"
	meta["access_count"] = 0
	return meta
}
