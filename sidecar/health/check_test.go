package health

import (
	"context"
	"testing"

	"github.com/xDarkicex/openclaw-memory-libravdb/sidecar/embed"
	"github.com/xDarkicex/openclaw-memory-libravdb/sidecar/store"
)

type fakeEmbedder struct {
	ready   bool
	reason  string
	mode    string
	profile embed.Profile
}

func (f fakeEmbedder) EmbedDocument(context.Context, string) ([]float32, error) {
	return make([]float32, 1), nil
}
func (f fakeEmbedder) EmbedQuery(context.Context, string) ([]float32, error) {
	return make([]float32, 1), nil
}
func (f fakeEmbedder) Dimensions() int        { return 1 }
func (f fakeEmbedder) Profile() embed.Profile { return f.profile }
func (f fakeEmbedder) Ready() bool            { return f.ready }
func (f fakeEmbedder) Reason() string         { return f.reason }
func (f fakeEmbedder) Mode() string           { return f.mode }

func TestCheckRejectsFallbackEmbedder(t *testing.T) {
	status := Check(fakeEmbedder{ready: true, mode: "fallback", reason: "bundled embedder unavailable"}, &store.Store{})
	if status.OK {
		t.Fatalf("expected fallback embedder to fail health")
	}
	if status.Message != "bundled embedder unavailable" {
		t.Fatalf("unexpected message %q", status.Message)
	}
}

func TestCheckRejectsNotReadyEmbedderWithReason(t *testing.T) {
	status := Check(fakeEmbedder{ready: false, reason: "missing onnx runtime"}, &store.Store{})
	if status.OK {
		t.Fatalf("expected not-ready embedder to fail health")
	}
	if status.Message != "missing onnx runtime" {
		t.Fatalf("unexpected message %q", status.Message)
	}
}

func TestCheckAcceptsReadyPrimaryEmbedder(t *testing.T) {
	status := Check(fakeEmbedder{ready: true, mode: "primary"}, &store.Store{})
	if !status.OK {
		t.Fatalf("expected primary embedder to pass health, got %+v", status)
	}
}
