package compact

// EstimateTokens returns a stable token count approximation.
// Contract: one token is approximated as four bytes of UTF-8 text.
func EstimateTokens(t string) int {
	n := len(t) / 4
	if n < 1 {
		return 1
	}
	return n
}
