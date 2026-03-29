package model

import (
	"math"
	"testing"
	"time"
)

func TestEvictionPriorityPrefersLargeIdleRarelyUsedModels(t *testing.T) {
	now := time.Unix(10_000, 0)
	k := defaultEvictionK

	largeIdleRare := loadedModel{
		lastAccess:    now.Add(-10 * time.Minute),
		useCount:      1,
		reservedBytes: 200 << 20,
	}
	smallRecentWarm := loadedModel{
		lastAccess:    now.Add(-10 * time.Second),
		useCount:      50_000,
		reservedBytes: 60 << 20,
	}

	oldScore := evictionPriority(largeIdleRare, now, k)
	recentScore := evictionPriority(smallRecentWarm, now, k)

	if !(oldScore > recentScore) {
		t.Fatalf("expected larger, older, colder model to have higher eviction score: old=%f recent=%f", oldScore, recentScore)
	}
}

func TestEvictionPriorityDecreasesWithUseCount(t *testing.T) {
	now := time.Unix(10_000, 0)
	k := defaultEvictionK

	cold := loadedModel{
		lastAccess:    now.Add(-5 * time.Minute),
		useCount:      1,
		reservedBytes: 200 << 20,
	}
	warm := loadedModel{
		lastAccess:    now.Add(-5 * time.Minute),
		useCount:      20,
		reservedBytes: 200 << 20,
	}

	coldScore := evictionPriority(cold, now, k)
	warmScore := evictionPriority(warm, now, k)

	if !(coldScore > warmScore) {
		t.Fatalf("expected use-count damping to reduce eviction score: cold=%f warm=%f", coldScore, warmScore)
	}
}

func TestEvictionPriorityHandlesZeroUseCountAndUsesDefaultK(t *testing.T) {
	now := time.Unix(10_000, 0)
	model := loadedModel{
		lastAccess:    now.Add(-10 * time.Minute),
		useCount:      0,
		reservedBytes: 200 << 20,
	}

	score := evictionPriority(model, now, 0)
	if score <= 0 {
		t.Fatalf("expected positive eviction score for idle loaded model, got %f", score)
	}
}

func TestEvictionPriorityHasLogarithmicDampingCurve(t *testing.T) {
	now := time.Unix(10_000, 0)
	k := defaultEvictionK
	idle := 10 * time.Minute
	size := int64(200 << 20)

	modelForUseCount := func(useCount int) loadedModel {
		return loadedModel{
			lastAccess:    now.Add(-idle),
			useCount:      useCount,
			reservedBytes: size,
		}
	}

	p1 := evictionPriority(modelForUseCount(1), now, k)
	p100 := evictionPriority(modelForUseCount(100), now, k)
	p10k := evictionPriority(modelForUseCount(10_000), now, k)

	ratioLow := p1 / p100
	ratioHigh := p100 / p10k

	expectedLow := (1 + math.Log(101)) / (1 + math.Log(2))
	expectedHigh := (1 + math.Log(10_001)) / (1 + math.Log(101))

	if math.Abs(ratioLow-expectedLow) > 1e-9 {
		t.Fatalf("unexpected low-range damping ratio: got %f want %f", ratioLow, expectedLow)
	}
	if math.Abs(ratioHigh-expectedHigh) > 1e-9 {
		t.Fatalf("unexpected high-range damping ratio: got %f want %f", ratioHigh, expectedHigh)
	}
	if !(ratioLow > ratioHigh) {
		t.Fatalf("expected stronger damping at low counts than high counts: low=%f high=%f", ratioLow, ratioHigh)
	}
}
