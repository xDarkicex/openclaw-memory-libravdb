package compact

import (
	"bytes"
	"context"
	"errors"
	"log"
	"testing"

	"github.com/xDarkicex/openclaw-memory-libravdb/sidecar/store"
	"github.com/xDarkicex/openclaw-memory-libravdb/sidecar/summarize"
)

type fakeStore struct {
	results       []store.SearchResult
	insertCalls   []insertCall
	deleteCalls   []deleteCall
	deleteErr     error
	listErr       error
	insertErr     error
}

type insertCall struct {
	collection string
	id         string
	text       string
	meta       map[string]any
}

type deleteCall struct {
	collection string
	ids        []string
}

type fakeSummarizer struct {
	summaries []summarize.Summary
	err       error
	calls     [][]summarize.Turn
	mode      string
}

func (f *fakeStore) ListByMeta(_ context.Context, collection, key, value string) ([]store.SearchResult, error) {
	if f.listErr != nil {
		return nil, f.listErr
	}
	return append([]store.SearchResult(nil), f.results...), nil
}

func (f *fakeStore) InsertText(_ context.Context, collection, id, text string, meta map[string]any) error {
	if f.insertErr != nil {
		return f.insertErr
	}
	f.insertCalls = append(f.insertCalls, insertCall{
		collection: collection,
		id:         id,
		text:       text,
		meta:       cloneMeta(meta),
	})
	return nil
}

func (f *fakeStore) DeleteBatch(_ context.Context, collection string, ids []string) error {
	f.deleteCalls = append(f.deleteCalls, deleteCall{
		collection: collection,
		ids:        append([]string(nil), ids...),
	})
	return f.deleteErr
}

func (f *fakeSummarizer) Summarize(_ context.Context, turns []summarize.Turn, _ summarize.SummaryOpts) (summarize.Summary, error) {
	f.calls = append(f.calls, append([]summarize.Turn(nil), turns...))
	if f.err != nil {
		return summarize.Summary{}, f.err
	}
	index := len(f.calls) - 1
	if index < len(f.summaries) {
		return f.summaries[index], nil
	}
	sourceIDs := make([]string, 0, len(turns))
	for _, turn := range turns {
		sourceIDs = append(sourceIDs, turn.ID)
	}
	return summarize.Summary{
		Text:       "summary",
		SourceIDs:  sourceIDs,
		Method:     "extractive",
		TokenCount: 3,
		Confidence: 0.8,
	}, nil
}

func (f *fakeSummarizer) Profile() summarize.Profile               { return summarize.Profile{Backend: "extractive"} }
func (f *fakeSummarizer) Warmup(context.Context) error             { return nil }
func (f *fakeSummarizer) Unload()                                  {}
func (f *fakeSummarizer) Close() error                             { return nil }
func (f *fakeSummarizer) Ready() bool                              { return true }
func (f *fakeSummarizer) Reason() string                           { return "" }
func (f *fakeSummarizer) Mode() string {
	if f.mode != "" {
		return f.mode
	}
	return "extractive"
}

func TestCompactSessionSkipsBelowThresholdWithoutForce(t *testing.T) {
	st := &fakeStore{
		results: []store.SearchResult{
			{ID: "a", Text: "alpha", Metadata: map[string]any{"sessionId": "s1", "ts": int64(10)}},
			{ID: "b", Text: "beta", Metadata: map[string]any{"sessionId": "s1", "ts": int64(20)}},
		},
	}
	sum := &fakeSummarizer{}

	got, err := CompactSession(context.Background(), st, sum, nil, "s1", false, 20)
	if err != nil {
		t.Fatalf("CompactSession() error = %v", err)
	}
	if got.DidCompact {
		t.Fatalf("expected no compaction below threshold, got %+v", got)
	}
	if len(sum.calls) != 0 || len(st.insertCalls) != 0 || len(st.deleteCalls) != 0 {
		t.Fatalf("expected no summarizer/store writes, got calls=%d inserts=%d deletes=%d", len(sum.calls), len(st.insertCalls), len(st.deleteCalls))
	}
}

