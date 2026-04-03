package astv2

type ModalityMask uint8

const (
	ModalityNone       ModalityMask = 0
	ModalityObligation ModalityMask = 1 << iota
	ModalityForbidden
	ModalityPermitted
)

type ModalityToken struct {
	Start int
	End   int
	Mask  ModalityMask
}

type wordToken struct {
	Start int
	End   int
}

type DeonticFrame struct{}

type Evaluation struct {
	Promoted bool
	Mask     ModalityMask
	Tokens   []ModalityToken
}

func NewDeonticFrame() *DeonticFrame {
	return &DeonticFrame{}
}

func (f *DeonticFrame) EvaluateText(raw []byte) Evaluation {
	tokens := ScanAll(raw)
	mask := ExtractModalityMask(tokens)
	return Evaluation{
		Promoted: mask != ModalityNone,
		Mask:     mask,
		Tokens:   tokens,
	}
}

func ScanModalitySet(raw []byte) []ModalityToken {
	return ScanAll(raw)
}

func HasObligation(raw []byte) bool {
	return ExtractModalityMask(ScanAll(raw))&ModalityObligation != 0
}

func ExtractModalityMask(tokens []ModalityToken) ModalityMask {
	var mask ModalityMask
	for _, token := range tokens {
		mask |= token.Mask
	}
	return mask
}

func ScanAll(raw []byte) []ModalityToken {
	tokens := make([]ModalityToken, 0, 4)
	words := scanWords(raw)
	lastYouWord := -1000

	for wordIndex, word := range words {
		switch {
		case equalWord(raw, word.Start, word.End, "you"):
			lastYouWord = wordIndex
			if isSentenceStart(raw, word.Start) {
				if token, ok := detectIdentityStyle(raw, words, wordIndex); ok {
					tokens = append(tokens, token)
				}
			}
		case wordIndex-lastYouWord <= 3:
			if mask, ok := detectModal(raw, word.Start, word.End); ok && !isNarrativeRhetoric(raw, words, wordIndex) {
				tokens = append(tokens, ModalityToken{Start: word.Start, End: word.End, Mask: mask})
			}
		}
		if isSentenceStart(raw, word.Start) {
			if token, ok := detectStructuralRule(raw, words, wordIndex); ok {
				tokens = append(tokens, token)
			}
			if token, ok := detectBareImperative(raw, words, wordIndex); ok {
				tokens = append(tokens, token)
			}
			if token, ok := detectScopedThirdPersonRule(raw, words, wordIndex); ok {
				tokens = append(tokens, token)
			}
		}
	}

	return tokens
}

func detectModal(raw []byte, start, end int) (ModalityMask, bool) {
	switch {
	case equalWord(raw, start, end, "must"), equalWord(raw, start, end, "shall"), equalWord(raw, start, end, "required"):
		if nextWordEquals(raw, end, "not") {
			return ModalityForbidden, true
		}
		return ModalityObligation, true
	case equalWord(raw, start, end, "should"):
		return ModalityObligation, true
	case equalWord(raw, start, end, "may"):
		if nextWordEquals(raw, end, "not") {
			return ModalityForbidden, true
		}
		return ModalityPermitted, true
	case equalWord(raw, start, end, "never"), equalWord(raw, start, end, "cannot"):
		return ModalityForbidden, true
	case equalWord(raw, start, end, "can"):
		if nextWordEquals(raw, end, "not") {
			return ModalityForbidden, true
		}
	}
	return ModalityNone, false
}

func nextWordEquals(raw []byte, pos int, want string) bool {
	found := false
	forEachWordFrom(raw, pos, func(start, end int) bool {
		found = equalWord(raw, start, end, want)
		return false
	})
	return found
}

func scanWords(raw []byte) []wordToken {
	words := make([]wordToken, 0, 16)
	forEachWord(raw, func(start, end int) bool {
		words = append(words, wordToken{Start: start, End: end})
		return true
	})
	return words
}

func forEachWord(raw []byte, fn func(start, end int) bool) {
	forEachWordFrom(raw, 0, fn)
}

