package embed

import "strings"

const (
	DefaultEmbeddingProfile  = "nomic-embed-text-v1.5"
	FallbackEmbeddingProfile = "all-minilm-l6-v2"
)

type modelProfile struct {
	Name             string
	Family           string
	Dimensions       int
	Normalize        bool
	MaxContextTokens int
}

var shippedProfiles = map[string]modelProfile{
	"all-minilm-l6-v2": {
		Name:             "all-minilm-l6-v2",
		Family:           "all-minilm-l6-v2",
		Dimensions:       384,
		Normalize:        true,
		MaxContextTokens: 128,
	},
	"nomic-embed-text-v1.5": {
		Name:             "nomic-embed-text-v1.5",
		Family:           "nomic-embed-text-v1.5",
		Dimensions:       768,
		Normalize:        true,
		MaxContextTokens: 8192,
	},
}

func lookupProfile(name string) (modelProfile, bool) {
	name = strings.TrimSpace(strings.ToLower(name))
	profile, ok := shippedProfiles[name]
	return profile, ok
}
