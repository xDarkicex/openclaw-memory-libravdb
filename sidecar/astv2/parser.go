package astv2

import (
	"bytes"
	"strings"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/text"
)

func ExtractDocument(sourceDoc string, raw []byte, tokenizerID string) (Document, error) {
	frontmatter, body := splitFrontmatter(raw)
	frame := NewDeonticFrame()
	nodes := make([]Node, 0, 16)
	hopTargets := parseFrontmatterHopTargets(frontmatter)

	if len(frontmatter) > 0 {
		nodes = append(nodes, newNode(len(nodes), NodeYAMLFrontmatter, string(bytes.TrimSpace(frontmatter)), false, ModalityNone, nil))
	}

	md := goldmark.New()
	doc := md.Parser().Parse(text.NewReader(body))
	for child := doc.FirstChild(); child != nil; child = child.NextSibling() {
		collectNodes(body, child, frame, &nodes)
	}
	for i := range nodes {
		if nodes[i].Tier == TierVariant && len(hopTargets) > 0 {
			nodes[i].HopTargets = append([]string(nil), hopTargets...)
		}
	}

	out := Document{
		SourceDoc:   sourceDoc,
		TokenizerID: tokenizerID,
		CacheKey:    cacheKey(raw, tokenizerID),
		HopTargets:  hopTargets,
		Nodes:       nodes,
		Hard:        make([]Node, 0, len(nodes)),
		Soft:        make([]Node, 0, len(nodes)),
		Variant:     make([]Node, 0, len(nodes)),
	}
	for _, node := range nodes {
		switch node.Tier {
		case TierHard:
			out.Hard = append(out.Hard, node)
		case TierSoft:
			out.Soft = append(out.Soft, node)
		default:
			out.Variant = append(out.Variant, node)
		}
	}
	return out, nil
}

func collectNodes(source []byte, node ast.Node, frame *DeonticFrame, out *[]Node) {
	switch n := node.(type) {
	case *ast.List:
		for item := n.FirstChild(); item != nil; item = item.NextSibling() {
			textValue := normalizeInlineText(collectText(source, item))
			if textValue != "" {
				*out = append(*out, newNode(len(*out), NodeList, textValue, false, ModalityNone, nil))
			}
		}
	case *ast.Blockquote:
		textValue := normalizeInlineText(collectText(source, n))
		if textValue != "" {
			*out = append(*out, newNode(len(*out), NodeBlockquote, textValue, false, ModalityNone, nil))
		}
	case *ast.Paragraph:
		textValue := normalizeInlineText(collectText(source, n))
		if textValue != "" {
			eval := frame.EvaluateText([]byte(textValue))
			*out = append(*out, newNode(len(*out), NodeParagraph, textValue, eval.Promoted, eval.Mask, nil))
		}
	case *ast.Heading:
		textValue := normalizeInlineText(collectText(source, n))
		if textValue != "" {
			*out = append(*out, newNode(len(*out), NodeHeading, textValue, false, ModalityNone, nil))
		}
	case *ast.FencedCodeBlock:
		textValue := normalizeBlockText(collectLines(source, n.Lines()))
		if textValue != "" {
			*out = append(*out, newNode(len(*out), NodeCodeBlock, textValue, false, ModalityNone, nil))
		}
	case *ast.CodeBlock:
		textValue := normalizeBlockText(collectLines(source, n.Lines()))
		if textValue != "" {
			*out = append(*out, newNode(len(*out), NodeCodeBlock, textValue, false, ModalityNone, nil))
		}
	case *ast.HTMLBlock:
		textValue := normalizeBlockText(collectLines(source, n.Lines()))
		if textValue != "" {
			*out = append(*out, newNode(len(*out), NodeHTMLBlock, textValue, false, ModalityNone, nil))
		}
	default:
		for child := node.FirstChild(); child != nil; child = child.NextSibling() {
			collectNodes(source, child, frame, out)
		}
	}
}

