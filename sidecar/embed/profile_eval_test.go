package embed

import (
	"context"
	"fmt"
	"os"
	"sort"
	"strings"
	"testing"
	"time"
)

const rerankerWindowSize = 8

type evalDocument struct {
	ID   string
	Text string
}

type evalQuery struct {
	Name        string
	Text        string
	RelevantIDs []string
}

type stratifiedEvalCase struct {
	Category    string
	Query       string
	Docs        []string
	RelevantIdx int
}

type categoryResult struct {
	hits  int
	total int
}

type stratifiedMetrics struct {
	RecallAt1      float64
	RecallAt3      float64
	RecallAtWindow float64
	MRR            float64
	N              int
}

type evalResult struct {
	Name           string
	RecallAt1      float64
	RecallAt3      float64
	MeanReciprocal float64
	AvgDocEmbedMs  float64
	AvgQueryMs     float64
	Failures       []int
}

type evalProfile struct {
	name string
	cfg  Config
}

func TestEmbeddingProfileAgentMemoryEval(t *testing.T) {
	if os.Getenv("LIBRAVDB_RUN_EMBED_EVAL") != "1" {
		t.Skip("set LIBRAVDB_RUN_EMBED_EVAL=1 to run real embedding evaluation")
	}

	runtimePath := strings.TrimSpace(os.Getenv("LIBRAVDB_EVAL_ONNX_RUNTIME"))
	if runtimePath == "" {
		t.Skip("set LIBRAVDB_EVAL_ONNX_RUNTIME to evaluate real ONNX-backed embedders")
	}

	docs := evaluationCorpus()
	queries := evaluationQueries()

	filter := strings.TrimSpace(os.Getenv("LIBRAVDB_EVAL_PROFILE_FILTER"))
	debugRankings := os.Getenv("LIBRAVDB_EVAL_DEBUG") == "1"

	profiles := evaluationProfiles(runtimePath)

	for _, profile := range profiles {
		if filter != "" && filter != profile.name {
			continue
		}
		t.Run(profile.name, func(t *testing.T) {
			engine := NewWithConfig(profile.cfg)
			if !engine.Ready() {
				t.Fatalf("engine not ready: %s", engine.Reason())
			}
			t.Logf("engine mode=%s family=%s reason=%q dimensions=%d", engine.Mode(), engine.Profile().Family, engine.Reason(), engine.Dimensions())

			result, err := runEvaluation(t, engine, docs, queries, debugRankings)
			if err != nil {
				t.Fatalf("runEvaluation() error = %v", err)
			}

			t.Logf("profile=%s recall@1=%.3f recall@3=%.3f mrr=%.3f avg_doc_embed_ms=%.2f avg_query_ms=%.2f",
				result.Name, result.RecallAt1, result.RecallAt3, result.MeanReciprocal, result.AvgDocEmbedMs, result.AvgQueryMs)

			if result.RecallAt3 < 0.90 {
				t.Fatalf("recall@3 %.3f fell below success-metric target", result.RecallAt3)
			}
		})
	}
}

func TestFailureSetOverlap(t *testing.T) {
	if os.Getenv("LIBRAVDB_RUN_EMBED_EVAL") != "1" {
		t.Skip("set LIBRAVDB_RUN_EMBED_EVAL=1 to run real embedding evaluation")
	}

	runtimePath := strings.TrimSpace(os.Getenv("LIBRAVDB_EVAL_ONNX_RUNTIME"))
	if runtimePath == "" {
		t.Skip("set LIBRAVDB_EVAL_ONNX_RUNTIME to evaluate real ONNX-backed embedders")
	}

	docs := evaluationCorpus()
	queries := evaluationQueries()
	profiles := evaluationProfiles(runtimePath)
	results := make([]evalResult, 0, len(profiles))

	for _, profile := range profiles {
		engine := NewWithConfig(profile.cfg)
		if !engine.Ready() {
			t.Fatalf("engine %s not ready: %s", profile.name, engine.Reason())
		}
		result, err := runEvaluation(t, engine, docs, queries, false)
		if err != nil {
			t.Fatalf("runEvaluation(%s) error = %v", profile.name, err)
		}
		result.Name = profile.name
		t.Logf("%s failures=%v", profile.name, result.Failures)
		results = append(results, result)
	}

	for i := 0; i < len(results); i++ {
		for j := i + 1; j < len(results); j++ {
			jaccard := jaccardFailures(results[i].Failures, results[j].Failures)
			t.Logf("%s vs %s jaccard=%.3f", results[i].Name, results[j].Name, jaccard)
		}
	}
}

