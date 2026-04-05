package server

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/xDarkicex/openclaw-memory-libravdb/sidecar/compact"
	"github.com/xDarkicex/openclaw-memory-libravdb/sidecar/embed"
	"github.com/xDarkicex/openclaw-memory-libravdb/sidecar/health"
	"github.com/xDarkicex/openclaw-memory-libravdb/sidecar/store"
	"github.com/xDarkicex/openclaw-memory-libravdb/sidecar/summarize"
)

type HandlerFn func(context.Context, any) (any, error)

type Server struct {
	Embedder                   embed.Embedder
	Extractive                 summarize.Summarizer
	Abstractive                summarize.Summarizer
	Store                      *store.Store
	Gating                     compact.GatingConfig
	LifecycleJournalMaxEntries int
	methods                    map[string]HandlerFn
}

func New(embedder embed.Embedder, extractive summarize.Summarizer, abstractive summarize.Summarizer, st *store.Store, gating compact.GatingConfig, lifecycleJournalMaxEntries int) *Server {
	s := &Server{
		Embedder:                   embedder,
		Extractive:                 extractive,
		Abstractive:                abstractive,
		Store:                      st,
		Gating:                     gating,
		LifecycleJournalMaxEntries: lifecycleJournalMaxEntries,
	}
	s.methods = map[string]HandlerFn{
		"health":                  s.handleHealth,
		"status":                  s.handleStatus,
		"session_lifecycle_hint":  s.handleSessionLifecycleHint,
		"list_lifecycle_journal":  s.handleListLifecycleJournal,
		"ensure_collections":      s.handleEnsureCollections,
		"insert_text":             s.handleInsertText,
		"insert_session_turn":     s.handleInsertSessionTurn,
		"gating_scalar":           s.handleGatingScalar,
		"search_text":             s.handleSearchText,
		"search_text_collections": s.handleSearchTextCollections,
		"bump_access_counts":      s.handleBumpAccessCounts,
		"list_collection":         s.handleListCollection,
		"list_by_meta":            s.handleListByMeta,
		"export_memory":           s.handleExportMemory,
		"flush_namespace":         s.handleFlushNamespace,
		"delete":                  s.handleDelete,
		"delete_batch":            s.handleDeleteBatch,
		"compact_session":         s.handleCompact,
		"expand_summary":          s.handleExpandSummary,
		"flush":                   s.handleFlush,
	}
	return s
}

func (s *Server) Call(ctx context.Context, method string, params any) (any, error) {
	handler, ok := s.methods[method]
	if !ok {
		return nil, fmt.Errorf("unknown method: %s", method)
	}
	return handler(ctx, params)
}

type ensureCollectionsParams struct {
	Collections []string `json:"collections"`
}

type insertTextParams struct {
	Collection string         `json:"collection"`
	ID         string         `json:"id"`
	Text       string         `json:"text"`
	Metadata   map[string]any `json:"metadata"`
}

type insertSessionTurnParams struct {
	SessionID string         `json:"sessionId"`
	ID        string         `json:"id"`
	Text      string         `json:"text"`
	Metadata  map[string]any `json:"metadata"`
}

type searchTextParams struct {
	Collection string   `json:"collection"`
	Text       string   `json:"text"`
	K          int      `json:"k"`
	ExcludeIDs []string `json:"excludeIds"`
}

type searchTextCollectionsParams struct {
	Collections         []string            `json:"collections"`
	Text                string              `json:"text"`
	K                   int                 `json:"k"`
	ExcludeByCollection map[string][]string `json:"excludeByCollection"`
}

type listByMetaParams struct {
	Collection string `json:"collection"`
	Key        string `json:"key"`
	Value      string `json:"value"`
}

type listCollectionParams struct {
	Collection string `json:"collection"`
}

type expandSummaryParams struct {
	SessionID string `json:"sessionId"`
	SummaryID string `json:"summaryId"`
	MaxDepth  int    `json:"maxDepth,omitempty"`
}

type listLifecycleJournalParams struct {
	SessionID string `json:"sessionId,omitempty"`
	Limit     int    `json:"limit,omitempty"`
}

type bumpAccessCountsParams struct {
	Updates []accessCountUpdate `json:"updates"`
}

type accessCountUpdate struct {
	Collection string   `json:"collection"`
	IDs        []string `json:"ids"`
}

type deleteParams struct {
	Collection string `json:"collection"`
	ID         string `json:"id"`
}