func newNode(ordinal int, kind NodeKind, textValue string, promoted bool, mask ModalityMask, hopTargets []string) Node {
	return Node{
		Ordinal:       ordinal,
		Kind:          kind,
		Tier:          tierFor(kind, promoted),
		Text:          textValue,
		TokenEstimate: estimateTokens(textValue),
		Promoted:      promoted,
		ModalityMask:  mask,
		HopTargets:    append([]string(nil), hopTargets...),
	}
}

func collectText(source []byte, node ast.Node) string {
	var b strings.Builder
	appendText(&b, source, node)
	return b.String()
}

func appendText(b *strings.Builder, source []byte, node ast.Node) {
	switch n := node.(type) {
	case *ast.Text:
		b.Write(n.Segment.Value(source))
		if n.HardLineBreak() || n.SoftLineBreak() {
			b.WriteByte(' ')
		}
		return
	case *ast.String:
		b.Write(n.Value)
		return
	case *ast.CodeSpan:
		for child := n.FirstChild(); child != nil; child = child.NextSibling() {
			appendText(b, source, child)
		}
		return
	case *ast.FencedCodeBlock:
		b.WriteString(collectLines(source, n.Lines()))
		return
	case *ast.CodeBlock:
		b.WriteString(collectLines(source, n.Lines()))
		return
	}

	for child := node.FirstChild(); child != nil; child = child.NextSibling() {
		appendText(b, source, child)
	}
}

func collectLines(source []byte, lines *text.Segments) string {
	var b strings.Builder
	for i := 0; i < lines.Len(); i++ {
		segment := lines.At(i)
		b.Write(segment.Value(source))
	}
	return b.String()
}

func normalizeInlineText(raw string) string {
	return strings.Join(strings.Fields(strings.TrimSpace(raw)), " ")
}

func normalizeBlockText(raw string) string {
	return strings.TrimSpace(raw)
}

func splitFrontmatter(raw []byte) ([]byte, []byte) {
	if !bytes.HasPrefix(raw, []byte("---\n")) {
		return nil, raw
	}

	rest := raw[len("---\n"):]
	for i := 0; i < len(rest); i++ {
		if i == 0 || rest[i-1] == '\n' {
			if bytes.HasPrefix(rest[i:], []byte("---\n")) {
				return rest[:i], rest[i+len("---\n"):]
			}
			if bytes.HasPrefix(rest[i:], []byte("...\n")) {
				return rest[:i], rest[i+len("...\n"):]
			}
		}
	}
	return nil, raw
}

func parseFrontmatterHopTargets(frontmatter []byte) []string {
	if len(frontmatter) == 0 {
		return nil
	}
	lines := strings.Split(string(frontmatter), "\n")
	targets := make([]string, 0)
	collecting := false
	for _, rawLine := range lines {
		line := strings.TrimSpace(rawLine)
		switch {
		case strings.HasPrefix(line, "hop_targets:"):
			collecting = true
			inline := strings.TrimSpace(strings.TrimPrefix(line, "hop_targets:"))
			targets = append(targets, parseHopTargetLine(inline)...)
		case collecting && strings.HasPrefix(line, "- "):
			targets = append(targets, trimHopTarget(strings.TrimPrefix(line, "- "))...)
		case collecting && line == "":
			continue
		default:
			collecting = false
		}
	}
	return dedupeTargets(targets)
}

func parseHopTargetLine(line string) []string {
	if line == "" {
		return nil
	}
	if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
		parts := strings.Split(strings.TrimSuffix(strings.TrimPrefix(line, "["), "]"), ",")
		out := make([]string, 0, len(parts))
		for _, part := range parts {
			out = append(out, trimHopTarget(part)...)
		}
		return out
	}
	return trimHopTarget(line)
}

func trimHopTarget(raw string) []string {
	value := strings.TrimSpace(strings.Trim(raw, `"'`))
	if value == "" {
		return nil
	}
	return []string{value}
}

func dedupeTargets(targets []string) []string {
	seen := make(map[string]struct{}, len(targets))
	out := make([]string, 0, len(targets))
	for _, target := range targets {
		if _, ok := seen[target]; ok {
			continue
		}
		seen[target] = struct{}{}
		out = append(out, target)
	}
	return out
}