func TestStratifiedRecall(t *testing.T) {
	if os.Getenv("LIBRAVDB_RUN_EMBED_EVAL") != "1" {
		t.Skip("set LIBRAVDB_RUN_EMBED_EVAL=1 to run real embedding evaluation")
	}

	runtimePath := strings.TrimSpace(os.Getenv("LIBRAVDB_EVAL_ONNX_RUNTIME"))
	if runtimePath == "" {
		t.Skip("set LIBRAVDB_EVAL_ONNX_RUNTIME to evaluate real ONNX-backed embedders")
	}

	profiles := evaluationProfiles(runtimePath)
	results := map[string]map[string]*categoryResult{}
	cases := stratifiedHarnessCases()
	debugRankings := os.Getenv("LIBRAVDB_EVAL_DEBUG") == "1"

	for _, testCase := range cases {
		if results[testCase.Category] == nil {
			results[testCase.Category] = map[string]*categoryResult{}
		}
		for _, profile := range profiles {
			if results[testCase.Category][profile.name] == nil {
				results[testCase.Category][profile.name] = &categoryResult{}
			}
			entry := results[testCase.Category][profile.name]
			entry.total++

			engine := NewWithConfig(profile.cfg)
			if !engine.Ready() {
				t.Fatalf("engine %s not ready: %s", profile.name, engine.Reason())
			}
			if recallAtK(t, engine, testCase, 3, debugRankings) {
				entry.hits++
			}
		}
	}

	t.Log("")
	t.Log("Stratified recall@3 by category:")
	t.Logf("%-16s  %-24s  %-24s  %-24s",
		"Category", "MiniLM bundled", "MiniLM onnx", "Nomic onnx")
	t.Logf("%s", strings.Repeat("-", 92))

	for _, category := range []string{"lexical", "paraphrase", "cross-domain", "adversarial"} {
		row := results[category]
		if row == nil {
			continue
		}
		t.Logf("%-16s  %-24s  %-24s  %-24s",
			category,
			formatRecall(row["bundled-all-minilm-l6-v2"]),
			formatRecall(row["onnx-local-all-minilm-l6-v2"]),
			formatRecall(row["onnx-local-nomic-embed-text-v1.5"]))
	}
}

func TestStratifiedMetrics(t *testing.T) {
	if os.Getenv("LIBRAVDB_RUN_EMBED_EVAL") != "1" {
		t.Skip("set LIBRAVDB_RUN_EMBED_EVAL=1 to run real embedding evaluation")
	}

	runtimePath := strings.TrimSpace(os.Getenv("LIBRAVDB_EVAL_ONNX_RUNTIME"))
	if runtimePath == "" {
		t.Skip("set LIBRAVDB_EVAL_ONNX_RUNTIME to evaluate real ONNX-backed embedders")
	}

	profiles := evaluationProfiles(runtimePath)
	cases := stratifiedHarnessCases()
	byCategory := map[string][]stratifiedEvalCase{}
	for _, testCase := range cases {
		byCategory[testCase.Category] = append(byCategory[testCase.Category], testCase)
	}

	t.Log("")
	t.Log("Stratified metrics by category:")
	for _, category := range []string{"lexical", "paraphrase", "cross-domain", "adversarial"} {
		categoryCases := byCategory[category]
		if len(categoryCases) == 0 {
			continue
		}
		t.Logf("category=%s", category)
		for _, profile := range profiles {
			engine := NewWithConfig(profile.cfg)
			if !engine.Ready() {
				t.Fatalf("engine %s not ready: %s", profile.name, engine.Reason())
			}
			metrics, err := computeStratifiedMetrics(engine, categoryCases)
			if err != nil {
				t.Fatalf("computeStratifiedMetrics(%s, %s) error = %v", profile.name, category, err)
			}
			t.Logf("  profile=%s recall@1=%.3f recall@3=%.3f recall@window=%.3f mrr=%.3f n=%d",
				profile.name, metrics.RecallAt1, metrics.RecallAt3, metrics.RecallAtWindow, metrics.MRR, metrics.N)
		}
	}
}

