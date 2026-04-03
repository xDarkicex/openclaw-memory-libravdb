package astv2

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

type deonticEvalCase struct {
	Name           string
	Source         string
	Text           string
	BehavioralRule bool
	ExpectPromoted bool
	Reason         string
}

type deonticEvalMetrics struct {
	BehavioralTotal int
	LoreTotal       int
	TruePositive    int
	TrueNegative    int
	FalsePositive   int
	FalseNegative   int
}

type deonticLabeledCase struct {
	Name           string
	Source         string
	Text           string
	BehavioralRule bool
	Reason         string
}

func (m deonticEvalMetrics) FalsePositiveRate() float64 {
	if m.LoreTotal == 0 {
		return 0
	}
	return float64(m.FalsePositive) / float64(m.LoreTotal)
}

func (m deonticEvalMetrics) FalseNegativeRate() float64 {
	if m.BehavioralTotal == 0 {
		return 0
	}
	return float64(m.FalseNegative) / float64(m.BehavioralTotal)
}

func TestDeonticLabeledCorpusHarness(t *testing.T) {
	t.Parallel()

	runDeonticCorpus(t, "seeded", deonticEvaluationCorpus(), 0.10, 0.10)
}

func TestDeonticRealAuthoredCorpusHarness(t *testing.T) {
	t.Parallel()

	// This corpus uses real paragraphs pulled from repository-authored project
	// docs. It is useful as adjacent prose, but it is not the primary AST-v2
	// target family for agents.md / souls.md style identity files.
	runDeonticCorpus(t, "real-authored", deonticRealAuthoredCorpus(), 0.10, 0.30)
}

func TestDeonticExternalAgentSoulStyleCorpusHarness(t *testing.T) {
	t.Parallel()

	// This corpus is closer to the true AST-v2 target: externally sourced
	// AGENTS / AGENT / agents / soul-style Markdown guidance.
	runDeonticCorpus(t, "agent-soul-style", deonticExternalAgentSoulStyleCorpus(), 0.10, 0.75)
}

func TestDeonticUserProvidedAgentSoulCorpusHarness(t *testing.T) {
	t.Parallel()

	// This file-backed corpus comes from user-provided agent/soul/claude
	// examples and is intended to grow independently of the hand-curated
	// seeded corpus. Because it is new and broader, we measure it with corpus
	// guardrails instead of requiring every row to already be perfectly
	// classified.
	runMeasuredDeonticCorpus(
		t,
		"user-agent-soul-file",
		loadLabeledDeonticCorpus(t, "deontic_user_agent_soul_corpus.json"),
		0.10,
		0.90,
	)
}

func TestDeonticRealWorldSoulCorpusHarness(t *testing.T) {
	t.Parallel()

	// This corpus is built from real-world structured soul files. It is closer
	// to the likely authored target than the synthetic/user stress corpus, so
	// we track it separately.
	runMeasuredDeonticCorpus(
		t,
		"real-world-souls-file",
		loadLabeledDeonticCorpus(t, "deontic_real_world_souls_corpus.json"),
		0.15,
		0.60,
	)
}

func runDeonticCorpus(t *testing.T, name string, cases []deonticEvalCase, fpMax, fnMax float64) {
	t.Helper()

	frame := NewDeonticFrame()
	metrics := deonticEvalMetrics{}

	for _, tc := range cases {
		got := frame.EvaluateText([]byte(tc.Text))
		if tc.BehavioralRule {
			metrics.BehavioralTotal++
			if got.Promoted {
				metrics.TruePositive++
			} else {
				metrics.FalseNegative++
			}
		} else {
			metrics.LoreTotal++
			if got.Promoted {
				metrics.FalsePositive++
			} else {
				metrics.TrueNegative++
			}
		}

		if got.Promoted != tc.ExpectPromoted {
			t.Fatalf("%s/%s (%s): promoted=%v, want %v (%s)\ntext=%q", name, tc.Name, tc.Source, got.Promoted, tc.ExpectPromoted, tc.Reason, tc.Text)
		}
	}

	fp := metrics.FalsePositiveRate()
	fn := metrics.FalseNegativeRate()
	t.Logf("%s sigma corpus: behavioral=%d lore=%d tp=%d tn=%d fp=%d fn=%d P_fp=%.3f P_fn=%.3f",
		name,
		metrics.BehavioralTotal,
		metrics.LoreTotal,
		metrics.TruePositive,
		metrics.TrueNegative,
		metrics.FalsePositive,
		metrics.FalseNegative,
		fp,
		fn,
	)

	if fp > fpMax {
		t.Fatalf("%s P_fp=%.3f exceeded corpus guardrail %.2f", name, fp, fpMax)
	}
	if fn > fnMax {
		t.Fatalf("%s P_fn=%.3f exceeded corpus guardrail %.2f", name, fn, fnMax)
	}
}