type deleteBatchParams struct {
	Collection string   `json:"collection"`
	IDs        []string `json:"ids"`
}

type compactParams struct {
	SessionID             string `json:"sessionId"`
	Force                 bool   `json:"force"`
	TargetSize            int    `json:"targetSize,omitempty"`
	ContinuityMinTurns    int    `json:"continuityMinTurns,omitempty"`
	ContinuityTailTokens  int    `json:"continuityTailBudgetTokens,omitempty"`
	ContinuityPriorTokens int    `json:"continuityPriorContextTokens,omitempty"`
}

type searchTextResult struct {
	Results []store.SearchResult `json:"results"`
}

type gatingScalarParams struct {
	UserID string `json:"userId"`
	Text   string `json:"text"`
}

type flushNamespaceParams struct {
	UserID string `json:"userId"`
}

type memoryStatus struct {
	OK                 bool    `json:"ok"`
	Message            string  `json:"message"`
	TurnCount          int     `json:"turnCount"`
	MemoryCount        int     `json:"memoryCount"`
	LifecycleHintCount int     `json:"lifecycleHintCount"`
	GatingThreshold    float64 `json:"gatingThreshold"`
	AbstractiveReady   bool    `json:"abstractiveReady"`
	EmbeddingProfile   string  `json:"embeddingProfile"`
}

type sessionLifecycleHintParams struct {
	Hook               string `json:"hook"`
	Reason             string `json:"reason,omitempty"`
	SessionFile        string `json:"sessionFile,omitempty"`
	SessionID          string `json:"sessionId,omitempty"`
	SessionKey         string `json:"sessionKey,omitempty"`
	AgentID            string `json:"agentId,omitempty"`
	WorkspaceDir       string `json:"workspaceDir,omitempty"`
	MessageCount       int    `json:"messageCount,omitempty"`
	DurationMs         int    `json:"durationMs,omitempty"`
	TranscriptArchived bool   `json:"transcriptArchived,omitempty"`
	NextSessionID      string `json:"nextSessionId,omitempty"`
	NextSessionKey     string `json:"nextSessionKey,omitempty"`
}

type exportMemoryRecord struct {
	Collection string         `json:"collection"`
	ID         string         `json:"id"`
	Text       string         `json:"text"`
	Metadata   map[string]any `json:"metadata"`
}

type exportMemoryResult struct {
	Records []exportMemoryRecord `json:"records"`
}

func (s *Server) handleHealth(_ context.Context, _ any) (any, error) {
	return health.Check(s.Embedder, s.Store), nil
}

func (s *Server) handleStatus(_ context.Context, _ any) (any, error) {
	base := health.Check(s.Embedder, s.Store)
	status := memoryStatus{
		OK:                 base.OK,
		Message:            base.Message,
		TurnCount:          s.Store.CountByPrefix("turns:"),
		MemoryCount:        s.Store.CountByPrefix("user:"),
		LifecycleHintCount: s.Store.CountByPrefix(store.LifecycleJournalCollection),
		GatingThreshold:    s.Gating.Threshold,
		AbstractiveReady:   s.Abstractive != nil && s.Abstractive.Ready(),
		EmbeddingProfile:   firstNonEmpty(s.Embedder.Profile().Family, s.Embedder.Profile().Backend, "unknown"),
	}
	return status, nil
}

func (s *Server) handleSessionLifecycleHint(ctx context.Context, raw any) (any, error) {
	var params sessionLifecycleHintParams
	if err := decode(raw, &params); err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	id := fmt.Sprintf("%s:%s:%d", firstNonEmpty(params.Hook, "unknown"), firstNonEmpty(params.SessionID, "none"), now.UnixNano())
	meta := map[string]any{
		"type":               "session_lifecycle_hint",
		"internal":           true,
		"hook":               params.Hook,
		"reason":             params.Reason,
		"sessionId":          params.SessionID,
		"sessionKey":         params.SessionKey,
		"agentId":            params.AgentID,
		"workspaceDir":       params.WorkspaceDir,
		"sessionFile":        params.SessionFile,
		"messageCount":       params.MessageCount,
		"durationMs":         params.DurationMs,
		"transcriptArchived": params.TranscriptArchived,
		"nextSessionId":      params.NextSessionID,
		"nextSessionKey":     params.NextSessionKey,
		"ts":                 now.UnixMilli(),
		"source":             "openclaw-hook",
		"ingest_kind":        "lifecycle_journal",
	}
	if err := s.Store.AppendLifecycleJournal(ctx, id, meta); err != nil {
		return nil, err
	}
	if err := s.Store.PruneLifecycleJournal(ctx, s.LifecycleJournalMaxEntries); err != nil {
		return nil, err
	}
	if err := s.Store.Flush(ctx); err != nil {
		return nil, err
	}
	return map[string]any{
		"ok":        true,
		"hook":      params.Hook,
		"sessionId": params.SessionID,
		"reason":    params.Reason,
	}, nil
}