func TestAdversarialFailureDiagnosis(t *testing.T) {
	if os.Getenv("LIBRAVDB_RUN_EMBED_EVAL") != "1" {
		t.Skip("set LIBRAVDB_RUN_EMBED_EVAL=1 to run real embedding evaluation")
	}

	runtimePath := strings.TrimSpace(os.Getenv("LIBRAVDB_EVAL_ONNX_RUNTIME"))
	if runtimePath == "" {
		t.Skip("set LIBRAVDB_EVAL_ONNX_RUNTIME to evaluate real ONNX-backed embedders")
	}

	cases := stratifiedHarnessCases()
	target := -1
	for i, testCase := range cases {
		if testCase.Category == "adversarial" && testCase.Query == "model confidence score" {
			target = i
			break
		}
	}
	if target < 0 {
		t.Fatalf("failed to locate adversarial diagnosis case")
	}

	testCase := cases[target]
	profiles := evaluationProfiles(runtimePath)
	for _, profile := range profiles {
		t.Run(profile.name, func(t *testing.T) {
			engine := NewWithConfig(profile.cfg)
			if !engine.Ready() {
				t.Fatalf("engine %s not ready: %s", profile.name, engine.Reason())
			}

			queryVec, err := engine.EmbedQuery(context.Background(), testCase.Query)
			if err != nil {
				t.Fatalf("EmbedQuery() error = %v", err)
			}

			type scored struct {
				Index int
				Score float64
			}
			scores := make([]scored, 0, len(testCase.Docs))
			for i, doc := range testCase.Docs {
				docVec, err := engine.EmbedDocument(context.Background(), doc)
				if err != nil {
					t.Fatalf("EmbedDocument(%d) error = %v", i, err)
				}
				scores = append(scores, scored{
					Index: i,
					Score: cosineEval(queryVec, docVec),
				})
			}

			sort.Slice(scores, func(i, j int) bool {
				if scores[i].Score == scores[j].Score {
					return scores[i].Index < scores[j].Index
				}
				return scores[i].Score > scores[j].Score
			})

			t.Logf("query=%q", testCase.Query)
			for rank, score := range scores {
				label := "distractor"
				if score.Index == testCase.RelevantIdx {
					label = "RELEVANT"
				}
				preview := testCase.Docs[score.Index]
				if len(preview) > 72 {
					preview = preview[:72]
				}
				t.Logf("rank=%d score=%.4f [%s] idx=%d %q",
					rank+1, score.Score, label, score.Index, preview)
			}

			var relevantScore float64
			foundRelevant := false
			for _, score := range scores {
				if score.Index == testCase.RelevantIdx {
					relevantScore = score.Score
					foundRelevant = true
					break
				}
			}
			if !foundRelevant {
				t.Fatalf("relevant document missing from scored results")
			}

			topDistractorScore := scores[0].Score
			if scores[0].Index == testCase.RelevantIdx && len(scores) > 1 {
				topDistractorScore = scores[1].Score
			}
			t.Logf("margin(relevant-top_distractor)=%.4f", relevantScore-topDistractorScore)
		})
	}
}

