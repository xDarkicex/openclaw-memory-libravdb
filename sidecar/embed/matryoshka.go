package embed

import (
	"context"
	"fmt"
	"math"
	"strings"
)

const (
	DimsL1 = 64
	DimsL2 = 256
	DimsL3 = 768
)

type MatryoshkaVec struct {
	L1 []float32
	L2 []float32
	L3 []float32
}

type MatryoshkaEmbedder interface {
	Embedder
	EmbedDocumentM(ctx context.Context, text string) (MatryoshkaVec, error)
	EmbedQueryM(ctx context.Context, text string) (MatryoshkaVec, error)
}

func SupportsMatryoshka(e Embedder) bool {
	if e == nil {
		return false
	}
	return strings.EqualFold(e.Profile().Family, "nomic-embed-text-v1.5")
}

func NewMatryoshkaVec(full []float32) (MatryoshkaVec, error) {
	if len(full) < DimsL3 {
		return MatryoshkaVec{}, fmt.Errorf("matryoshka requires %d-dim vector, got %d", DimsL3, len(full))
	}
	return MatryoshkaVec{
		L1: truncateAndNormalize(full, DimsL1),
		L2: truncateAndNormalize(full, DimsL2),
		L3: truncateAndNormalize(full, DimsL3),
	}, nil
}

func truncateAndNormalize(v []float32, dims int) []float32 {
	if dims <= 0 {
		return nil
	}
	if dims > len(v) {
		dims = len(v)
	}

	t := make([]float32, dims)
	copy(t, v[:dims])

	var norm float64
	for _, x := range t {
		norm += float64(x) * float64(x)
	}
	norm = math.Sqrt(norm)
	if norm < 1e-9 {
		return t
	}

	scale := float32(norm)
	for i := range t {
		t[i] /= scale
	}
	return t
}

func (e *Engine) EmbedDocumentM(ctx context.Context, text string) (MatryoshkaVec, error) {
	if !SupportsMatryoshka(e) {
		return MatryoshkaVec{}, fmt.Errorf("matryoshka unavailable for profile family %q", e.Profile().Family)
	}
	full, err := e.EmbedDocument(ctx, text)
	if err != nil {
		return MatryoshkaVec{}, err
	}
	return NewMatryoshkaVec(full)
}

func (e *Engine) EmbedQueryM(ctx context.Context, text string) (MatryoshkaVec, error) {
	if !SupportsMatryoshka(e) {
		return MatryoshkaVec{}, fmt.Errorf("matryoshka unavailable for profile family %q", e.Profile().Family)
	}
	full, err := e.EmbedQuery(ctx, text)
	if err != nil {
		return MatryoshkaVec{}, err
	}
	return NewMatryoshkaVec(full)
}