func forEachWordFrom(raw []byte, offset int, fn func(start, end int) bool) {
	inWord := false
	start := 0
	for i := offset; i < len(raw); i++ {
		if isWordByte(raw[i]) {
			if !inWord {
				start = i
				inWord = true
			}
			continue
		}
		if inWord {
			if !fn(start, i) {
				return
			}
			inWord = false
		}
	}
	if inWord {
		_ = fn(start, len(raw))
	}
}

func isWordByte(b byte) bool {
	return (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z')
}

func equalWord(raw []byte, start, end int, want string) bool {
	if end-start != len(want) {
		return false
	}
	for i := 0; i < len(want); i++ {
		if toLowerASCII(raw[start+i]) != want[i] {
			return false
		}
	}
	return true
}

func isAllCapsWord(raw []byte, start, end int) bool {
	if end <= start {
		return false
	}
	for i := start; i < end; i++ {
		if raw[i] < 'A' || raw[i] > 'Z' {
			return false
		}
	}
	return true
}

func hasColonBetween(raw []byte, left, right wordToken) bool {
	for i := left.End; i < right.Start; i++ {
		if raw[i] == ':' {
			return true
		}
	}
	return false
}

func hasArrowBetween(raw []byte, left, right wordToken) bool {
	for i := left.End; i+1 < right.Start; i++ {
		if raw[i] == '-' && raw[i+1] == '>' {
			return true
		}
	}
	return false
}

func isSentenceStart(raw []byte, start int) bool {
	for i := start - 1; i >= 0; i-- {
		switch raw[i] {
		case ' ', '\t', '\r':
			continue
		case '\n', '.', '!', '?', ':', ';':
			return true
		default:
			return false
		}
	}
	return true
}

func detectBareImperative(raw []byte, words []wordToken, idx int) (ModalityToken, bool) {
	word := words[idx]
	switch {
	case equalWord(raw, word.Start, word.End, "always"):
		if next := idx + 1; next < len(words) && isImperativeVerb(raw, words[next].Start, words[next].End) {
			return ModalityToken{Start: word.Start, End: word.End, Mask: ModalityObligation}, true
		}
	case equalWord(raw, word.Start, word.End, "default"):
		if token, ok := detectDefaultRequirement(raw, words, idx); ok {
			return token, true
		}
	case equalWord(raw, word.Start, word.End, "bid"):
		if token, ok := detectSentenceStartProhibitionPredicate(raw, words, idx); ok {
			return token, true
		}
	case equalWord(raw, word.Start, word.End, "please"):
		if next := idx + 1; next < len(words) && isImperativeVerb(raw, words[next].Start, words[next].End) {
			return ModalityToken{Start: word.Start, End: word.End, Mask: ModalityObligation}, true
		}
	case equalWord(raw, word.Start, word.End, "strictly"):
		if next := idx + 1; next < len(words) && isImperativeVerb(raw, words[next].Start, words[next].End) {
			return ModalityToken{Start: word.Start, End: word.End, Mask: ModalityObligation}, true
		}
	case equalWord(raw, word.Start, word.End, "do"):
		if idx+2 < len(words) && equalWord(raw, words[idx+1].Start, words[idx+1].End, "not") && isImperativeVerb(raw, words[idx+2].Start, words[idx+2].End) {
			return ModalityToken{Start: word.Start, End: words[idx+1].End, Mask: ModalityForbidden}, true
		}
	case equalWord(raw, word.Start, word.End, "never"):
		if next := idx + 1; next < len(words) && isImperativeVerb(raw, words[next].Start, words[next].End) {
			return ModalityToken{Start: word.Start, End: word.End, Mask: ModalityForbidden}, true
		}
	case equalWord(raw, word.Start, word.End, "no"):
		if idx+1 < len(words) {
			return ModalityToken{Start: word.Start, End: word.End, Mask: ModalityForbidden}, true
		}
	case equalWord(raw, word.Start, word.End, "don"):
		if idx+2 < len(words) &&
			equalWord(raw, words[idx+1].Start, words[idx+1].End, "t") &&
			equalWord(raw, words[idx+2].Start, words[idx+2].End, "forget") {
			return ModalityToken{Start: word.Start, End: words[idx+2].End, Mask: ModalityObligation}, true
		}
	case equalWord(raw, word.Start, word.End, "if"):
		if token, ok := detectConditionalGuidance(raw, words, idx); ok {
			return token, true
		}
	case isImperativeVerb(raw, word.Start, word.End):
		return ModalityToken{Start: word.Start, End: word.End, Mask: ModalityObligation}, true
	}
	return ModalityToken{}, false
}

func detectSentenceStartProhibitionPredicate(raw []byte, words []wordToken, idx int) (ModalityToken, bool) {
	for lookahead := idx + 1; lookahead < len(words) && lookahead <= idx+6; lookahead++ {
		if equalWord(raw, words[lookahead].Start, words[lookahead].End, "prohibited") ||
			equalWord(raw, words[lookahead].Start, words[lookahead].End, "forbidden") {
			return ModalityToken{Start: words[lookahead].Start, End: words[lookahead].End, Mask: ModalityForbidden}, true
		}
	}
	return ModalityToken{}, false
}

func detectDefaultRequirement(raw []byte, words []wordToken, idx int) (ModalityToken, bool) {
	if idx+2 >= len(words) {
		return ModalityToken{}, false
	}
	if !equalWord(raw, words[idx].Start, words[idx].End, "default") ||
		!equalWord(raw, words[idx+1].Start, words[idx+1].End, "requirement") ||
		!hasColonBetween(raw, words[idx+1], words[idx+2]) {
		return ModalityToken{}, false
	}
	switch {
	case isImperativeVerb(raw, words[idx+2].Start, words[idx+2].End),
		equalWord(raw, words[idx+2].Start, words[idx+2].End, "ensure"),
		equalWord(raw, words[idx+2].Start, words[idx+2].End, "every"):
		return ModalityToken{Start: words[idx].Start, End: words[idx+1].End, Mask: ModalityObligation}, true
	default:
		return ModalityToken{}, false
	}
}

func detectStructuralRule(raw []byte, words []wordToken, idx int) (ModalityToken, bool) {
	if token, ok := detectCommandLabelRule(raw, words, idx); ok {
		return token, true
	}
	if token, ok := detectManifestFieldRule(raw, words, idx); ok {
		return token, true
	}
	if token, ok := detectManifestArrowRule(raw, words, idx); ok {
		return token, true
	}
	if token, ok := detectQuantifiedRequirement(raw, words, idx); ok {
		return token, true
	}
	return ModalityToken{}, false
}

func detectCommandLabelRule(raw []byte, words []wordToken, idx int) (ModalityToken, bool) {
	switch {
	case equalWord(raw, words[idx].Start, words[idx].End, "build"),
		equalWord(raw, words[idx].Start, words[idx].End, "test"),
		equalWord(raw, words[idx].Start, words[idx].End, "lint"),
		equalWord(raw, words[idx].Start, words[idx].End, "benchmarks"),
		equalWord(raw, words[idx].Start, words[idx].End, "production"),
		equalWord(raw, words[idx].Start, words[idx].End, "development"):
		if idx+1 < len(words) && hasColonBetween(raw, words[idx], words[idx+1]) {
			return ModalityToken{Start: words[idx].Start, End: words[idx].End, Mask: ModalityObligation}, true
		}
		if idx+2 < len(words) && hasColonBetween(raw, words[idx+1], words[idx+2]) {
			return ModalityToken{Start: words[idx].Start, End: words[idx+1].End, Mask: ModalityObligation}, true
		}
		return ModalityToken{}, false
	default:
		return ModalityToken{}, false
	}
}

func detectManifestFieldRule(raw []byte, words []wordToken, idx int) (ModalityToken, bool) {
	if idx+2 >= len(words) || !hasColonBetween(raw, words[idx+1], words[idx+2]) {
		return ModalityToken{}, false
	}
	if !isAllCapsWord(raw, words[idx].Start, words[idx].End) || !isAllCapsWord(raw, words[idx+1].Start, words[idx+1].End) {
		return ModalityToken{}, false
	}
	if !isOperationalManifestField(raw, words[idx], words[idx+1]) {
		return ModalityToken{}, false
	}
	return ModalityToken{Start: words[idx].Start, End: words[idx+1].End, Mask: ModalityObligation}, true
}

func detectManifestArrowRule(raw []byte, words []wordToken, idx int) (ModalityToken, bool) {
	for arrowLeft := idx + 1; arrowLeft < len(words) && arrowLeft <= idx+3; arrowLeft++ {
		arrowRight := arrowLeft + 1
		if arrowRight >= len(words) || !hasArrowBetween(raw, words[arrowLeft], words[arrowRight]) {
			continue
		}
		allCaps := true
		for i := idx; i <= arrowLeft; i++ {
			if !isAllCapsWord(raw, words[i].Start, words[i].End) {
				allCaps = false
				break
			}
		}
		if !allCaps || !equalWord(raw, words[idx].Start, words[idx].End, "on") {
			continue
		}
		return ModalityToken{Start: words[idx].Start, End: words[arrowLeft].End, Mask: ModalityObligation}, true
	}
	return ModalityToken{}, false
}

func detectQuantifiedRequirement(raw []byte, words []wordToken, idx int) (ModalityToken, bool) {
	if !equalWord(raw, words[idx].Start, words[idx].End, "every") {
		return ModalityToken{}, false
	}
	for lookahead := idx + 1; lookahead < len(words) && lookahead <= idx+5; lookahead++ {
		switch {
		case equalWord(raw, words[lookahead].Start, words[lookahead].End, "must"),
			equalWord(raw, words[lookahead].Start, words[lookahead].End, "shall"),
			equalWord(raw, words[lookahead].Start, words[lookahead].End, "required"):
			return ModalityToken{Start: words[lookahead].Start, End: words[lookahead].End, Mask: ModalityObligation}, true
		case equalWord(raw, words[lookahead].Start, words[lookahead].End, "should"):
			return ModalityToken{Start: words[lookahead].Start, End: words[lookahead].End, Mask: ModalityObligation}, true
		}
	}
	return ModalityToken{}, false
}

func isOperationalManifestField(raw []byte, first, second wordToken) bool {
	switch {
	case equalWord(raw, first.Start, first.End, "alloc") && equalWord(raw, second.Start, second.End, "strategy"):
		return true
	case equalWord(raw, first.Start, first.End, "concurrency") && equalWord(raw, second.Start, second.End, "model"):
		return true
	case equalWord(raw, first.Start, first.End, "performance") && equalWord(raw, second.Start, second.End, "target"):
		return true
	case equalWord(raw, first.Start, first.End, "anti") && equalWord(raw, second.Start, second.End, "vm"):
		return true
	case equalWord(raw, first.Start, first.End, "sandbox") && equalWord(raw, second.Start, second.End, "aware"):
		return true
	case equalWord(raw, first.Start, first.End, "ebpf") && equalWord(raw, second.Start, second.End, "monitoring"):
		return true
	default:
		return false
	}
}

func detectConditionalGuidance(raw []byte, words []wordToken, idx int) (ModalityToken, bool) {
	// Match patterns like:
	// "If you modify ..., make sure to update README.md."
	// "If a task requires ..., escalate to ROOT_AGENT."
	// "If you encounter ..., bypass it for local testing but log it."
	for lookahead := idx + 1; lookahead < len(words) && lookahead <= idx+14; lookahead++ {
		if !startsConditionalConsequent(raw, words, lookahead) {
			continue
		}
		if equalWord(raw, words[lookahead].Start, words[lookahead].End, "make") {
			if lookahead+2 >= len(words) {
				return ModalityToken{}, false
			}
			if !equalWord(raw, words[lookahead+1].Start, words[lookahead+1].End, "sure") {
				continue
			}
			if !equalWord(raw, words[lookahead+2].Start, words[lookahead+2].End, "to") {
				continue
			}
			if lookahead+3 >= len(words) {
				return ModalityToken{}, false
			}
			if isImperativeVerb(raw, words[lookahead+3].Start, words[lookahead+3].End) {
				return ModalityToken{Start: words[lookahead].Start, End: words[lookahead+2].End, Mask: ModalityObligation}, true
			}
			continue
		}
		if equalWord(raw, words[lookahead].Start, words[lookahead].End, "do") {
			if lookahead+2 < len(words) &&
				equalWord(raw, words[lookahead+1].Start, words[lookahead+1].End, "not") &&
				isImperativeVerb(raw, words[lookahead+2].Start, words[lookahead+2].End) {
				return ModalityToken{Start: words[lookahead].Start, End: words[lookahead+1].End, Mask: ModalityForbidden}, true
			}
			continue
		}
		if isImperativeVerb(raw, words[lookahead].Start, words[lookahead].End) {
			return ModalityToken{Start: words[lookahead].Start, End: words[lookahead].End, Mask: ModalityObligation}, true
		}
	}
	return ModalityToken{}, false
}

func startsConditionalConsequent(raw []byte, words []wordToken, idx int) bool {
	if idx <= 0 || idx >= len(words) {
		return false
	}
	for i := words[idx].Start - 1; i >= words[idx-1].End; i-- {
		switch raw[i] {
		case ' ', '\t', '\r', '\n':
			continue
		case ',', ';', ':':
			return true
		default:
			return false
		}
	}
	return false
}

func detectIdentityStyle(raw []byte, words []wordToken, idx int) (ModalityToken, bool) {
	if idx+1 >= len(words) || !equalWord(raw, words[idx].Start, words[idx].End, "you") {
		return ModalityToken{}, false
	}
	next := words[idx+1]
	switch {
	case equalWord(raw, next.Start, next.End, "are"):
		return ModalityToken{Start: words[idx].Start, End: next.End, Mask: ModalityObligation}, true
	case isIdentityStyleVerb(raw, next.Start, next.End):
		return ModalityToken{Start: words[idx].Start, End: next.End, Mask: ModalityObligation}, true
	default:
		return ModalityToken{}, false
	}
}

func detectScopedThirdPersonRule(raw []byte, words []wordToken, idx int) (ModalityToken, bool) {
	if !isScopedRuleSubject(raw, words, idx) {
		return ModalityToken{}, false
	}
	for lookahead := idx + 1; lookahead < len(words) && lookahead <= idx+4; lookahead++ {
		word := words[lookahead]
		switch {
		case equalWord(raw, word.Start, word.End, "must"), equalWord(raw, word.Start, word.End, "shall"), equalWord(raw, word.Start, word.End, "required"):
			return ModalityToken{Start: word.Start, End: word.End, Mask: ModalityObligation}, true
		case equalWord(raw, word.Start, word.End, "should"):
			if detectPassiveShouldBe(raw, words, lookahead) {
				return ModalityToken{Start: word.Start, End: words[lookahead+1].End, Mask: ModalityObligation}, true
			}
		}
	}
	return ModalityToken{}, false
}

func detectPassiveShouldBe(raw []byte, words []wordToken, idx int) bool {
	return idx+2 < len(words) &&
		equalWord(raw, words[idx].Start, words[idx].End, "should") &&
		equalWord(raw, words[idx+1].Start, words[idx+1].End, "be") &&
		isImperativeVerb(raw, words[idx+2].Start, words[idx+2].End)
}

func isScopedRuleSubject(raw []byte, words []wordToken, idx int) bool {
	if idx >= len(words) {
		return false
	}
	word := words[idx]
	switch {
	case equalWord(raw, word.Start, word.End, "functions"),
		equalWord(raw, word.Start, word.End, "code"),
		equalWord(raw, word.Start, word.End, "logic"),
		equalWord(raw, word.Start, word.End, "tests"),
		equalWord(raw, word.Start, word.End, "work"):
		return true
	case equalWord(raw, word.Start, word.End, "the"):
		return idx+1 < len(words) && equalWord(raw, words[idx+1].Start, words[idx+1].End, "system")
	case equalWord(raw, word.Start, word.End, "all"):
		return idx+1 < len(words) && equalWord(raw, words[idx+1].Start, words[idx+1].End, "work")
	default:
		return false
	}
}

func isNarrativeRhetoric(raw []byte, words []wordToken, idx int) bool {
	for lookahead := 1; lookahead <= 2 && idx+lookahead < len(words); lookahead++ {
		next := words[idx+lookahead]
		if equalWord(raw, next.Start, next.End, "to") {
			continue
		}
		return isNarrativeRhetoricVerb(raw, next.Start, next.End)
	}
	return false
}

func isNarrativeRhetoricVerb(raw []byte, start, end int) bool {
	switch {
	case equalWord(raw, start, end, "imagine"),
		equalWord(raw, start, end, "picture"),
		equalWord(raw, start, end, "envision"),
		equalWord(raw, start, end, "suppose"):
		return true
	default:
		return false
	}
}

func isIdentityStyleVerb(raw []byte, start, end int) bool {
	switch {
	case equalWord(raw, start, end, "speak"),
		equalWord(raw, start, end, "reference"),
		equalWord(raw, start, end, "ask"):
		return true
	default:
		return false
	}
}

func isImperativeVerb(raw []byte, start, end int) bool {
	switch {
	case equalWord(raw, start, end, "act"),
		equalWord(raw, start, end, "answer"),
		equalWord(raw, start, end, "ask"),
		equalWord(raw, start, end, "avoid"),
		equalWord(raw, start, end, "be"),
		equalWord(raw, start, end, "bypass"),
		equalWord(raw, start, end, "build"),
		equalWord(raw, start, end, "cite"),
		equalWord(raw, start, end, "change"),
		equalWord(raw, start, end, "check"),
		equalWord(raw, start, end, "compromise"),
		equalWord(raw, start, end, "consult"),
		equalWord(raw, start, end, "create"),
		equalWord(raw, start, end, "delete"),
		equalWord(raw, start, end, "deny"),
		equalWord(raw, start, end, "design"),
		equalWord(raw, start, end, "ensure"),
		equalWord(raw, start, end, "eliminate"),
		equalWord(raw, start, end, "escalate"),
		equalWord(raw, start, end, "follow"),
		equalWord(raw, start, end, "format"),
		equalWord(raw, start, end, "ground"),
		equalWord(raw, start, end, "implement"),
		equalWord(raw, start, end, "inspect"),
		equalWord(raw, start, end, "keep"),
		equalWord(raw, start, end, "leak"),
		equalWord(raw, start, end, "maintain"),
		equalWord(raw, start, end, "mark"),
		equalWord(raw, start, end, "modify"),
		equalWord(raw, start, end, "prefer"),
		equalWord(raw, start, end, "preserve"),
		equalWord(raw, start, end, "prioritize"),
		equalWord(raw, start, end, "pitch"),
		equalWord(raw, start, end, "promise"),
		equalWord(raw, start, end, "include"),
		equalWord(raw, start, end, "read"),
		equalWord(raw, start, end, "reference"),
		equalWord(raw, start, end, "refer"),
		equalWord(raw, start, end, "rebuild"),
		equalWord(raw, start, end, "refactor"),
		equalWord(raw, start, end, "reject"),
		equalWord(raw, start, end, "reduce"),
		equalWord(raw, start, end, "republish"),
		equalWord(raw, start, end, "return"),
		equalWord(raw, start, end, "reveal"),
		equalWord(raw, start, end, "retreat"),
		equalWord(raw, start, end, "rerun"),
		equalWord(raw, start, end, "rewrite"),
		equalWord(raw, start, end, "run"),
		equalWord(raw, start, end, "signal"),
		equalWord(raw, start, end, "skip"),
		equalWord(raw, start, end, "suggest"),
		equalWord(raw, start, end, "structure"),
		equalWord(raw, start, end, "trust"),
		equalWord(raw, start, end, "treat"),
		equalWord(raw, start, end, "update"),
		equalWord(raw, start, end, "use"),
		equalWord(raw, start, end, "validate"),
		equalWord(raw, start, end, "verify"),
		equalWord(raw, start, end, "weaken"),
		equalWord(raw, start, end, "wipe"),
		equalWord(raw, start, end, "write"):
		return true
	default:
		return false
	}
}

func toLowerASCII(b byte) byte {
	if b >= 'A' && b <= 'Z' {
		return b + ('a' - 'A')
	}
	return b
}