func TestCase2TruncationDiagnostic(t *testing.T) {
	if os.Getenv("LIBRAVDB_RUN_EMBED_EVAL") != "1" {
		t.Skip("set LIBRAVDB_RUN_EMBED_EVAL=1 to run real embedding evaluation")
	}

	runtimePath := strings.TrimSpace(os.Getenv("LIBRAVDB_EVAL_ONNX_RUNTIME"))
	if runtimePath == "" {
		t.Skip("set LIBRAVDB_EVAL_ONNX_RUNTIME to evaluate real ONNX-backed embedders")
	}

	docs := evaluationCorpus()
	relevantID := evaluationQueries()[2].RelevantIDs[0]
	doc := ""
	for _, candidate := range docs {
		if candidate.ID == relevantID {
			doc = candidate.Text
			break
		}
	}
	if doc == "" {
		t.Fatalf("failed to resolve relevant document for query index 2")
	}
	profiles := evaluationProfiles(runtimePath)

	for _, profile := range profiles {
		t.Run(profile.name, func(t *testing.T) {
			engine := NewWithConfig(profile.cfg)
			if !engine.Ready() {
				t.Fatalf("engine %s not ready: %s", profile.name, engine.Reason())
			}

			tokenCount, err := engine.TokenCountDocument(context.Background(), doc)
			if err != nil {
				t.Fatalf("TokenCountDocument() error = %v", err)
			}
			maxCtx := engine.Profile().MaxContextTokens
			effective := tokenCount
			if maxCtx > 0 && effective > maxCtx {
				effective = maxCtx
			}

			t.Logf("profile=%s token_count=%d max_context_tokens=%d effective_tokens=%d", profile.name, tokenCount, maxCtx, effective)
			if maxCtx > 0 && tokenCount > maxCtx {
				t.Logf("TRUNCATION ACTIVE: %d tokens exceed nominal profile window", tokenCount-maxCtx)
			}
		})
	}
}

func BenchmarkEmbeddingProfileAgentMemory(b *testing.B) {
	runtimePath := strings.TrimSpace(os.Getenv("LIBRAVDB_EVAL_ONNX_RUNTIME"))
	if runtimePath == "" {
		b.Skip("set LIBRAVDB_EVAL_ONNX_RUNTIME for embedding profile benchmarks")
	}

	benchmarks := evaluationProfiles(runtimePath)

	queries := evaluationQueries()
	for _, bench := range benchmarks {
		b.Run(bench.name, func(b *testing.B) {
			engine := NewWithConfig(bench.cfg)
			if !engine.Ready() {
				b.Fatalf("engine not ready: %s", engine.Reason())
			}

			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				query := queries[i%len(queries)]
				if _, err := engine.EmbedQuery(context.Background(), query.Text); err != nil {
					b.Fatalf("EmbedQuery() error = %v", err)
				}
			}
		})
	}
}

func runEvaluation(t *testing.T, engine *Engine, docs []evalDocument, queries []evalQuery, debugRankings bool) (evalResult, error) {
	type docEmbedding struct {
		ID     string
		Vector []float32
	}

	startDocs := time.Now()
	embeddedDocs := make([]docEmbedding, 0, len(docs))
	for _, doc := range docs {
		vec, err := engine.EmbedDocument(context.Background(), doc.Text)
		if err != nil {
			return evalResult{}, fmt.Errorf("embed doc %s: %w", doc.ID, err)
		}
		embeddedDocs = append(embeddedDocs, docEmbedding{ID: doc.ID, Vector: vec})
	}
	docElapsed := time.Since(startDocs)

	var hitsAt1, hitsAt3 int
	var reciprocalSum float64
	failures := make([]int, 0)
	startQueries := time.Now()
	for queryIndex, query := range queries {
		queryVec, err := engine.EmbedQuery(context.Background(), query.Text)
		if err != nil {
			return evalResult{}, fmt.Errorf("embed query %s: %w", query.Name, err)
		}

		type scored struct {
			ID    string
			Score float64
		}
		scoredDocs := make([]scored, 0, len(embeddedDocs))
		for _, doc := range embeddedDocs {
			scoredDocs = append(scoredDocs, scored{
				ID:    doc.ID,
				Score: cosineEval(doc.Vector, queryVec),
			})
		}
		sort.Slice(scoredDocs, func(i, j int) bool {
			if scoredDocs[i].Score == scoredDocs[j].Score {
				return scoredDocs[i].ID < scoredDocs[j].ID
			}
			return scoredDocs[i].Score > scoredDocs[j].Score
		})

		relevant := make(map[string]struct{}, len(query.RelevantIDs))
		for _, id := range query.RelevantIDs {
			relevant[id] = struct{}{}
		}

		if _, ok := relevant[scoredDocs[0].ID]; ok {
			hitsAt1++
		}

		topK := minEval(3, len(scoredDocs))
		foundTop3 := false
		for i := 0; i < topK; i++ {
			if _, ok := relevant[scoredDocs[i].ID]; ok {
				foundTop3 = true
				reciprocalSum += 1.0 / float64(i+1)
				break
			}
		}
		if foundTop3 {
			hitsAt3++
		} else if debugRankings {
			failures = append(failures, queryIndex)
			t.Logf("miss query=%s top3=%s(%.4f), %s(%.4f), %s(%.4f) relevant=%v",
				query.Name,
				scoredDocs[0].ID, scoredDocs[0].Score,
				scoredDocs[1].ID, scoredDocs[1].Score,
				scoredDocs[2].ID, scoredDocs[2].Score,
				query.RelevantIDs)
		} else {
			failures = append(failures, queryIndex)
		}
	}
	queryElapsed := time.Since(startQueries)

	return evalResult{
		Name:           engine.Profile().Family,
		RecallAt1:      float64(hitsAt1) / float64(len(queries)),
		RecallAt3:      float64(hitsAt3) / float64(len(queries)),
		MeanReciprocal: reciprocalSum / float64(len(queries)),
		AvgDocEmbedMs:  float64(docElapsed.Milliseconds()) / float64(len(docs)),
		AvgQueryMs:     float64(queryElapsed.Milliseconds()) / float64(len(queries)),
		Failures:       failures,
	}, nil
}