func runMeasuredDeonticCorpus(t *testing.T, name string, cases []deonticLabeledCase, fpMax, fnMax float64) {
	t.Helper()

	frame := NewDeonticFrame()
	metrics := deonticEvalMetrics{}

	for _, tc := range cases {
		got := frame.EvaluateText([]byte(tc.Text))
		if tc.BehavioralRule {
			metrics.BehavioralTotal++
			if got.Promoted {
				metrics.TruePositive++
			} else {
				metrics.FalseNegative++
			}
		} else {
			metrics.LoreTotal++
			if got.Promoted {
				metrics.FalsePositive++
				t.Logf("%s false positive: %s (%s) reason=%s text=%q", name, tc.Name, tc.Source, tc.Reason, tc.Text)
			} else {
				metrics.TrueNegative++
			}
		}
		if tc.BehavioralRule && !got.Promoted {
			t.Logf("%s false negative: %s (%s) reason=%s text=%q", name, tc.Name, tc.Source, tc.Reason, tc.Text)
		}
	}

	fp := metrics.FalsePositiveRate()
	fn := metrics.FalseNegativeRate()
	t.Logf("%s sigma corpus: behavioral=%d lore=%d tp=%d tn=%d fp=%d fn=%d P_fp=%.3f P_fn=%.3f",
		name,
		metrics.BehavioralTotal,
		metrics.LoreTotal,
		metrics.TruePositive,
		metrics.TrueNegative,
		metrics.FalsePositive,
		metrics.FalseNegative,
		fp,
		fn,
	)

	if fp > fpMax {
		t.Fatalf("%s P_fp=%.3f exceeded corpus guardrail %.2f", name, fp, fpMax)
	}
	if fn > fnMax {
		t.Fatalf("%s P_fn=%.3f exceeded corpus guardrail %.2f", name, fn, fnMax)
	}
}

func loadLabeledDeonticCorpus(t *testing.T, filename string) []deonticLabeledCase {
	t.Helper()

	path := filepath.Join("testdata", filename)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read corpus %s: %v", path, err)
	}

	var cases []deonticLabeledCase
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatalf("parse corpus %s: %v", path, err)
	}
	if len(cases) == 0 {
		t.Fatalf("corpus %s was empty", path)
	}
	return cases
}