func (s *Server) handleListLifecycleJournal(ctx context.Context, raw any) (any, error) {
	var params listLifecycleJournalParams
	if err := decode(raw, &params); err != nil {
		return nil, err
	}
	results, err := s.Store.ListLifecycleJournal(ctx)
	if err != nil {
		return nil, err
	}
	filtered := make([]store.SearchResult, 0, len(results))
	for _, item := range results {
		if params.SessionID != "" && metaStringValue(item.Metadata, "sessionId") != params.SessionID {
			continue
		}
		filtered = append(filtered, item)
	}
	if params.Limit > 0 && len(filtered) > params.Limit {
		filtered = filtered[:params.Limit]
	}
	return searchTextResult{Results: filtered}, nil
}

func (s *Server) handleEnsureCollections(ctx context.Context, raw any) (any, error) {
	var params ensureCollectionsParams
	if err := decode(raw, &params); err != nil {
		return nil, err
	}
	for _, collection := range params.Collections {
		if err := s.Store.EnsureCollection(ctx, collection); err != nil {
			return nil, err
		}
	}
	return map[string]any{"ok": true}, nil
}

func (s *Server) handleInsertText(ctx context.Context, raw any) (any, error) {
	var params insertTextParams
	if err := decode(raw, &params); err != nil {
		return nil, err
	}
	if err := s.Store.InsertText(ctx, params.Collection, params.ID, params.Text, params.Metadata); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true}, nil
}

func (s *Server) handleInsertSessionTurn(ctx context.Context, raw any) (any, error) {
	var params insertSessionTurnParams
	if err := decode(raw, &params); err != nil {
		return nil, err
	}
	if err := s.Store.InsertSessionTurn(ctx, params.SessionID, params.ID, params.Text, params.Metadata); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true}, nil
}

func (s *Server) handleSearchText(ctx context.Context, raw any) (any, error) {
	var params searchTextParams
	if err := decode(raw, &params); err != nil {
		return nil, err
	}
	results, err := s.Store.SearchText(ctx, params.Collection, params.Text, params.K, params.ExcludeIDs)
	if err != nil {
		return nil, err
	}
	return searchTextResult{Results: results}, nil
}

func (s *Server) handleSearchTextCollections(ctx context.Context, raw any) (any, error) {
	var params searchTextCollectionsParams
	if err := decode(raw, &params); err != nil {
		return nil, err
	}
	results, err := s.Store.SearchTextCollections(ctx, params.Collections, params.Text, params.K, params.ExcludeByCollection)
	if err != nil {
		return nil, err
	}
	return searchTextResult{Results: results}, nil
}

func (s *Server) handleGatingScalar(ctx context.Context, raw any) (any, error) {
	var params gatingScalarParams
	if err := decode(raw, &params); err != nil {
		return nil, err
	}
	turnHits, err := s.Store.SearchText(ctx, "turns:"+params.UserID, params.Text, 10, nil)
	if err != nil {
		return nil, err
	}
	memHits, err := s.Store.SearchText(ctx, "user:"+params.UserID, params.Text, 5, nil)
	if err != nil {
		return nil, err
	}
	return compact.ComputeGating(turnHits, memHits, params.Text, s.Gating), nil
}

func (s *Server) handleListByMeta(ctx context.Context, raw any) (any, error) {
	var params listByMetaParams
	if err := decode(raw, &params); err != nil {
		return nil, err
	}
	results, err := s.Store.ListByMeta(ctx, params.Collection, params.Key, params.Value)
	if err != nil {
		return nil, err
	}
	return searchTextResult{Results: results}, nil
}

func (s *Server) handleListCollection(ctx context.Context, raw any) (any, error) {
	var params listCollectionParams
	if err := decode(raw, &params); err != nil {
		return nil, err
	}
	results, err := s.Store.ListCollection(ctx, params.Collection)
	if err != nil {
		return nil, err
	}
	return searchTextResult{Results: results}, nil
}