func evaluationProfiles(runtimePath string) []evalProfile {
	profiles := []evalProfile{
		{
			name: "bundled-all-minilm-l6-v2",
			cfg: Config{
				Backend:     "bundled",
				Profile:     "all-minilm-l6-v2",
				RuntimePath: runtimePath,
				Normalize:   true,
			},
		},
	}

	if miniLMDir := strings.TrimSpace(os.Getenv("LIBRAVDB_EVAL_MINILM_DIR")); miniLMDir != "" {
		profiles = append(profiles, evalProfile{
			name: "onnx-local-all-minilm-l6-v2",
			cfg: Config{
				Backend:     "onnx-local",
				Profile:     "all-minilm-l6-v2",
				RuntimePath: runtimePath,
				ModelPath:   miniLMDir,
			},
		})
	}

	if nomicDir := strings.TrimSpace(os.Getenv("LIBRAVDB_EVAL_NOMIC_DIR")); nomicDir != "" {
		profiles = append(profiles, evalProfile{
			name: "onnx-local-nomic-embed-text-v1.5",
			cfg: Config{
				Backend:     "onnx-local",
				Profile:     "nomic-embed-text-v1.5",
				RuntimePath: runtimePath,
				ModelPath:   nomicDir,
			},
		})
	}

	return profiles
}

