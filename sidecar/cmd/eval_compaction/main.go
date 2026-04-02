package main

import (
	"context"
	"flag"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"

	"github.com/xDarkicex/openclaw-memory-libravdb/sidecar/compact"
	"github.com/xDarkicex/openclaw-memory-libravdb/sidecar/embed"
	"github.com/xDarkicex/openclaw-memory-libravdb/sidecar/summarize"
)

type evalCase struct {
	Name  string
	Query string
	Turns []summarize.Turn
}

type metrics struct {
	Align float64
	Cover float64
}

func main() {
	var modelRoot string
	var thresholdCSV string
	flag.StringVar(&modelRoot, "models", "", "path to local model assets")
	flag.StringVar(&thresholdCSV, "thresholds", "0.65,0.75,0.85", "comma-separated preservation thresholds to summarize")
	flag.Parse()

	if strings.TrimSpace(modelRoot) == "" {
		var err error
		modelRoot, err = resolveModelRoot()
		if err != nil {
			fail(err)
		}
	}

	runtimePath := filepath.Join(modelRoot, "onnxruntime", "onnxruntime-osx-arm64-1.23.0", "lib", "libonnxruntime.dylib")
	nomicDir := filepath.Join(modelRoot, "nomic-embed-text-v1.5")
	t5Dir := filepath.Join(modelRoot, "t5-small")

	if err := requireFile(runtimePath); err != nil {
		fail(err)
	}
	if err := requireFile(filepath.Join(nomicDir, "embedding.json")); err != nil {
		fail(err)
	}
	if err := requireFile(filepath.Join(t5Dir, "summarizer.json")); err != nil {
		fail(err)
	}

	ctx := context.Background()
	embedder := embed.NewWithConfig(embed.Config{
		Backend:     "onnx-local",
		Profile:     "nomic-embed-text-v1.5",
		RuntimePath: runtimePath,
		ModelPath:   nomicDir,
		Normalize:   true,
	})
	if !embedder.Ready() {
		fail(fmt.Errorf("embedder not ready: %s", embedder.Reason()))
	}

	t5 := summarize.NewWithDeps(summarize.Config{
		Backend:     "onnx-local",
		Profile:     "t5-small",
		RuntimePath: runtimePath,
		ModelPath:   t5Dir,
	}, summarize.Dependencies{
		Embedder: embedder,
	})
	if !t5.Ready() {
		fail(fmt.Errorf("summarizer not ready: %s", t5.Reason()))
	}

	cases := []evalCase{
		{
			Name:  "auth_migration",
			Query: "Why was the auth flow changed and what storage strategy was adopted?",
			Turns: []summarize.Turn{
				{ID: "1", Text: "The old auth middleware was removed because it duplicated token refresh logic and caused stale sessions after a browser tab resumed from sleep."},
				{ID: "2", Text: "We switched to signed short-lived access tokens plus a rotating refresh token stored in the database so revoked sessions can be invalidated centrally."},
				{ID: "3", Text: "The migration also added audit logging for refresh failures and a backfill for legacy cookie-only sessions."},
			},
		},
		{
			Name:  "compaction_boundary",
			Query: "What continuity rule was adopted for compaction boundaries?",
			Turns: []summarize.Turn{
				{ID: "1", Text: "We decided compaction must never cut through the recent tail because the tail preserves live discourse continuity."},
				{ID: "2", Text: "A bundle-safe extension was added so tightly coupled neighboring turns remain together when a boundary would split a decision from its explanation."},
				{ID: "3", Text: "The result is shortest suffix preservation plus optional extension, not a fixed-size tail regardless of semantic coupling."},
			},
		},
		{
			Name:  "gating_math",
			Query: "How does the gate keep novelty mathematically bounded?",
			Turns: []summarize.Turn{
				{ID: "1", Text: "The novelty term should not exceed one even if some nearest neighbors have negative cosine similarity."},
				{ID: "2", Text: "We fixed that by clamping each cosine contribution with max(0, cos) before averaging, so negative neighbors stop inflating novelty."},
				{ID: "3", Text: "That keeps the conversational branch inside the convex bound proof for the overall gating scalar."},
			},
		},
		{
			Name:  "release_pipeline",
			Query: "Why did the release pipeline fail and what was the fix?",
			Turns: []summarize.Turn{
				{ID: "1", Text: "The npm package was missing because the publish workflow never ran when releases were created by another workflow instead of a direct push tag."},
				{ID: "2", Text: "We fixed it by dispatching the npm publish workflow explicitly from the release workflow so GitHub release creation and package publication stay linked."},
				{ID: "3", Text: "Local path installs had hidden the issue because install-from-checkout worked even when the registry package did not exist."},
			},
		},
		{
			Name:  "adversarial_multi_fact",
			Query: "What were the three specific migration changes?",
			Turns: []summarize.Turn{
				{ID: "1", Text: "The migration renamed the RPC method from memoryPromptSection to buildMemorySection so the host and sidecar used the same contract."},
				{ID: "2", Text: "It also moved session cache invalidation to happen only on durable user writes, not on every search."},
				{ID: "3", Text: "Finally, it changed recency decay constants from per-millisecond math to per-second math because the old lambdas were off by three orders of magnitude."},
			},
		},
		{
			Name:  "adversarial_conflicting_errors",
			Query: "Which concrete failures occurred and in which subsystem?",
			Turns: []summarize.Turn{
				{ID: "1", Text: "The macOS daemon boot failed with dyld: Library not loaded: libonnxruntime.dylib after the runtime archive was copied but not unpacked."},
				{ID: "2", Text: "The GitHub publish path failed separately because the release workflow created a release without dispatching the npm publish workflow."},
				{ID: "3", Text: "A third failure came from the setup health check hanging on socket open in CI because the environment blocked local listener readiness."},
			},
		},
		{
			Name:  "adversarial_dense_go_code",
			Query: "What exact logic bug and fix were discussed in the code?",
			Turns: []summarize.Turn{
				{ID: "1", Text: "func computeH(hits []SearchResult) float64 { if len(hits)==0 { return 1.0 }; var sum float64; for _, hit := range hits { sum += hit.Score }; return 1.0 - (sum / float64(len(hits))) } caused H to exceed one when cosine scores were negative."},
				{ID: "2", Text: "The proposed fix was func computeH(...) { ... sum += math.Max(hit.Score, 0.0) ... } so negative neighbors stop inflating novelty and the convex bound proof remains valid."},
				{ID: "3", Text: "The regression test should include scores {-0.9, -0.2, 0.0} and assert H == 1.0, plus a mixed case {0.75, -0.25} yielding H = 1 - 0.75/2."},
			},
		},
		{
			Name:  "adversarial_four_way_decision_bundle",
			Query: "What four independent architectural decisions were made?",
			Turns: []summarize.Turn{
				{ID: "1", Text: "Decision one: AGENTS.md must forbid tasks-build.pl and memory-build.pl unless the user wraps the exact command in XML command tags."},
				{ID: "2", Text: "Decision two: gating novelty must zero-clamp negative cosine terms so the conversational branch remains bounded."},
				{ID: "3", Text: "Decision three: continuity must preserve the recent tail as the shortest valid suffix with bundle-safe extension rather than a rigid fixed count."},
				{ID: "4", Text: "Decision four: compaction confidence should be judged in Nomic space first, with T5 logits treated only as auxiliary decoder stability."},
			},
		},
		{
			Name:  "adversarial_many_numbers",
			Query: "Which thresholds and constants mattered here?",
			Turns: []summarize.Turn{
				{ID: "1", Text: "The gating branch weights are 0.35, 0.40, 0.25 for conversational and 0.40, 0.35, 0.25 for technical, with threshold 0.35 and technical normalization 1.5."},
				{ID: "2", Text: "Compaction routes clusters to the abstractive summarizer at mean gating score 0.60, uses max output tokens 64, and now applies a preservation threshold of 0.65 with lambda 0.8."},
				{ID: "3", Text: "Matryoshka early exit thresholds remain 0.65 for 64d and 0.75 for 256d, with a 50 millisecond budget on the cascade search."},
			},
		},
		{
			Name:  "adversarial_boundary_vs_progress",
			Query: "What tension between continuity and compaction progress was resolved?",
			Turns: []summarize.Turn{
				{ID: "1", Text: "Continuity requires that the recent tail remain uncompressed so live discourse and unresolved references are preserved verbatim."},
				{ID: "2", Text: "At the same time, compaction must prove positive progress: if a cluster is replaced, the resulting representation must be strictly smaller or the system should decline compaction."},
				{ID: "3", Text: "The resolution was to compact only V_rest, preserve the shortest valid recent suffix, and require bundle-safe extension so decisions do not lose their supporting explanation."},
			},
		},
		{
			Name:  "adversarial_cross_domain_mix",
			Query: "What was actually decided across product, math, and infra?",
			Turns: []summarize.Turn{
				{ID: "1", Text: "Product decision: this plugin is agent memory and session continuity, not a whole-codebase embedding index."},
				{ID: "2", Text: "Math decision: summary confidence must be retrieval-grounded in Nomic space because decoder certainty alone is not semantic fidelity."},
				{ID: "3", Text: "Infra decision: local ONNX inference stays mandatory for the critical retrieval path so the plugin remains deterministic and offline-capable."},
			},
		},
		{
			Name:  "adversarial_token_budget_rules",
			Query: "What exact token-budget and estimator distinctions mattered?",
			Turns: []summarize.Turn{
				{ID: "1", Text: "The gating subsystem uses EstimateTokens(text) = max(floor(RuneCount(text)/4), 1), which is intentionally cheap and distinct from the host prompt-budget estimator."},
				{ID: "2", Text: "Prompt packing is budgeted separately in the TypeScript host, so docs must not imply the gating byte heuristic is a true tokenizer or the same contract as prompt assembly."},
				{ID: "3", Text: "That distinction matters because technical specificity normalizes by the cheap estimator while final retrieval assembly still obeys a real bounded prompt budget."},
			},
		},
		{
			Name:  "adversarial_conflicting_resolutions",
			Query: "What exact root cause and fix was adopted?",
			Turns: []summarize.Turn{
				{ID: "1", Text: "One proposal blamed the socket timeout on the daemon failing to bind its Unix path because an old stale file was still present from a crashed process."},
				{ID: "2", Text: "A conflicting proposal blamed the same timeout on the host speaking the old memoryPromptSection RPC name after the daemon had already upgraded to buildMemorySection."},
				{ID: "3", Text: "The final resolution was neither of those: the real issue was the release installer never unpacked the ONNX runtime, so the daemon crashed before listening and the host only saw a downstream timeout."},
			},
		},
		{
			Name:  "adversarial_long_noisy_code_trace",
			Query: "Which exact invariant and code change mattered?",
			Turns: []summarize.Turn{
				{ID: "1", Text: "panic: invariant violated in AssembleContext at context-engine.ts:171 because the previous implementation searched session memory and then also injected the same recent turns again in the prompt. Stack trace fragment: buildContextEngineFactory -> assemble -> scoreCandidates -> fitPromptBudget -> buildMemoryHeader. The crucial invariant was that only V_rest participates in semantic retrieval once T_recent is carved out."},
				{ID: "2", Text: "The fix was to compute T_base and T_recent before session search, exclude every recent-tail record ID from search_text, and reserve tail tokens before ranking any remaining session summaries or turns. All other stack trace details were diagnostic noise around that single boundary invariant."},
				{ID: "3", Text: "A follow-up test was required to prove the raw recent tail appears under recent_session_tail while recalled_memories only contains older V_rest hits. Without that test the double-injection bug could regress silently."},
			},
		},
		{
			Name:  "adversarial_topic_shift_generic_bait",
			Query: "What specific product/math split was decided?",
			Turns: []summarize.Turn{
				{ID: "1", Text: "The product scope is agent memory and continuity, not whole-repository semantic search, so recall quality is defined around plans, user preferences, active tasks, and local discourse state."},
				{ID: "2", Text: "The mathematical constraint is that authored I1, authored I2 prefix, exact T_recent, and retrieved V_rest must fit a single prompt budget without silently truncating the hard tiers."},
				{ID: "3", Text: "A generic summary like 'the project improved its memory system and refined the architecture' would be locally fluent but semantically useless because it drops the product boundary and the specific assembly equation that actually govern the system."},
			},
		},
		{
			Name:  "adversarial_near_duplicate_thresholds",
			Query: "Which threshold belonged to which subsystem?",
			Turns: []summarize.Turn{
				{ID: "1", Text: "The compaction preservation gate uses threshold 0.65 on centroid alignment Q_align before accepting an abstractive summary."},
				{ID: "2", Text: "The Matryoshka search path uses 0.65 only for the 64d early-exit tier; the 256d early-exit threshold is 0.75 and should not be conflated with the compaction gate."},
				{ID: "3", Text: "Another nearby constant is lambda = 0.8 for Nomic-heavy confidence mixing, which is not a search threshold at all and must not be collapsed into the gate or cascade logic."},
			},
		},
	}
	thresholds, err := parseThresholds(thresholdCSV)
	if err != nil {
		fail(err)
	}
	thresholdTrips := make(map[float64][]string, len(thresholds))
	defaultTrips := make([]string, 0)

	extractive := summarize.NewExtractive(embedder, "extractive")

	fmt.Printf("case\traw_method\traw_conf\traw_align\traw_cover\tfinal_method\tfinal_conf\tfinal_align\tfinal_cover\tdelta_conf\traw_text\tfinal_text\n")
	for _, tc := range cases {
		raw, err := t5.Summarize(ctx, tc.Turns, summarize.SummaryOpts{
			MinInputTurns:   1,
			MaxOutputTokens: 64,
		})
		if err != nil {
			fail(fmt.Errorf("%s: summarize: %w", tc.Name, err))
		}
		rawMetrics, err := preservationMetrics(ctx, embedder, tc.Turns, raw.Text)
		if err != nil {
			fail(fmt.Errorf("%s: metrics: %w", tc.Name, err))
		}
		finalSummary, finalConf, finalMetrics, err := applyPlannedPolicy(ctx, extractive, embedder, tc.Turns, raw)
		if err != nil {
			fail(fmt.Errorf("%s: planned policy: %w", tc.Name, err))
		}
		if rawMetrics.Align < compact.PreservationThreshold {
			defaultTrips = append(defaultTrips, tc.Name)
		}
		for _, threshold := range thresholds {
			if rawMetrics.Align < threshold {
				thresholdTrips[threshold] = append(thresholdTrips[threshold], tc.Name)
			}
		}
		fmt.Printf("%s\t%s\t%.4f\t%.4f\t%.4f\t%s\t%.4f\t%.4f\t%.4f\t%.4f\t%s\t%s\n",
			tc.Name,
			raw.Method,
			raw.Confidence,
			rawMetrics.Align,
			rawMetrics.Cover,
			finalSummary.Method,
			finalConf,
			finalMetrics.Align,
			finalMetrics.Cover,
			finalConf-raw.Confidence,
			oneLine(raw.Text),
			oneLine(finalSummary.Text),
		)
	}

	fmt.Println()
	fmt.Printf("threshold\ttrip_count\tcases\n")
	for _, threshold := range thresholds {
		cases := append([]string(nil), thresholdTrips[threshold]...)
		slices.Sort(cases)
		fmt.Printf("%.2f\t%d\t%s\n", threshold, len(cases), strings.Join(cases, ","))
	}
	fmt.Printf("default_threshold_%.2f\t%d\t%s\n", compact.PreservationThreshold, len(defaultTrips), strings.Join(defaultTrips, ","))
}

