package compact

import "unicode/utf8"

// EstimateTokens returns a stable token count approximation.
// Contract: one token is approximated as four Unicode code points.
func EstimateTokens(t string) int {
	n := utf8.RuneCountInString(t) / 4
	if n < 1 {
		return 1
	}
	return n
}