func stratifiedHarnessCases() []stratifiedEvalCase {
	return []stratifiedEvalCase{
		{
			Category: "lexical",
			Query:    "user prefers dark theme",
			Docs: []string{
				"User has expressed a preference for dark mode in the UI settings.",
				"The system applies light theme by default on first launch.",
				"Notification preferences are stored separately from display settings.",
				"Accessibility settings allow higher contrast without changing the color theme.",
				"The account profile stores per-device interface customizations.",
			},
			RelevantIdx: 0,
		},
		{
			Category: "lexical",
			Query:    "compaction runs every session end",
			Docs: []string{
				"Memory compaction is triggered at the end of each active session.",
				"Embedding inference runs during document ingestion.",
				"The eviction policy removes stale model sessions after idle timeout.",
				"Session summaries are re-embedded after they are generated.",
				"Background maintenance can compact oversized collections on demand.",
			},
			RelevantIdx: 0,
		},
		{
			Category: "paraphrase",
			Query:    "the system is slow when loading for the first time",
			Docs: []string{
				"Initial model warmup requires loading ONNX weights from disk, which introduces a startup penalty before the first inference request.",
				"The first retrieval after process launch pays a one-time startup cost while the runtime and tokenizer are prepared.",
				"The sidecar process communicates with the host over a Unix domain socket.",
				"Session collections expire after the configured TTL elapses.",
				"The downloader verifies model hashes before placing assets into the shared model directory.",
			},
			RelevantIdx: 0,
		},
		{
			Category: "paraphrase",
			Query:    "teaching the model from past mistakes",
			Docs: []string{
				"When a recalled skill produces a failure outcome, its utility rate decreases and the system schedules an automatic rewrite.",
				"Low-quality memories receive steeper decay so future retrieval relies less heavily on them.",
				"The registry stores versioned skill definitions with prerequisite metadata.",
				"Collision strategies are weighted by historical insight quality ratings.",
				"A stale checkpoint can be restored if the active profile becomes corrupted.",
			},
			RelevantIdx: 0,
		},
		{
			Category: "cross-domain",
			Query:    "how does the system decide what to forget",
			Docs: []string{
				"Records that have not been accessed within the idle TTL accumulate a higher eviction priority score, making them candidates for removal from the active model registry.",
				"Less useful models gradually become more disposable as they sit idle and large in memory.",
				"The BM25 index scores documents by term frequency and inverse document frequency.",
				"Cross-encoder reranking refines the initial candidate set using a second model.",
				"Chunked embeddings are averaged across overlapping windows for long documents.",
			},
			RelevantIdx: 0,
		},
		{
			Category: "cross-domain",
			Query:    "experience makes you better at a task over time",
			Docs: []string{
				"The logarithmic frequency term in the eviction formula means that models accessed many times accumulate resistance to eviction that grows slower as usage increases, stabilizing long-term residents.",
				"Repeated use dampens future eviction pressure so long-serving models become harder to dislodge from memory.",
				"The tokenizer contract separates document and query encoding paths.",
				"Hybrid scoring combines cosine similarity with recency and scope signals.",
				"Vector dimensions must match the collection profile or reopen fails closed.",
			},
			RelevantIdx: 0,
		},
		{
			Category: "adversarial",
			Query:    "model confidence score",
			Docs: []string{
				"The model's confidence in its prediction was scored by the evaluator.",
				"The mean log-probability of generated tokens, exponentiated to [0,1], measures how certain the summarizer was about its output.",
				"The scoring pipeline multiplies retrieval rank by a summary-quality term derived from decay metadata.",
				"Registry status reports the currently loaded profile and dimensions.",
				"Model status includes size, last access time, and cumulative use count.",
			},
			RelevantIdx: 1,
		},
		{
			Category: "adversarial",
			Query:    "session memory cleanup",
			Docs: []string{
				"The IT team scheduled a session to discuss memory cleanup procedures for the legacy database.",
				"Compaction clusters raw conversation turns into summarized records and deletes the source turns after summary insertion is confirmed.",
				"Session records are inserted before source deletion so compaction cannot lose data on partial failure.",
				"The embedding model is loaded once and shared across all inference paths.",
				"Old model artifacts are removed from the cache after hash verification fails.",
			},
			RelevantIdx: 1,
		},
	}
}