func deonticEvaluationCorpus() []deonticEvalCase {
	return []deonticEvalCase{
		{
			Name:           "rule_must_json",
			Source:         "seeded",
			Text:           "You must answer in JSON.",
			BehavioralRule: true,
			ExpectPromoted: true,
			Reason:         "Canonical second-person obligation.",
		},
		{
			Name:           "rule_must_not_secret",
			Source:         "seeded",
			Text:           "You must not reveal secrets.",
			BehavioralRule: true,
			ExpectPromoted: true,
			Reason:         "Canonical second-person prohibition.",
		},
		{
			Name:           "rule_should_citations",
			Source:         "seeded",
			Text:           "You should cite the governing spec.",
			BehavioralRule: true,
			ExpectPromoted: true,
			Reason:         "Second-person recommendation is treated as obligation-tier behavior.",
		},
		{
			Name:           "rule_may_question",
			Source:         "seeded",
			Text:           "You may ask one clarifying question.",
			BehavioralRule: true,
			ExpectPromoted: true,
			Reason:         "Second-person permission counts as a behavioral directive.",
		},
		{
			Name:           "rule_cannot_modify",
			Source:         "seeded",
			Text:           "You cannot modify production data.",
			BehavioralRule: true,
			ExpectPromoted: true,
			Reason:         "Second-person cannot prohibition.",
		},
		{
			Name:           "rule_required_sync",
			Source:         "seeded",
			Text:           "You are required to keep tasks and memory in sync.",
			BehavioralRule: true,
			ExpectPromoted: true,
			Reason:         "Required within the second-person window should be promoted.",
		},
		{
			Name:           "rule_should_never_fabricate",
			Source:         "seeded",
			Text:           "You should never fabricate citations.",
			BehavioralRule: true,
			ExpectPromoted: true,
			Reason:         "Mixed obligation plus never prohibition should still promote.",
		},
		{
			Name:           "rule_shall_preserve_order",
			Source:         "seeded",
			Text:           "You shall preserve authored ordering.",
			BehavioralRule: true,
			ExpectPromoted: true,
			Reason:         "Shall is in the supported modal set.",
		},
		{
			Name:           "rule_bare_always",
			Source:         "seeded",
			Text:           "Always answer in JSON.",
			BehavioralRule: true,
			ExpectPromoted: true,
			Reason:         "Bare imperative should now be promoted via the sentence-start heuristic.",
		},
		{
			Name:           "rule_bare_do_not",
			Source:         "seeded",
			Text:           "Do not leak secrets.",
			BehavioralRule: true,
			ExpectPromoted: true,
			Reason:         "Bare do-not prohibition should now be promoted.",
		},
		{
			Name:           "rule_polite_please",
			Source:         "seeded",
			Text:           "Please cite the governing spec.",
			BehavioralRule: true,
			ExpectPromoted: true,
			Reason:         "Please + imperative verb should now be promoted.",
		},
		{
			Name:           "rule_bare_keep_sync",
			Source:         "seeded",
			Text:           "Keep tasks and memory in sync.",
			BehavioralRule: true,
			ExpectPromoted: true,
			Reason:         "Imperative verb at sentence start should now be promoted.",
		},
		{
			Name:           "lore_dragon_must",
			Source:         "seeded",
			Text:           "The dragon must guard the gate.",
			BehavioralRule: false,
			ExpectPromoted: false,
			Reason:         "Modal without second-person target should remain lore.",
		},
		{
			Name:           "lore_cache_may",
			Source:         "seeded",
			Text:           "The system may cache recent queries for speed.",
			BehavioralRule: false,
			ExpectPromoted: false,
			Reason:         "Third-person implementation note should remain lore.",
		},
		{
			Name:           "lore_never_without_you",
			Source:         "seeded",
			Text:           "Never before had the archive looked this quiet.",
			BehavioralRule: false,
			ExpectPromoted: false,
			Reason:         "Never without second-person context should not promote.",
		},
		{
			Name:           "lore_story_should",
			Source:         "seeded",
			Text:           "The story says the guide should arrive tomorrow.",
			BehavioralRule: false,
			ExpectPromoted: false,
			Reason:         "Narrative should without second-person cue should remain lore.",
		},
		{
			Name:           "lore_your_archive",
			Source:         "seeded",
			Text:           "Your archive contains sketches from earlier experiments.",
			BehavioralRule: false,
			ExpectPromoted: false,
			Reason:         "Possessive your is not the second-person trigger token.",
		},
		{
			Name:           "lore_mustard_boundary",
			Source:         "seeded",
			Text:           "Young mustard greens were harvested at dawn.",
			BehavioralRule: false,
			ExpectPromoted: false,
			Reason:         "Substring boundary should not fire on must.",
		},
		{
			Name:           "lore_narrative_you_should",
			Source:         "seeded",
			Text:           "In the old tale, you should picture a harbor at sunrise.",
			BehavioralRule: false,
			ExpectPromoted: false,
			Reason:         "Narrative rhetoric should now be filtered after second-person modal detection.",
		},
		{
			Name:           "lore_narrative_you_must",
			Source:         "seeded",
			Text:           "To understand the scene, you must imagine the tower collapsing.",
			BehavioralRule: false,
			ExpectPromoted: false,
			Reason:         "Narrative rhetoric should now be filtered after second-person modal detection.",
		},
		{
			Name:           "lore_project_history",
			Source:         "seeded",
			Text:           "Project history notes that the migration took three attempts.",
			BehavioralRule: false,
			ExpectPromoted: false,
			Reason:         "Pure factual narrative should remain lore.",
		},
		{
			Name:           "lore_quote_without_you",
			Source:         "seeded",
			Text:           "The inscription read: must endure, may bend, never break.",
			BehavioralRule: false,
			ExpectPromoted: false,
			Reason:         "Modal words alone should not promote without the second-person cue.",
		},
		{
			Name:           "lore_plain_guidance_description",
			Source:         "seeded",
			Text:           "The onboarding guide explains when a reviewer may request more detail.",
			BehavioralRule: false,
			ExpectPromoted: false,
			Reason:         "Descriptive prose about others remains lore.",
		},
		{
			Name:           "lore_retrospective",
			Source:         "seeded",
			Text:           "Yesterday you reviewed the parser and then wrote the notes down.",
			BehavioralRule: false,
			ExpectPromoted: false,
			Reason:         "Second-person narrative without modal language should remain lore.",
		},
	}
}

