package summarize

// Tokenizer is the boundary between text and token IDs.
// All summarizer backends must operate through this interface.
// No backend may call a tokenizer implementation directly.
type Tokenizer interface {
	Encode(text string) ([]int64, error)
	Decode(ids []int64) (string, error)
	VocabSize() int
	BOS() int64
	EOS() int64
	PAD() int64
}