func TestCompactSessionPartitionsDeterministicallyByTimestamp(t *testing.T) {
	st := &fakeStore{
		results: []store.SearchResult{
			{ID: "c", Text: "third", Metadata: map[string]any{"sessionId": "s1", "ts": int64(30)}},
			{ID: "a", Text: "first", Metadata: map[string]any{"sessionId": "s1", "ts": int64(10)}},
			{ID: "d", Text: "fourth", Metadata: map[string]any{"sessionId": "s1", "ts": int64(40)}},
			{ID: "b", Text: "second", Metadata: map[string]any{"sessionId": "s1", "ts": int64(20)}},
		},
	}
	sum := &fakeSummarizer{
		summaries: []summarize.Summary{
			{Text: "summary-1", SourceIDs: []string{"a", "b"}, Method: "extractive", TokenCount: 2, Confidence: 0.6},
			{Text: "summary-2", SourceIDs: []string{"c", "d"}, Method: "extractive", TokenCount: 2, Confidence: 0.8},
		},
	}

	got, err := CompactSession(context.Background(), st, sum, nil, "s1", true, 2)
	if err != nil {
		t.Fatalf("CompactSession() error = %v", err)
	}
	if !got.DidCompact || got.ClustersFormed != 2 || got.TurnsRemoved != 4 {
		t.Fatalf("unexpected result: %+v", got)
	}
	if got.SummaryMethod != "extractive" {
		t.Fatalf("unexpected summary method: %+v", got)
	}
	if got.MeanConfidence != 0.7 {
		t.Fatalf("expected mean confidence 0.7, got %f", got.MeanConfidence)
	}
	if len(sum.calls) != 2 {
		t.Fatalf("expected 2 summarize calls, got %d", len(sum.calls))
	}
	assertTurnIDs(t, sum.calls[0], []string{"a", "b"})
	assertTurnIDs(t, sum.calls[1], []string{"c", "d"})
}

func TestCompactSessionInsertsBeforeDeleteAndPreservesDataOnDeleteFailure(t *testing.T) {
	st := &fakeStore{
		results: []store.SearchResult{
			{ID: "a", Text: "alpha", Metadata: map[string]any{"sessionId": "s1", "ts": int64(10), "userId": "u1"}},
			{ID: "b", Text: "beta", Metadata: map[string]any{"sessionId": "s1", "ts": int64(20), "userId": "u1"}},
		},
		deleteErr: errors.New("boom"),
	}
	sum := &fakeSummarizer{
		summaries: []summarize.Summary{
			{Text: "summary-1", SourceIDs: []string{"a", "b"}, Method: "extractive", TokenCount: 5, Confidence: 0.75},
		},
	}

	got, err := CompactSession(context.Background(), st, sum, nil, "s1", true, 20)
	if err != nil {
		t.Fatalf("CompactSession() error = %v", err)
	}
	if len(st.insertCalls) != 1 {
		t.Fatalf("expected summary insert before delete, got %d insert calls", len(st.insertCalls))
	}
	if len(st.deleteCalls) != 1 {
		t.Fatalf("expected delete attempt after insert, got %d delete calls", len(st.deleteCalls))
	}
	if got.TurnsRemoved != 0 {
		t.Fatalf("expected no removed turns when delete fails, got %+v", got)
	}

	meta := st.insertCalls[0].meta
	if meta["type"] != "summary" {
		t.Fatalf("expected summary metadata type, got %+v", meta)
	}
	if meta["method"] != "extractive" {
		t.Fatalf("expected method metadata, got %+v", meta)
	}
	if meta["confidence"] != 0.75 {
		t.Fatalf("expected confidence metadata, got %+v", meta)
	}
	if meta["decay_rate"] != 0.25 {
		t.Fatalf("expected decay rate metadata, got %+v", meta)
	}
	if meta["userId"] != "u1" {
		t.Fatalf("expected userId carried forward, got %+v", meta)
	}

	sourceIDs, ok := meta["source_ids"].([]string)
	if !ok {
		t.Fatalf("expected source_ids to be []string, got %T", meta["source_ids"])
	}
	if len(sourceIDs) != 2 || sourceIDs[0] != "a" || sourceIDs[1] != "b" {
		t.Fatalf("unexpected source_ids: %+v", sourceIDs)
	}
}

func TestCompactSessionPreservesSourceTurnsWhenInsertFails(t *testing.T) {
	st := &fakeStore{
		results: []store.SearchResult{
			{ID: "a", Text: "alpha", Metadata: map[string]any{"sessionId": "s1", "ts": int64(10)}},
			{ID: "b", Text: "beta", Metadata: map[string]any{"sessionId": "s1", "ts": int64(20)}},
		},
		insertErr: errors.New("insert failed"),
	}
	sum := &fakeSummarizer{}

	_, err := CompactSession(context.Background(), st, sum, nil, "s1", true, 20)
	if err == nil {
		t.Fatalf("expected insert failure")
	}
	if len(st.deleteCalls) != 0 {
		t.Fatalf("expected no delete call when insert fails, got %d", len(st.deleteCalls))
	}
}

