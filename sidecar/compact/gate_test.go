package compact

import (
	"math"
	"testing"

	"github.com/xDarkicex/openclaw-memory-libravdb/sidecar/store"
)

func TestHEmptyMemory(t *testing.T) {
	sig := ComputeGating(nil, nil, "any text", DefaultGatingConfig())
	if sig.H != 1.0 {
		t.Errorf("H = %.6f, want 1.0 for empty memory", sig.H)
	}
}

func TestRSaturationVetoes(t *testing.T) {
	turnHits := hitsWithScore(10, 0.95)
	memHits := hitsWithScore(5, 0.95)
	sig := ComputeGating(turnHits, memHits, "any text", DefaultGatingConfig())
	if sig.R != 0.0 {
		t.Errorf("R = %.6f, want 0.0 when memory saturated", sig.R)
	}
}

func TestGConvexBound(t *testing.T) {
	for _, text := range []string{"hello", "func main() {}", "```go\nfmt.Println()\n```"} {
		sig := ComputeGating(nil, nil, text, DefaultGatingConfig())
		if sig.G < 0.0 || sig.G > 1.0 {
			t.Errorf("G = %.6f out of [0,1] for text %q", sig.G, text)
		}
		lo := math.Min(sig.Gconv, sig.Gtech)
		hi := math.Max(sig.Gconv, sig.Gtech)
		if sig.G < lo-1e-9 || sig.G > hi+1e-9 {
			t.Errorf("G = %.6f not in [Gconv=%.6f, Gtech=%.6f]", sig.G, sig.Gconv, sig.Gtech)
		}
	}
}

func TestPurelyConversationalUsesConvFormula(t *testing.T) {
	text := "I prefer dark mode and work best in the mornings"
	sig := ComputeGating(nil, nil, text, DefaultGatingConfig())
	if sig.T > 0.05 {
		t.Skipf("text triggered T=%.2f, not purely conversational", sig.T)
	}
	if math.Abs(sig.G-sig.Gconv) > 1e-9 {
		t.Errorf("G=%.9f ≠ Gconv=%.9f when T=0", sig.G, sig.Gconv)
	}
}

func TestPurelyTechnicalUsesTechFormula(t *testing.T) {
	text := "```go\nfunc (s *Store) InsertRecord(ctx context.Context) error {\n}\n```"
	sig := ComputeGating(nil, nil, text, DefaultGatingConfig())
	if sig.T < 0.95 {
		t.Skipf("text triggered T=%.2f, not purely technical", sig.T)
	}
	if math.Abs(sig.G-sig.Gtech) > 1e-9 {
		t.Errorf("G=%.9f ≠ Gtech=%.9f when T=1", sig.G, sig.Gtech)
	}
}

func TestDNLDoesNotFireOnCode(t *testing.T) {
	code := "func NewMatryoshkaVec(full []float32) (MatryoshkaVec, error) {"
	sig := ComputeGating(nil, nil, code, DefaultGatingConfig())
	if sig.D > 0.3 {
		t.Errorf("D_nl = %.4f overfiring on code text", sig.D)
	}
}

func TestEstimateTokensUsesStableByteHeuristic(t *testing.T) {
	if got := EstimateTokens("abcd"); got != 1 {
		t.Fatalf("EstimateTokens(\"abcd\") = %d, want 1", got)
	}
	if got := EstimateTokens("abcdefgh"); got != 2 {
		t.Fatalf("EstimateTokens(\"abcdefgh\") = %d, want 2", got)
	}
}

func hitsWithScore(n int, score float64) []store.SearchResult {
	hits := make([]store.SearchResult, n)
	for i := range hits {
		hits[i] = store.SearchResult{ID: string(rune('a' + i)), Score: score}
	}
	return hits
}