func deonticRealAuthoredCorpus() []deonticEvalCase {
	return []deonticEvalCase{
		{
			Name:           "agents_follow_contracts",
			Source:         "AGENTS.md",
			Text:           "Agents working in this repository must follow the architecture and engineering contracts in the project documents, not infer behavior from partial implementation, convenience, or generic software habits.",
			BehavioralRule: true,
			ExpectPromoted: false,
			Reason:         "Real repo rule in third-person agent phrasing; current sigma still misses this form.",
		},
		{
			Name:           "agents_do_not_create_rebuild",
			Source:         "AGENTS.md",
			Text:           "Do not create or rebuild them unless the user issues the direct XML-wrapped command.",
			BehavioralRule: true,
			ExpectPromoted: true,
			Reason:         "Repository command prohibition should promote via bare do-not detection.",
		},
		{
			Name:           "agents_do_not_inspect_specdb",
			Source:         "AGENTS.md",
			Text:           "Do not inspect spec.db directly.",
			BehavioralRule: true,
			ExpectPromoted: true,
			Reason:         "Repository prohibition should promote.",
		},
		{
			Name:           "agents_never_read_specdb",
			Source:         "AGENTS.md",
			Text:           "Never read spec.db directly.",
			BehavioralRule: true,
			ExpectPromoted: true,
			Reason:         "Bare never prohibition should now be promoted.",
		},
		{
			Name:           "agents_use_search_before_map",
			Source:         "AGENTS.md",
			Text:           "Use --search before --map when you do not know the section name.",
			BehavioralRule: true,
			ExpectPromoted: true,
			Reason:         "Repository imperative should promote via sentence-start verb detection.",
		},
		{
			Name:           "agents_do_not_mark_complete",
			Source:         "AGENTS.md",
			Text:           "Do not mark work complete unless the implementation exists, the relevant tests exist when behavior is correctness-sensitive, and the implementation matches the docx-derived contract, not just the current codebase.",
			BehavioralRule: true,
			ExpectPromoted: true,
			Reason:         "Long-form prohibition should still promote.",
		},
		{
			Name:           "contributing_do_not_weaken",
			Source:         "docs/contributing.md",
			Text:           "Do not weaken the gate invariants casually.",
			BehavioralRule: true,
			ExpectPromoted: true,
			Reason:         "Repository prohibition should promote.",
		},
		{
			Name:           "contributing_do_not_rewrite_expectations",
			Source:         "docs/contributing.md",
			Text:           "Do not rewrite expectations just to make regressions disappear.",
			BehavioralRule: true,
			ExpectPromoted: true,
			Reason:         "Repository prohibition should promote.",
		},
		{
			Name:           "contributing_if_you_add_signal",
			Source:         "docs/contributing.md",
			Text:           "If you add a new signal, it must preserve those invariants.",
			BehavioralRule: true,
			ExpectPromoted: false,
			Reason:         "Known remaining miss: conditional second-person clause moves the modal outside the current short window.",
		},
		{
			Name:           "installation_do_not_bypass",
			Source:         "docs/installation.md",
			Text:           "Do not bypass this. Delete the asset and rerun setup, or republish the release with corrected checksums.",
			BehavioralRule: true,
			ExpectPromoted: true,
			Reason:         "Operational prohibition should promote.",
		},
		{
			Name:           "problem_exists_because",
			Source:         "docs/problem.md",
			Text:           "This plugin exists because the stock OpenClaw memory path is optimized for lightweight persistence, not for a full context lifecycle with scope separation, compaction, and bounded retrieval.",
			BehavioralRule: false,
			ExpectPromoted: false,
			Reason:         "Descriptive problem statement is lore.",
		},
		{
			Name:           "problem_short_sessions_right_answer",
			Source:         "docs/problem.md",
			Text:           "For short sessions and light persistent memory, that is often the right answer.",
			BehavioralRule: false,
			ExpectPromoted: false,
			Reason:         "Descriptive recommendation, not an authored command.",
		},
		{
			Name:           "problem_failure_modes_structural",
			Source:         "docs/problem.md",
			Text:           "The failure modes are structural, not cosmetic.",
			BehavioralRule: false,
			ExpectPromoted: false,
			Reason:         "Descriptive explanation is lore.",
		},
		{
			Name:           "problem_single_table_no_notion",
			Source:         "docs/problem.md",
			Text:           "A single-table top-k memory system has no first-class notion of ephemeral session state versus durable user memory.",
			BehavioralRule: false,
			ExpectPromoted: false,
			Reason:         "Architectural description is lore.",
		},
		{
			Name:           "security_untrusted_historical_context",
			Source:         "docs/security.md",
			Text:           "This plugin treats recalled memory as untrusted historical context. That is a structural design rule, not a prompt-style suggestion.",
			BehavioralRule: false,
			ExpectPromoted: false,
			Reason:         "Design explanation is not a direct parser-targeted command.",
		},
		{
			Name:           "security_published_package_avoids_install_exec",
			Source:         "docs/security.md",
			Text:           "The published plugin package intentionally avoids install-time process execution.",
			BehavioralRule: false,
			ExpectPromoted: false,
			Reason:         "Descriptive implementation fact is lore.",
		},
		{
			Name:           "security_daemon_surface_evaluated",
			Source:         "docs/security.md",
			Text:           "The daemon distribution surface should be evaluated separately from the plugin package.",
			BehavioralRule: false,
			ExpectPromoted: false,
			Reason:         "Advisory design prose should remain lore under current sigma.",
		},
		{
			Name:           "architecture_current_implemented",
			Source:         "docs/architecture.md",
			Text:           "This document describes the current implemented architecture, not just the design intent.",
			BehavioralRule: false,
			ExpectPromoted: false,
			Reason:         "Descriptive introduction is lore.",
		},
		{
			Name:           "models_optional_path_cpu_feasible",
			Source:         "docs/models.md",
			Text:           "The abstractive summarization path is optional and must remain CPU-feasible on local machines.",
			BehavioralRule: false,
			ExpectPromoted: false,
			Reason:         "Third-person product constraint should remain lore for the current paragraph classifier.",
		},
	}
}