func evaluationCorpus() []evalDocument {
	return []evalDocument{
		{
			ID:   "user_pref_terminal",
			Text: "User preference memory: prefers terminal-first workflows, hates hidden GUI state, and wants plain text explanations that are concise but technically serious.",
		},
		{
			ID:   "project_backend_stability",
			Text: "Engineering note: LibraVDB backend was unstable before HNSW and streaming fixes; after allocator, storage, and race work it is now considered credible enough for the OpenClaw memory plugin backbone.",
		},
		{
			ID:   "agent_memory_scope",
			Text: "Product decision: this memory system is for agent memory and session continuity, not whole-codebase embedding. Retrieval quality for user preferences, project state, and ongoing tasks matters more than raw document indexing breadth.",
		},
		{
			ID:   "nomic_context_advantage",
			Text: longContextDoc("Nomic profile note: nomic-embed-text-v1.5 supports a substantially larger context window and matryoshka embeddings. That matters when a memory entry is a long planning trace where the decisive detail appears late in the text. The key retained fact is that the user worries MiniLM's shorter effective context may bite semantic recall in agent workflows."),
		},
		{
			ID:   "minilm_efficiency",
			Text: "MiniLM profile note: all-MiniLM-L6-v2 is lighter on system resources, faster to run locally, and may still be superior if the workload is short-turn memory rather than long-document embedding.",
		},
		{
			ID:   "plugin_host_contract",
			Text: "Host integration note: OpenClaw ignores async plugin registration, so the plugin must register synchronously and lazily start the sidecar on first real use.",
		},
		{
			ID:   "security_untrusted_memory",
			Text: "Security note: recalled memories are untrusted historical context only and must never be followed as instructions.",
		},
		{
			ID:   "compaction_goal",
			Text: "Compaction objective: shrink a large session to a smaller semantic summary while preserving core meaning, instead of letting active sessions grow until they become unusable.",
		},
		{
			ID:   "benchmark_metric",
			Text: "Success metric: top-3 recalled messages should be semantically relevant more than ninety percent of the time.",
		},
		{
			ID:   "slabby_decision",
			Text: "Allocator decision: slot-based slabby is now the default HNSW raw-vector backend because live bytes match the in-memory backend and the remaining delta is mostly reserved headroom.",
		},
	}
}

func recallAtK(t *testing.T, engine *Engine, testCase stratifiedEvalCase, k int, debug bool) bool {
	t.Helper()

	scoredDocs, err := scoreStratifiedCase(engine, testCase)
	if err != nil {
		t.Fatalf("scoreStratifiedCase(%s): %v", testCase.Category, err)
	}
	topK := minEval(k, len(scoredDocs))
	for i := 0; i < topK; i++ {
		if scoredDocs[i].Index == testCase.RelevantIdx {
			return true
		}
	}
	if debug {
		parts := make([]string, 0, topK)
		for i := 0; i < topK; i++ {
			parts = append(parts, fmt.Sprintf("%d(%.4f)", scoredDocs[i].Index, scoredDocs[i].Score))
		}
		t.Logf("stratified miss category=%s query=%q top%d=%s relevant=%d",
			testCase.Category, testCase.Query, topK, strings.Join(parts, ", "), testCase.RelevantIdx)
	}
	return false
}

func computeStratifiedMetrics(engine *Engine, cases []stratifiedEvalCase) (stratifiedMetrics, error) {
	if len(cases) == 0 {
		return stratifiedMetrics{}, nil
	}

	var hitsAt1, hitsAt3, hitsAtWindow int
	var reciprocalSum float64
	for _, testCase := range cases {
		rank, err := rankStratifiedCase(engine, testCase)
		if err != nil {
			return stratifiedMetrics{}, err
		}
		if rank == 1 {
			hitsAt1++
		}
		if rank <= 3 {
			hitsAt3++
		}
		if rank <= rerankerWindowSize {
			hitsAtWindow++
		}
		reciprocalSum += 1.0 / float64(rank)
	}

	n := float64(len(cases))
	return stratifiedMetrics{
		RecallAt1:      float64(hitsAt1) / n,
		RecallAt3:      float64(hitsAt3) / n,
		RecallAtWindow: float64(hitsAtWindow) / n,
		MRR:            reciprocalSum / n,
		N:              len(cases),
	}, nil
}

func rankStratifiedCase(engine *Engine, testCase stratifiedEvalCase) (int, error) {
	scoredDocs, err := scoreStratifiedCase(engine, testCase)
	if err != nil {
		return 0, err
	}
	for rank, score := range scoredDocs {
		if score.Index == testCase.RelevantIdx {
			return rank + 1, nil
		}
	}
	return len(testCase.Docs) + 1, nil
}

