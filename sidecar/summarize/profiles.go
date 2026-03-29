package summarize

import "strings"

type modelProfile struct {
	Name             string
	Family           string
	MaxContextTokens int
	Source           modelSource
}

type modelSource struct {
	BaseURL string
	Files   []string
	SHA256  map[string]string
}

var shippedProfiles = map[string]modelProfile{
	"t5-small": {
		Name:             "t5-small",
		Family:           "t5-small",
		MaxContextTokens: 512,
		Source: modelSource{
			BaseURL: "https://huggingface.co/optimum/t5-small/resolve/main",
			Files: []string{
				"encoder_model.onnx",
				"decoder_model.onnx",
				"tokenizer.json",
				"tokenizer_config.json",
				"config.json",
			},
			SHA256: map[string]string{
				"encoder_model.onnx":    "41d326633f1b85f526508cc0db78a5d40877c292c1b6dccae2eacd7d2a53480d",
				"decoder_model.onnx":    "0a1451011d61bcc796a87b7306c503562e910f110f884d0cc08532972c2cc584",
				"tokenizer.json":        "5f0ed8ab5b8cfa9812bb73752f1d80c292e52bcf5a87a144dc9ab2d251056cbb",
				"tokenizer_config.json": "4969f8d76ef05a16553bd2b07b3501673ae8d36972aea88a0f78ad31a3ff2de9",
				"config.json":           "d112428e703aa7ea0d6b17a77e9739fcc15b87653779d9b7942d5ecbc61c00ed",
			},
		},
	},
	"distilbart-cnn-12-6": {
		Name:             "distilbart-cnn-12-6",
		Family:           "distilbart-cnn-12-6",
		MaxContextTokens: 1024,
	},
}

func lookupProfile(name string) (modelProfile, bool) {
	name = strings.TrimSpace(strings.ToLower(name))
	profile, ok := shippedProfiles[name]
	return profile, ok
}