func applyPlannedPolicy(ctx context.Context, extractive summarize.Summarizer, e embed.Embedder, turns []summarize.Turn, raw summarize.Summary) (summarize.Summary, float64, metrics, error) {
	rawMetrics, err := preservationMetrics(ctx, e, turns, raw.Text)
	if err != nil {
		return summarize.Summary{}, 0, metrics{}, err
	}
	confNomic := clamp01((rawMetrics.Align + rawMetrics.Cover) / 2.0)
	confT5 := clamp01(raw.Confidence)
	if rawMetrics.Align < compact.PreservationThreshold {
		fallback, err := extractive.Summarize(ctx, turns, summarize.SummaryOpts{
			MinInputTurns:   1,
			MaxOutputTokens: 64,
		})
		if err != nil {
			return summarize.Summary{}, 0, metrics{}, err
		}
		fallbackMetrics, err := preservationMetrics(ctx, e, turns, fallback.Text)
		if err != nil {
			return summarize.Summary{}, 0, metrics{}, err
		}
		fallbackConf := clamp01((fallbackMetrics.Align + fallbackMetrics.Cover) / 2.0)
		fallback.Confidence = fallbackConf
		return fallback, fallbackConf, fallbackMetrics, nil
	}
	finalConf := clamp01(compact.NomicConfidenceWeight*confNomic + (1.0-compact.NomicConfidenceWeight)*confT5)
	raw.Confidence = finalConf
	return raw, finalConf, rawMetrics, nil
}

