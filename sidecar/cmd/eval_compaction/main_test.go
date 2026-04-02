package main

import (
	"reflect"
	"testing"
)

func TestParseThresholdsSortsDedupesAndClamps(t *testing.T) {
	got, err := parseThresholds("0.85, 0.65, 1.5, 0.65, -0.25")
	if err != nil {
		t.Fatalf("parseThresholds() error = %v", err)
	}
	want := []float64{0, 0.65, 0.85, 1}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("parseThresholds() = %v, want %v", got, want)
	}
}

func TestParseThresholdsRejectsEmptyList(t *testing.T) {
	if _, err := parseThresholds(" , "); err == nil {
		t.Fatalf("expected error for empty thresholds")
	}
}
