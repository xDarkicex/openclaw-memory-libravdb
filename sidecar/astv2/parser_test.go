package astv2

import "testing"

func TestExtractDocumentPartitionsMarkdownIntoOrderedTiers(t *testing.T) {
	t.Parallel()

	raw := []byte(`---
name: Codex
style: rigorous
hop_targets: [souls.md#000007, souls.md#000008]
---

# Identity

You must be a careful agent.

> Prefer explicit formulas.

- Always cite the governing math.
- Keep tasks and memory in sync.

Regular narrative lore goes here.

` + "```go\nfmt.Println(\"hello\")\n```\n")

	doc, err := ExtractDocument("AGENTS.md", raw, "tok-v1")
	if err != nil {
		t.Fatalf("ExtractDocument error = %v", err)
	}

	if doc.SourceDoc != "AGENTS.md" {
		t.Fatalf("SourceDoc = %q", doc.SourceDoc)
	}
	if doc.CacheKey == "" {
		t.Fatalf("expected cache key")
	}
	if len(doc.HopTargets) != 2 || doc.HopTargets[0] != "souls.md#000007" || doc.HopTargets[1] != "souls.md#000008" {
		t.Fatalf("HopTargets = %+v, want frontmatter hop targets", doc.HopTargets)
	}
	if len(doc.Nodes) != 8 {
		t.Fatalf("len(Nodes) = %d, want 8", len(doc.Nodes))
	}

	kinds := []NodeKind{
		NodeYAMLFrontmatter,
		NodeHeading,
		NodeParagraph,
		NodeBlockquote,
		NodeList,
		NodeList,
		NodeParagraph,
		NodeCodeBlock,
	}
	for i, want := range kinds {
		if doc.Nodes[i].Kind != want {
			t.Fatalf("node[%d].Kind = %s, want %s", i, doc.Nodes[i].Kind, want)
		}
		if doc.Nodes[i].Ordinal != i {
			t.Fatalf("node[%d].Ordinal = %d, want %d", i, doc.Nodes[i].Ordinal, i)
		}
		if i > 0 && doc.Nodes[i].Position < doc.Nodes[i-1].Position {
			t.Fatalf("node[%d].Position = %d, previous = %d; want nondecreasing source order", i, doc.Nodes[i].Position, doc.Nodes[i-1].Position)
		}
		if doc.Nodes[i].TokenEstimate < 1 {
			t.Fatalf("node[%d].TokenEstimate = %d, want >= 1", i, doc.Nodes[i].TokenEstimate)
		}
	}

	if doc.Nodes[2].Tier != TierSoft || !doc.Nodes[2].Promoted {
		t.Fatalf("paragraph with imperative should be promoted soft invariant: %+v", doc.Nodes[2])
	}
	if doc.Nodes[3].Tier != TierSoft {
		t.Fatalf("blockquote should be soft invariant: %+v", doc.Nodes[3])
	}
	if doc.Nodes[4].Tier != TierHard || doc.Nodes[5].Tier != TierHard {
		t.Fatalf("list items should be hard invariants: %+v %+v", doc.Nodes[4], doc.Nodes[5])
	}
	if doc.Nodes[6].Tier != TierVariant {
		t.Fatalf("plain paragraph should remain variant: %+v", doc.Nodes[6])
	}
	if len(doc.Nodes[6].HopTargets) != 2 {
		t.Fatalf("variant node should inherit hop targets: %+v", doc.Nodes[6])
	}

	if len(doc.Hard) != 3 {
		t.Fatalf("len(Hard) = %d, want 3", len(doc.Hard))
	}
	if len(doc.Soft) != 2 {
		t.Fatalf("len(Soft) = %d, want 2", len(doc.Soft))
	}
	if len(doc.Variant) != 3 {
		t.Fatalf("len(Variant) = %d, want 3", len(doc.Variant))
	}

	assertPairwiseDisjoint(t, doc)
}

func TestExtractDocumentTreatsPureCodeAsVariant(t *testing.T) {
	t.Parallel()

	raw := []byte("```ts\nexport const answer = 42;\n```\n")
	doc, err := ExtractDocument("souls.md", raw, "tok-v1")
	if err != nil {
		t.Fatalf("ExtractDocument error = %v", err)
	}
	if len(doc.Nodes) != 1 {
		t.Fatalf("len(Nodes) = %d, want 1", len(doc.Nodes))
	}
	if doc.Nodes[0].Kind != NodeCodeBlock {
		t.Fatalf("Kind = %s, want %s", doc.Nodes[0].Kind, NodeCodeBlock)
	}
	if doc.Nodes[0].Tier != TierVariant {
		t.Fatalf("pure code should remain variant: %+v", doc.Nodes[0])
	}
}

func assertPairwiseDisjoint(t *testing.T, doc Document) {
	t.Helper()

	seen := make(map[int]Tier, len(doc.Nodes))
	for _, node := range doc.Hard {
		seen[node.Ordinal] = TierHard
	}
	for _, node := range doc.Soft {
		if prior, ok := seen[node.Ordinal]; ok {
			t.Fatalf("node ordinal %d appears in both %v and %v", node.Ordinal, prior, TierSoft)
		}
		seen[node.Ordinal] = TierSoft
	}
	for _, node := range doc.Variant {
		if prior, ok := seen[node.Ordinal]; ok {
			t.Fatalf("node ordinal %d appears in both %v and %v", node.Ordinal, prior, TierVariant)
		}
		seen[node.Ordinal] = TierVariant
	}
	if len(seen) != len(doc.Nodes) {
		t.Fatalf("pairwise partition coverage = %d, want %d", len(seen), len(doc.Nodes))
	}
}