func preservationMetrics(ctx context.Context, e embed.Embedder, turns []summarize.Turn, summary string) (metrics, error) {
	if len(turns) == 0 {
		return metrics{}, fmt.Errorf("no turns")
	}
	summaryVec, err := e.EmbedDocument(ctx, summary)
	if err != nil {
		return metrics{}, err
	}
	vectors := make([][]float32, 0, len(turns))
	for _, turn := range turns {
		vec, err := e.EmbedDocument(ctx, turn.Text)
		if err != nil {
			return metrics{}, err
		}
		vectors = append(vectors, vec)
	}
	centroid := meanVector(vectors)
	out := metrics{
		Align: cosine(summaryVec, centroid),
	}
	for _, vec := range vectors {
		out.Cover += math.Max(0, cosine(summaryVec, vec))
	}
	out.Cover /= float64(len(vectors))
	return out, nil
}

func meanVector(vectors [][]float32) []float32 {
	if len(vectors) == 0 {
		return nil
	}
	out := make([]float32, len(vectors[0]))
	scale := float32(len(vectors))
	for _, vec := range vectors {
		for i, value := range vec {
			out[i] += value
		}
	}
	for i := range out {
		out[i] /= scale
	}
	return out
}

func cosine(a, b []float32) float64 {
	if len(a) == 0 || len(a) != len(b) {
		return 0
	}
	var dot, normA, normB float64
	for i := range a {
		av := float64(a[i])
		bv := float64(b[i])
		dot += av * bv
		normA += av * av
		normB += bv * bv
	}
	if normA == 0 || normB == 0 {
		return 0
	}
	return dot / (math.Sqrt(normA) * math.Sqrt(normB))
}

