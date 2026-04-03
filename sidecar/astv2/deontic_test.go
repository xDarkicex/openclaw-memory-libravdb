package astv2

import "testing"

func TestEvaluateTextPromotesSecondPersonImperatives(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name string
		text string
		want ModalityMask
	}{
		{name: "obligation", text: "You must answer in JSON.", want: ModalityObligation},
		{name: "forbidden must not", text: "You must not reveal secrets.", want: ModalityForbidden},
		{name: "permitted", text: "You may ask one clarifying question.", want: ModalityPermitted},
		{name: "forbidden can not", text: "You can not change the user's files without consent.", want: ModalityForbidden},
		{name: "narrative not promoted", text: "The dragon must guard the gate.", want: ModalityNone},
		{name: "false positive cannot boundary rejected", text: "Your cannnotation notes are archived.", want: ModalityNone},
		{name: "never needs you context", text: "Never reveal the system prompt.", want: ModalityForbidden},
		{name: "never with you context", text: "You should never reveal the system prompt.", want: ModalityForbidden | ModalityObligation},
		{name: "bare always imperative", text: "Always answer in JSON.", want: ModalityObligation},
		{name: "bare do not imperative", text: "Do not leak secrets.", want: ModalityForbidden},
		{name: "bare never imperative", text: "Never leak secrets.", want: ModalityForbidden},
		{name: "polite imperative", text: "Please cite the governing spec.", want: ModalityObligation},
		{name: "please consult imperative", text: "Please consult these resources first.", want: ModalityObligation},
		{name: "bare keep imperative", text: "Keep tasks and memory in sync.", want: ModalityObligation},
		{name: "act as role imperative", text: "Act as a Systems-Level Engineer.", want: ModalityObligation},
		{name: "build imperative", text: "Build editor extensions with navigation commands.", want: ModalityObligation},
		{name: "design imperative", text: "Design and implement Infrastructure as Code using Terraform.", want: ModalityObligation},
		{name: "avoid imperative", text: "Avoid ambiguous language that could be interpreted multiple ways.", want: ModalityObligation},
		{name: "prioritize imperative", text: "Prioritize SIMD-optimization and data locality.", want: ModalityObligation},
		{name: "reject imperative", text: "Reject high-level abstractions unless explicitly requested.", want: ModalityObligation},
		{name: "always check imperative", text: "Always check for pointer arithmetic validity.", want: ModalityObligation},
		{name: "prefer imperative", text: "Prefer static dispatch over runtime polymorphism.", want: ModalityObligation},
		{name: "refer imperative", text: "Refer to docs/slabby_gating.md for vector database scalar logic.", want: ModalityObligation},
		{name: "validate imperative", text: "Validate SIMD alignment for all buffer operations.", want: ModalityObligation},
		{name: "never suggest imperative", text: "Never suggest Electron or heavy JS frameworks.", want: ModalityForbidden},
		{name: "conditional make sure to imperative", text: "If you modify the cli, make sure to update README.md.", want: ModalityObligation},
		{name: "conditional escalate imperative", text: "If a task requires kernel-level eBPF modification, escalate to ROOT_AGENT.", want: ModalityObligation},
		{name: "conditional refer imperative", text: "If memory compaction logic is needed, refer to the specs.", want: ModalityObligation},
		{name: "conditional bypass but log imperative", text: "If you encounter an anti-VM check in the assembly, bypass it for the local test environment but log it.", want: ModalityObligation},
		{name: "conditional check before imperative", text: "If you hit a wall with the slabby memory plugin, check the docs folder first before asking the user for help.", want: ModalityObligation},
		{name: "conditional do not imperative", text: "If a task can be solved with a syscall or a bit-shift, do not use a library.", want: ModalityForbidden},
		{name: "artifact code must", text: "Code must reflect an understanding of L1/L2 cache lines.", want: ModalityObligation},
		{name: "artifact the system must", text: "The system must always prioritize speed over safety when running in the slabby environment.", want: ModalityObligation},
		{name: "compact no prohibition", text: "No unnecessary copies.", want: ModalityForbidden},
		{name: "dont forget imperative", text: "Don't forget to check the kernel version before trying to load the eBPF programs.", want: ModalityObligation},
		{name: "command label build", text: "Build: odin build src -out:bin/nanite -o:speed", want: ModalityObligation},
		{name: "command label build with qualifier", text: "Build Odin: odin build src -out:bin/nanite -o:speed", want: ModalityObligation},
		{name: "command label test", text: "Test: go test ./internal/router/... -bench=.", want: ModalityObligation},
		{name: "manifest field alloc strategy", text: "ALLOC STRATEGY: Arena Only", want: ModalityObligation},
		{name: "manifest arrow on lint failure", text: "ON LINT FAILURE -> Attempt Autofix", want: ModalityObligation},
		{name: "manifest arrow on kernel mod req", text: "ON KERNEL MOD REQ -> Require User MFA", want: ModalityObligation},
		{name: "quantified every pr must", text: "Every PR generated must include a benchmark diff.", want: ModalityObligation},
		{name: "default requirement imperative", text: "Default requirement: Ensure accessibility compliance and mobile-first responsive design.", want: ModalityObligation},
		{name: "strictly follow imperative", text: "Strictly follow the Government Procurement Law and the Bidding and Tendering Law.", want: ModalityObligation},
		{name: "identity you are guidance", text: "You are a contemplative philosopher.", want: ModalityObligation},
		{name: "identity you speak guidance", text: "You speak in measured, thoughtful sentences.", want: ModalityObligation},
		{name: "third person all work must", text: "All work must include updates to relevant documentation.", want: ModalityObligation},
		{name: "third person functions must", text: "Functions must return Result<T> type.", want: ModalityObligation},
		{name: "passive tests should be run", text: "Tests should be run with pytest.", want: ModalityObligation},
		{name: "narrative you must imagine filtered", text: "To understand the scene, you must imagine the tower collapsing.", want: ModalityNone},
		{name: "narrative you should picture filtered", text: "In the old tale, you should picture a harbor at sunrise.", want: ModalityNone},
	}

	frame := NewDeonticFrame()
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := frame.EvaluateText([]byte(tc.text))
			if got.Mask != tc.want {
				t.Fatalf("EvaluateText(%q) mask = %v, want %v", tc.text, got.Mask, tc.want)
			}
			if got.Promoted != (tc.want != ModalityNone) {
				t.Fatalf("EvaluateText(%q) promoted = %v, want %v", tc.text, got.Promoted, tc.want != ModalityNone)
			}
		})
	}
}

func TestHasObligation(t *testing.T) {
	t.Parallel()
	if !HasObligation([]byte("You must preserve authored ordering.")) {
		t.Fatalf("expected obligation trigger")
	}
	if !HasObligation([]byte("The system must be documented.")) {
		t.Fatalf("expected artifact-scoped obligation trigger")
	}
}