func TestCompactSessionRoutesHighGatingClustersToAbstractive(t *testing.T) {
	st := &fakeStore{
		results: []store.SearchResult{
			{ID: "a", Text: "alpha", Metadata: map[string]any{"sessionId": "s1", "ts": int64(10), "gating_score": 0.8}},
			{ID: "b", Text: "beta", Metadata: map[string]any{"sessionId": "s1", "ts": int64(20), "gating_score": 0.7}},
		},
	}
	extractive := &fakeSummarizer{
		summaries: []summarize.Summary{{Text: "extractive-summary", Method: "extractive", TokenCount: 2, Confidence: 0.5}},
		mode:      "extractive",
	}
	abstractive := &fakeSummarizer{
		summaries: []summarize.Summary{{Text: "abstractive-summary", Method: "onnx-t5", TokenCount: 3, Confidence: 0.9}},
		mode:      "onnx-local",
	}

	got, err := CompactSession(context.Background(), st, extractive, abstractive, "s1", true, 20)
	if err != nil {
		t.Fatalf("CompactSession() error = %v", err)
	}
	if !got.DidCompact {
		t.Fatalf("expected compaction, got %+v", got)
	}
	if len(abstractive.calls) != 1 {
		t.Fatalf("expected abstractive summarizer to be used, got %d calls", len(abstractive.calls))
	}
	if len(extractive.calls) != 0 {
		t.Fatalf("expected extractive summarizer to be skipped, got %d calls", len(extractive.calls))
	}
	if got.SummaryMethod != "onnx-t5" {
		t.Fatalf("expected onnx-t5 method, got %+v", got)
	}
}

func TestCompactSessionRoutesMissingGatingScoreToExtractiveAndLogsDecision(t *testing.T) {
	st := &fakeStore{
		results: []store.SearchResult{
			{ID: "a", Text: "alpha", Metadata: map[string]any{"sessionId": "s1", "ts": int64(10)}},
			{ID: "b", Text: "beta", Metadata: map[string]any{"sessionId": "s1", "ts": int64(20)}},
		},
	}
	extractive := &fakeSummarizer{
		summaries: []summarize.Summary{{Text: "extractive-summary", Method: "extractive", TokenCount: 2, Confidence: 0.5}},
		mode:      "extractive",
	}
	abstractive := &fakeSummarizer{
		summaries: []summarize.Summary{{Text: "abstractive-summary", Method: "onnx-t5", TokenCount: 3, Confidence: 0.9}},
		mode:      "onnx-local",
	}

	var buf bytes.Buffer
	prevWriter := log.Writer()
	log.SetOutput(&buf)
	defer log.SetOutput(prevWriter)

	got, err := CompactSession(context.Background(), st, extractive, abstractive, "s1", true, 20)
	if err != nil {
		t.Fatalf("CompactSession() error = %v", err)
	}
	if !got.DidCompact {
		t.Fatalf("expected compaction, got %+v", got)
	}
	if len(extractive.calls) != 1 {
		t.Fatalf("expected extractive summarizer to be used, got %d calls", len(extractive.calls))
	}
	if len(abstractive.calls) != 0 {
		t.Fatalf("expected abstractive summarizer to be skipped, got %d calls", len(abstractive.calls))
	}
	logged := buf.String()
	if !bytes.Contains([]byte(logged), []byte("cluster_id=0")) || !bytes.Contains([]byte(logged), []byte("mean_gating_score=0.000")) || !bytes.Contains([]byte(logged), []byte("summarizer_used=extractive")) {
		t.Fatalf("expected routing telemetry log, got %q", logged)
	}
}

func assertTurnIDs(t *testing.T, turns []summarize.Turn, want []string) {
	t.Helper()
	if len(turns) != len(want) {
		t.Fatalf("unexpected turns length: got %d want %d", len(turns), len(want))
	}
	for i, turn := range turns {
		if turn.ID != want[i] {
			t.Fatalf("unexpected turn order at %d: got %q want %q", i, turn.ID, want[i])
		}
	}
}
