package summarize

import (
	"fmt"

	"github.com/sugarme/tokenizer"
	"github.com/sugarme/tokenizer/pretrained"
)

type hfTokenizer struct {
	tk  tokenizer.Tokenizer
	bos int64
	eos int64
	pad int64
}

func newTokenizer(path string) (Tokenizer, error) {
	tk, err := pretrained.FromFile(path)
	if err != nil {
		return nil, fmt.Errorf("failed to load tokenizer: %w", err)
	}

	pad, ok := firstTokenID(*tk, []string{"<pad>", "[PAD]"})
	if !ok {
		pad = 0
	}
	bos, ok := firstTokenID(*tk, []string{"<s>", "[CLS]"})
	if !ok {
		bos = pad
	}
	eos, ok := firstTokenID(*tk, []string{"</s>", "[SEP]", "<eos>"})
	if !ok {
		eos = 1
	}

	return &hfTokenizer{
		tk:  *tk,
		bos: bos,
		eos: eos,
		pad: pad,
	}, nil
}

func (t *hfTokenizer) Encode(text string) ([]int64, error) {
	encoding, err := t.tk.EncodeSingle(text, true)
	if err != nil {
		return nil, err
	}
	out := make([]int64, len(encoding.Ids))
	for i, id := range encoding.Ids {
		out[i] = int64(id)
	}
	return out, nil
}

func (t *hfTokenizer) Decode(ids []int64) (string, error) {
	raw := make([]int, len(ids))
	for i, id := range ids {
		raw[i] = int(id)
	}
	return t.tk.Decode(raw, true), nil
}

func (t *hfTokenizer) VocabSize() int { return t.tk.GetVocabSize(true) }
func (t *hfTokenizer) BOS() int64     { return t.bos }
func (t *hfTokenizer) EOS() int64     { return t.eos }
func (t *hfTokenizer) PAD() int64     { return t.pad }

func firstTokenID(tk tokenizer.Tokenizer, names []string) (int64, bool) {
	for _, name := range names {
		if id, ok := tk.TokenToId(name); ok {
			return int64(id), true
		}
	}
	return 0, false
}