func scoreStratifiedCase(engine *Engine, testCase stratifiedEvalCase) ([]struct {
	Index int
	Score float64
}, error) {
	embeddedDocs := make([][]float32, 0, len(testCase.Docs))
	for _, doc := range testCase.Docs {
		vec, err := engine.EmbedDocument(context.Background(), doc)
		if err != nil {
			return nil, err
		}
		embeddedDocs = append(embeddedDocs, vec)
	}

	queryVec, err := engine.EmbedQuery(context.Background(), testCase.Query)
	if err != nil {
		return nil, err
	}

	scoredDocs := make([]struct {
		Index int
		Score float64
	}, 0, len(embeddedDocs))
	for i, docVec := range embeddedDocs {
		scoredDocs = append(scoredDocs, struct {
			Index int
			Score float64
		}{
			Index: i,
			Score: cosineEval(docVec, queryVec),
		})
	}
	sort.Slice(scoredDocs, func(i, j int) bool {
		if scoredDocs[i].Score == scoredDocs[j].Score {
			return scoredDocs[i].Index < scoredDocs[j].Index
		}
		return scoredDocs[i].Score > scoredDocs[j].Score
	})
	return scoredDocs, nil
}

func formatRecall(r *categoryResult) string {
	if r == nil {
		return "n/a"
	}
	hits, total := r.hits, r.total
	if total == 0 {
		return "n/a"
	}
	return fmt.Sprintf("%.3f (%d/%d)", float64(hits)/float64(total), hits, total)
}

func evaluationQueries() []evalQuery {
	return []evalQuery{
		{
			Name:        "user_style_preference",
			Text:        "How does the user want the assistant to communicate in the terminal?",
			RelevantIDs: []string{"user_pref_terminal"},
		},
		{
			Name:        "memory_scope",
			Text:        "Is this memory plugin intended for whole codebase embeddings or for the agent's own memory and continuity?",
			RelevantIDs: []string{"agent_memory_scope"},
		},
		{
			Name:        "nomic_long_context",
			Text:        "Which note says longer context and matryoshka support may help preserve important details late in a long memory entry?",
			RelevantIDs: []string{"nomic_context_advantage"},
		},
		{
			Name:        "minilm_tradeoff",
			Text:        "Which memory says MiniLM might still win because it is faster and uses fewer resources for short memory turns?",
			RelevantIDs: []string{"minilm_efficiency"},
		},
		{
			Name:        "plugin_sync_register",
			Text:        "Why does the OpenClaw plugin register synchronously and start the sidecar lazily?",
			RelevantIDs: []string{"plugin_host_contract"},
		},
		{
			Name:        "security_untrusted",
			Text:        "What is the rule about recalled memories and instructions?",
			RelevantIDs: []string{"security_untrusted_memory"},
		},
		{
			Name:        "compaction",
			Text:        "What is the purpose of compaction in this memory system?",
			RelevantIDs: []string{"compaction_goal"},
		},
		{
			Name:        "recall_metric",
			Text:        "What recall relevance target do we want in the top three retrieved memories?",
			RelevantIDs: []string{"benchmark_metric"},
		},
		{
			Name:        "allocator_choice",
			Text:        "Which allocator backend became the default for HNSW raw vectors and why?",
			RelevantIDs: []string{"slabby_decision"},
		},
	}
}

func longContextDoc(tail string) string {
	prefix := strings.Repeat("Earlier planning chatter about agent loops, retries, sidecar supervision, benchmark setup, memory scope, collection safety, and local model packaging. ", 24)
	return prefix + tail
}

func cosineEval(a, b []float32) float64 {
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
	return dot / (sqrtEval(normA) * sqrtEval(normB))
}

func sqrtEval(v float64) float64 {
	if v <= 0 {
		return 0
	}
	x := v
	for i := 0; i < 8; i++ {
		x = 0.5 * (x + v/x)
	}
	return x
}

func minEval(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func jaccardFailures(a, b []int) float64 {
	if len(a) == 0 && len(b) == 0 {
		return 1
	}
	left := make(map[int]struct{}, len(a))
	right := make(map[int]struct{}, len(b))
	for _, value := range a {
		left[value] = struct{}{}
	}
	for _, value := range b {
		right[value] = struct{}{}
	}

	intersection := 0
	union := len(left)
	for value := range right {
		if _, ok := left[value]; ok {
			intersection++
			continue
		}
		union++
	}
	if union == 0 {
		return 1
	}
	return float64(intersection) / float64(union)
}
