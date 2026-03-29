package server

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/xDarkicex/openclaw-memory-libravdb/sidecar/compact"
	"github.com/xDarkicex/openclaw-memory-libravdb/sidecar/embed"
	"github.com/xDarkicex/openclaw-memory-libravdb/sidecar/health"
	"github.com/xDarkicex/openclaw-memory-libravdb/sidecar/store"
	"github.com/xDarkicex/openclaw-memory-libravdb/sidecar/summarize"
)

type HandlerFn func(context.Context, any) (any, error)

type Server struct {
	Embedder     embed.Embedder
	Extractive   summarize.Summarizer
	Abstractive  summarize.Summarizer
	Store        *store.Store
	Gating       compact.GatingConfig
	methods      map[string]HandlerFn
}

func New(embedder embed.Embedder, extractive summarize.Summarizer, abstractive summarize.Summarizer, st *store.Store, gating compact.GatingConfig) *Server {
	s := &Server{
		Embedder:    embedder,
		Extractive:  extractive,
		Abstractive: abstractive,
		Store:       st,
		Gating:      gating,
	}
	s.methods = map[string]HandlerFn{
		"health":             s.handleHealth,
		"status":             s.handleStatus,
		"ensure_collections": s.handleEnsureCollections,
		"insert_text":        s.handleInsertText,
		"gating_scalar":      s.handleGatingScalar,
		"search_text":        s.handleSearchText,
		"list_by_meta":       s.handleListByMeta,
		"export_memory":      s.handleExportMemory,
		"flush_namespace":    s.handleFlushNamespace,
		"delete":             s.handleDelete,
		"delete_batch":       s.handleDeleteBatch,
		"compact_session":    s.handleCompact,
		"flush":              s.handleFlush,
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

type searchTextParams struct {
	Collection string   `json:"collection"`
	Text       string   `json:"text"`
	K          int      `json:"k"`
	ExcludeIDs []string `json:"excludeIds"`
}

type listByMetaParams struct {
	Collection string `json:"collection"`
	Key        string `json:"key"`
	Value      string `json:"value"`
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
	SessionID  string `json:"sessionId"`
	Force      bool   `json:"force"`
	TargetSize int    `json:"targetSize,omitempty"`
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
	OK                bool   `json:"ok"`
	Message           string `json:"message"`
	TurnCount         int     `json:"turnCount"`
	MemoryCount       int     `json:"memoryCount"`
	GatingThreshold   float64 `json:"gatingThreshold"`
	AbstractiveReady  bool   `json:"abstractiveReady"`
	EmbeddingProfile  string `json:"embeddingProfile"`
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
		OK:               base.OK,
		Message:          base.Message,
		TurnCount:        s.Store.CountByPrefix("turns:"),
		MemoryCount:      s.Store.CountByPrefix("user:"),
		GatingThreshold:  s.Gating.Threshold,
		AbstractiveReady: s.Abstractive != nil && s.Abstractive.Ready(),
		EmbeddingProfile: firstNonEmpty(s.Embedder.Profile().Family, s.Embedder.Profile().Backend, "unknown"),
	}
	return status, nil
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
	)
	if err != nil {
		return nil, err
	}
	return result, nil
}

func (s *Server) handleFlush(ctx context.Context, _ any) (any, error) {
	if err := s.Store.Flush(ctx); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true}, nil
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