func (s *Server) handleBumpAccessCounts(ctx context.Context, raw any) (any, error) {
	var params bumpAccessCountsParams
	if err := decode(raw, &params); err != nil {
		return nil, err
	}
	for _, update := range params.Updates {
		if err := s.Store.IncrementAccessCounts(ctx, update.Collection, update.IDs); err != nil {
			return nil, err
		}
	}
	return map[string]any{"ok": true}, nil
}

func (s *Server) handleExportMemory(ctx context.Context, raw any) (any, error) {
	var params flushNamespaceParams
	if err := decode(raw, &params); err != nil {
		return nil, err
	}

	prefix := "user:"
	if params.UserID != "" {
		prefix = "user:" + params.UserID
	}

	collections := s.Store.CollectionNames()
	records := make([]exportMemoryRecord, 0)
	for _, collection := range collections {
		if collection == storeDirtyCollectionName() || collection == "" {
			continue
		}
		if collection != prefix && !hasTierPrefix(collection, prefix) {
			continue
		}
		items, err := s.Store.ListCollection(ctx, collection)
		if err != nil {
			return nil, err
		}
		for _, item := range items {
			records = append(records, exportMemoryRecord{
				Collection: collection,
				ID:         item.ID,
				Text:       item.Text,
				Metadata:   item.Metadata,
			})
		}
	}

	return exportMemoryResult{Records: records}, nil
}

func (s *Server) handleFlushNamespace(ctx context.Context, raw any) (any, error) {
	var params flushNamespaceParams
	if err := decode(raw, &params); err != nil {
		return nil, err
	}
	if params.UserID == "" {
		return nil, fmt.Errorf("userId is required")
	}
	if err := s.Store.DeleteCollectionsByPrefix(ctx, "user:"+params.UserID); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true}, nil
}

func (s *Server) handleDelete(ctx context.Context, raw any) (any, error) {
	var params deleteParams
	if err := decode(raw, &params); err != nil {
		return nil, err
	}
	if err := s.Store.Delete(ctx, params.Collection, params.ID); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true}, nil
}

func (s *Server) handleDeleteBatch(ctx context.Context, raw any) (any, error) {
	var params deleteBatchParams
	if err := decode(raw, &params); err != nil {
		return nil, err
	}
	if err := s.Store.DeleteBatch(ctx, params.Collection, params.IDs); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true}, nil
}

func (s *Server) handleCompact(ctx context.Context, raw any) (any, error) {
	var params compactParams
	if err := decode(raw, &params); err != nil {
		return nil, err
	}
	result, err := compact.CompactSession(
		ctx,
		s.Store,
		s.Extractive,
		s.Abstractive,
		params.SessionID,
		params.Force,
		params.TargetSize,
		compact.ContinuityConfig{
			MinTurns:           params.ContinuityMinTurns,
			TailBudgetTokens:   params.ContinuityTailTokens,
			PriorContextTokens: params.ContinuityPriorTokens,
		},
	)
	if err != nil {
		return nil, err
	}
	return result, nil
}

func (s *Server) handleExpandSummary(ctx context.Context, raw any) (any, error) {
	var params expandSummaryParams
	if err := decode(raw, &params); err != nil {
		return nil, err
	}
	if params.SessionID == "" {
		return nil, fmt.Errorf("sessionId is required")
	}
	if params.SummaryID == "" {
		return nil, fmt.Errorf("summaryId is required")
	}
	maxDepth := params.MaxDepth
	if maxDepth <= 0 {
		maxDepth = 3
	}
	results, err := s.Store.ExpandSummary(ctx, params.SessionID, params.SummaryID, maxDepth)
	if err != nil {
		return nil, err
	}
	return searchTextResult{Results: results}, nil
}

func (s *Server) handleFlush(ctx context.Context, _ any) (any, error) {
	if err := s.Store.Flush(ctx); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true}, nil
}

func metaStringValue(meta map[string]any, key string) string {
	if meta == nil {
		return ""
	}
	value, ok := meta[key]
	if !ok {
		return ""
	}
	text, ok := value.(string)
	if !ok {
		return ""
	}
	return text
}

func decode(raw any, target any) error {
	if raw == nil {
		return nil
	}
	data, err := json.Marshal(raw)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, target)
}

func hasTierPrefix(collection, prefix string) bool {
	return collection == prefix || strings.HasPrefix(collection, prefix+":")
}

func storeDirtyCollectionName() string {
	return "_tier_dirty"
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}
