package health

import (
	"github.com/xDarkicex/openclaw-memory-libravdb/sidecar/embed"
	"github.com/xDarkicex/openclaw-memory-libravdb/sidecar/store"
)

type Status struct {
	OK      bool   `json:"ok"`
	Message string `json:"message"`
}

func Check(embedder embed.Embedder, st *store.Store) Status {
	if embedder == nil {
		return Status{OK: false, Message: "embedder unavailable"}
	}
	if !embedder.Ready() {
		return Status{OK: false, Message: "embedder not ready"}
	}
	if st == nil {
		return Status{OK: false, Message: "store unavailable"}
	}
	return Status{OK: true, Message: "ok"}
}
