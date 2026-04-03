package astv2

import (
	"crypto/sha256"
	"encoding/hex"
	"math"
	"unicode/utf8"
)

type NodeKind string

const (
	NodeParagraph       NodeKind = "Paragraph"
	NodeList            NodeKind = "List"
	NodeBlockquote      NodeKind = "Blockquote"
	NodeYAMLFrontmatter NodeKind = "YAMLFrontmatter"
	NodeHeading         NodeKind = "Heading"
	NodeCodeBlock       NodeKind = "CodeBlock"
	NodeHTMLBlock       NodeKind = "HTMLBlock"
)

type Tier uint8

const (
	TierVariant Tier = 0
	TierHard    Tier = 1
	TierSoft    Tier = 2
)

type Node struct {
	Ordinal       int
	Position      int
	Kind          NodeKind
	Tier          Tier
	Text          string
	TokenEstimate int
	Promoted      bool
	ModalityMask  ModalityMask
	HopTargets    []string
}

type Document struct {
	SourceDoc   string
	TokenizerID string
	CacheKey    string
	HopTargets  []string
	Nodes       []Node
	Hard        []Node
	Soft        []Node
	Variant     []Node
}

func tierFor(kind NodeKind, promoted bool) Tier {
	switch kind {
	case NodeList, NodeYAMLFrontmatter:
		return TierHard
	case NodeBlockquote:
		return TierSoft
	case NodeParagraph:
		if promoted {
			return TierSoft
		}
	}
	return TierVariant
}

func estimateTokens(text string) int {
	runes := utf8.RuneCountInString(text)
	if runes <= 0 {
		return 1
	}
	return int(math.Ceil(float64(runes) / 4.0))
}

func cacheKey(raw []byte, tokenizerID string) string {
	sum := sha256.New()
	_, _ = sum.Write(raw)
	_, _ = sum.Write([]byte{0})
	_, _ = sum.Write([]byte(tokenizerID))
	return hex.EncodeToString(sum.Sum(nil))
}