func oneLine(text string) string {
	text = strings.TrimSpace(text)
	text = strings.ReplaceAll(text, "\n", " ")
	return strings.Join(strings.Fields(text), " ")
}

func clamp01(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 1 {
		return 1
	}
	return v
}

func requireFile(path string) error {
	if _, err := os.Stat(path); err != nil {
		return fmt.Errorf("required asset missing: %s", path)
	}
	return nil
}

func resolveModelRoot() (string, error) {
	candidates := []string{
		filepath.Clean(".models"),
		filepath.Clean("../.models"),
		filepath.Clean("../../.models"),
	}
	for _, candidate := range candidates {
		if _, err := os.Stat(filepath.Join(candidate, "nomic-embed-text-v1.5", "embedding.json")); err == nil {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("could not resolve .models directory from current working directory")
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, err.Error())
	os.Exit(1)
}

func parseThresholds(raw string) ([]float64, error) {
	parts := strings.Split(raw, ",")
	out := make([]float64, 0, len(parts))
	seen := make(map[float64]struct{}, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		value, err := strconv.ParseFloat(part, 64)
		if err != nil {
			return nil, fmt.Errorf("invalid threshold %q: %w", part, err)
		}
		value = clamp01(value)
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("at least one threshold is required")
	}
	slices.Sort(out)
	return out, nil
}
