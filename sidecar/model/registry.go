package model

import (
	"fmt"
	"math"
	"sync"
	"time"

	ort "github.com/yalue/onnxruntime_go"
)

type Task int

const (
	TaskEmbedding Task = iota
	TaskSummarization
)

type Profile struct {
	Name          string
	Family        string
	Task          Task
	Dims          int
	MaxCtxTokens  int
	Quantization  string
	Normalize     bool
	ModelPath     string
	TokenizerPath string
	OrtLibPath    string
}

type MemoryPolicy struct {
	SummarizerIdleTTL  time.Duration
	EmbedderIdleTTL    time.Duration
	MaxTotalModelBytes int64
	// EvictionK calibrates model-eviction sensitivity:
	// k = idleEligibilitySeconds * medianModelSizeBytes.
	// Increase k to keep idle models resident longer; decrease it to evict more aggressively.
	EvictionK float64
}

type Status struct {
	Name             string        `json:"name"`
	Family           string        `json:"family"`
	Task             string        `json:"task"`
	Loaded           bool          `json:"loaded"`
	UseCount         int           `json:"useCount"`
	LastAccess       time.Time     `json:"lastAccess"`
	IdleFor          time.Duration `json:"idleFor"`
	ReservedBytes    int64         `json:"reservedBytes"`
	EvictionPriority float64       `json:"evictionPriority"`
}

type Registry struct {
	mu          sync.RWMutex
	policy      MemoryPolicy
	runtimePath string
	loaded      map[string]*loadedModel
}

type loadedModel struct {
	key           string
	profile       Profile
	lastAccess    time.Time
	useCount      int
	reservedBytes int64
	closeFn       func() error
	encoder       *EncoderModel
	seq2seq       *Seq2SeqModel
}

const defaultEvictionK = 1.2e11

var timeNow = time.Now

func DefaultMemoryPolicy() MemoryPolicy {
	return MemoryPolicy{
		SummarizerIdleTTL:  5 * time.Minute,
		EmbedderIdleTTL:    30 * time.Minute,
		MaxTotalModelBytes: 2 << 30,
		EvictionK:          defaultEvictionK,
	}
}

func NewRegistry(policy MemoryPolicy) *Registry {
	return &Registry{
		policy: policy,
		loaded: make(map[string]*loadedModel),
	}
}

var defaultRegistry = NewRegistry(DefaultMemoryPolicy())

func DefaultRegistry() *Registry {
	return defaultRegistry
}

func (r *Registry) Close() error {
	r.mu.Lock()
	defer r.mu.Unlock()

	for key, loaded := range r.loaded {
		_ = closeLoadedModel(loaded)
		delete(r.loaded, key)
	}
	if ort.IsInitialized() {
		if err := ort.DestroyEnvironment(); err != nil {
			return err
		}
	}
	r.runtimePath = ""
	return nil
}

func (r *Registry) Status() map[string]Status {
	r.mu.RLock()
	defer r.mu.RUnlock()

	now := time.Now()
	out := make(map[string]Status, len(r.loaded))
	for key, loaded := range r.loaded {
		out[key] = Status{
			Name:             loaded.profile.Name,
			Family:           loaded.profile.Family,
			Task:             taskName(loaded.profile.Task),
			Loaded:           true,
			UseCount:         loaded.useCount,
			LastAccess:       loaded.lastAccess,
			IdleFor:          now.Sub(loaded.lastAccess),
			ReservedBytes:    loaded.reservedBytes,
			EvictionPriority: evictionPriority(*loaded, now, r.policy.EvictionK),
		}
	}
	return out
}

func (r *Registry) Unload(name string) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	loaded, ok := r.loaded[name]
	if !ok {
		return nil
	}
	if err := closeLoadedModel(loaded); err != nil {
		return err
	}
	delete(r.loaded, name)
	if len(r.loaded) == 0 && ort.IsInitialized() {
		if err := ort.DestroyEnvironment(); err != nil {
			return err
		}
		r.runtimePath = ""
	}
	return nil
}

func (r *Registry) touchLocked(key string) {
	if loaded, ok := r.loaded[key]; ok {
		loaded.lastAccess = time.Now()
		loaded.useCount++
	}
}

func (r *Registry) ensureRuntimeLocked(path string) error {
	if path == "" {
		return fmt.Errorf("onnx runtime path is required")
	}
	if ort.IsInitialized() {
		if r.runtimePath != "" && r.runtimePath != path {
			return fmt.Errorf("onnx runtime already initialized with %q, cannot switch to %q", r.runtimePath, path)
		}
		r.runtimePath = path
		return nil
	}
	ort.SetSharedLibraryPath(path)
	if err := ort.InitializeEnvironment(); err != nil {
		return err
	}
	r.runtimePath = path
	return nil
}

func (r *Registry) maybeEvictLocked(now time.Time) error {
	for key, loaded := range r.loaded {
		idleTTL := r.policy.EmbedderIdleTTL
		if loaded.profile.Task == TaskSummarization {
			idleTTL = r.policy.SummarizerIdleTTL
		}
		if idleTTL > 0 && now.Sub(loaded.lastAccess) > idleTTL {
			if err := closeLoadedModel(loaded); err != nil {
				return err
			}
			delete(r.loaded, key)
		}
	}

	if r.policy.MaxTotalModelBytes <= 0 {
		return nil
	}
	for totalReservedBytes(r.loaded) > r.policy.MaxTotalModelBytes {
		evictKey := ""
		evictScore := 0.0
		for key, loaded := range r.loaded {
			score := evictionPriority(*loaded, now, r.policy.EvictionK)
			if evictKey == "" || score > evictScore {
				evictKey = key
				evictScore = score
			}
		}
		if evictKey == "" {
			return nil
		}
		if err := closeLoadedModel(r.loaded[evictKey]); err != nil {
			return err
		}
		delete(r.loaded, evictKey)
	}
	return nil
}

func evictionPriority(m loadedModel, now time.Time, k float64) float64 {
	deltaT := now.Sub(m.lastAccess).Seconds()
	if deltaT < 0 {
		deltaT = 0
	}
	size := float64(m.reservedBytes)
	if size < 0 {
		size = 0
	}
	if k <= 0 {
		k = defaultEvictionK
	}
	freq := float64(m.useCount)
	return (deltaT * size) / (k * (1.0 + math.Log(freq+1.0)))
}

func totalReservedBytes(loaded map[string]*loadedModel) int64 {
	var total int64
	for _, item := range loaded {
		total += item.reservedBytes
	}
	return total
}

func closeLoadedModel(loaded *loadedModel) error {
	if loaded == nil || loaded.closeFn == nil {
		return nil
	}
	return loaded.closeFn()
}

func taskName(task Task) string {
	switch task {
	case TaskEmbedding:
		return "embedding"
	case TaskSummarization:
		return "summarization"
	default:
		return "unknown"
	}
}
