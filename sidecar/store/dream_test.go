package store

import (
	"context"
	"path/filepath"
	"testing"
)

func TestPromoteDreamEntriesWritesIsolatedDreamCollection(t *testing.T) {
	ctx := context.Background()
	s, err := Open(filepath.Join(t.TempDir(), "store.libravdb"), fakeEmbedder{})
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}

	result, err := s.PromoteDreamEntries(ctx, "u1", "/tmp/DREAMS.md", DreamSourceMetadata{
		SourceRoot:    "/tmp",
		SourcePath:    "DREAMS.md",
		SourceKind:    "dream",
		FileHash:      "abc123",
		SourceSize:    512,
		SourceMtimeMs: 123456789,
		IngestVersion: 1,
		HashBackend:   "wasm-fnv1a64",
	}, []DreamPromotionEntry{
		{
			Text:          "Preserve the recent tail when promoting.",
			Score:         0.82,
			RecallCount:   3,
			UniqueQueries: 2,
			Section:       "deep sleep",
			Line:          12,
		},
		{
			Text:          "too weak to promote",
			Score:         0.2,
			RecallCount:   1,
			UniqueQueries: 1,
			Section:       "deep sleep",
			Line:          14,
		},
	})
	if err != nil {
		t.Fatalf("PromoteDreamEntries() error = %v", err)
	}
	if result.Promoted != 1 || result.Rejected != 1 {
		t.Fatalf("unexpected promote result: %+v", result)
	}

	listed, err := s.ListCollection(ctx, DreamCollection("u1"))
	if err != nil {
		t.Fatalf("ListCollection() error = %v", err)
	}
	if len(listed) != 1 {
		t.Fatalf("expected one promoted dream entry, got %+v", listed)
	}
	if got := listed[0].Metadata["source_kind"]; got != "dream" {
		t.Fatalf("source_kind = %+v, want dream", got)
	}
	if got := listed[0].Metadata["source_doc"]; got != "/tmp/DREAMS.md" {
		t.Fatalf("source_doc = %+v, want /tmp/DREAMS.md", got)
	}
	if got := listed[0].Metadata["dream_score"]; got != 0.82 {
		t.Fatalf("dream_score = %+v, want 0.82", got)
	}
}

func TestPromoteDreamEntriesRejectsMissingProvenance(t *testing.T) {
	ctx := context.Background()
	s, err := Open(filepath.Join(t.TempDir(), "store.libravdb"), fakeEmbedder{})
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}

	if _, err := s.PromoteDreamEntries(ctx, "", "/tmp/DREAMS.md", DreamSourceMetadata{}, nil); err == nil {
		t.Fatalf("expected missing user id to error")
	}
	if _, err := s.PromoteDreamEntries(ctx, "u1", "", DreamSourceMetadata{}, nil); err == nil {
		t.Fatalf("expected missing source doc to error")
	}
}