func deonticExternalAgentSoulStyleCorpus() []deonticEvalCase {
	return []deonticEvalCase{
		{
			Name:           "socialify_before_changes_you_must_read",
			Source:         "external:Socialify AGENTS.md",
			Text:           "BEFORE making ANY code changes, you MUST read CONTRIBUTING.md.",
			BehavioralRule: true,
			ExpectPromoted: true,
			Reason:         "Canonical second-person agent directive from a real AGENTS file.",
		},
		{
			Name:           "socialify_failure_to_follow",
			Source:         "external:Socialify AGENTS.md",
			Text:           "Failure to follow CONTRIBUTING.md will result in rejected PRs.",
			BehavioralRule: false,
			ExpectPromoted: false,
			Reason:         "Consequence statement is explanatory context, not a direct rule sentence.",
		},
		{
			Name:           "socialify_documentation_important",
			Source:         "external:Socialify AGENTS.md",
			Text:           "All work must include updates to relevant documentation.",
			BehavioralRule: true,
			ExpectPromoted: true,
			Reason:         "Scoped repo-wide rule with must should now be promoted.",
		},
		{
			Name:           "platform_result_type_must",
			Source:         "external:Platform Applications Registry AGENT.md",
			Text:           "Functions must return Result<T> type, check with if (result.success).",
			BehavioralRule: true,
			ExpectPromoted: true,
			Reason:         "Scoped technical rule with must should now be promoted.",
		},
		{
			Name:           "dusk_read_claude_first",
			Source:         "external:agents.md",
			Text:           "Read CLAUDE.md first for repo map and commands.",
			BehavioralRule: true,
			ExpectPromoted: true,
			Reason:         "Sentence-start imperative should promote.",
		},
		{
			Name:           "dusk_ask_when_uncertain",
			Source:         "external:agents.md",
			Text:           "Ask when uncertain.",
			BehavioralRule: true,
			ExpectPromoted: true,
			Reason:         "Sentence-start imperative is already covered by the current verb set.",
		},
		{
			Name:           "dusk_never_leak_secrets",
			Source:         "external:agents.md",
			Text:           "Never leak secrets.",
			BehavioralRule: true,
			ExpectPromoted: true,
			Reason:         "Bare never prohibition should now be promoted.",
		},
		{
			Name:           "grid_make_sure_update_readme",
			Source:         "external:Code Modification Guidelines",
			Text:           "If you modify the cli, make sure to update README.md.",
			BehavioralRule: true,
			ExpectPromoted: true,
			Reason:         "Conditional make-sure-to guidance should now be promoted.",
		},
		{
			Name:           "grid_tests_should_run_pytest",
			Source:         "external:Code Modification Guidelines",
			Text:           "Tests should be run with pytest.",
			BehavioralRule: true,
			ExpectPromoted: true,
			Reason:         "Passive should-be directive should now be promoted.",
		},
		{
			Name:           "econ_please_consult_resources",
			Source:         "external:HARK autogenerated file",
			Text:           "Please consult these resources to understand the relationships between the different parts of the project.",
			BehavioralRule: true,
			ExpectPromoted: true,
			Reason:         "Polite consult imperative should now be promoted.",
		},
		{
			Name:           "econ_understanding_role_crucial",
			Source:         "external:HARK autogenerated file",
			Text:           "Understanding its role within the broader ecosystem is crucial for effective analysis.",
			BehavioralRule: false,
			ExpectPromoted: false,
			Reason:         "Descriptive context about the project should remain lore.",
		},
		{
			Name:           "kiwi_supports_dynamic_personality_switching",
			Source:         "external:Souls doc",
			Text:           "Kiwi supports dynamic personality switching through markdown-based souls.",
			BehavioralRule: false,
			ExpectPromoted: false,
			Reason:         "System description is lore, not an instruction to the agent.",
		},
		{
			Name:           "kiwi_you_are_contemplative_philosopher",
			Source:         "external:Souls doc embedded custom soul",
			Text:           "You are a contemplative philosopher. You speak in measured, thoughtful sentences.",
			BehavioralRule: true,
			ExpectPromoted: true,
			Reason:         "Identity and style guidance should now be promoted.",
		},
		{
			Name:           "kiwi_reference_philosophy_literature",
			Source:         "external:Souls doc embedded custom soul",
			Text:           "Reference philosophy and literature.",
			BehavioralRule: true,
			ExpectPromoted: true,
			Reason:         "Sentence-start imperative is now covered after adding reference to the verb set.",
		},
		{
			Name:           "ghostpaw_personality_evolves",
			Source:         "external:Ghostpaw Souls",
			Text:           "Its personality — its soul — evolves from real experience.",
			BehavioralRule: false,
			ExpectPromoted: false,
			Reason:         "Conceptual explanation is lore.",
		},
		{
			Name:           "ghostpaw_you_dont_manage_this",
			Source:         "external:Ghostpaw Souls",
			Text:           "You don't manage this.",
			BehavioralRule: false,
			ExpectPromoted: false,
			Reason:         "Descriptive reassurance about the system is not a behavioral directive.",
		},
	}
}
