package embed

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

type tokenizerContract struct {
	Truncation *struct {
		MaxLength int `json:"max_length"`
	} `json:"truncation"`
}

func TestProfileMaxCtxMatchesTokenizerContract(t *testing.T) {
	cases := []struct {
		profile         string
		modelDir        string
		expectEnforced  bool
		expectedMax     int
	}{
		{
			profile:        "all-minilm-l6-v2",
			modelDir:       filepath.Clean(filepath.Join("..", "..", ".models", "all-minilm-l6-v2")),
			expectEnforced: true,
			expectedMax:    128,
		},
		{
			profile:        "nomic-embed-text-v1.5",
			modelDir:       filepath.Clean(filepath.Join("..", "..", ".models", "nomic-embed-text-v1.5")),
			expectEnforced: false,
			expectedMax:    8192,
		},
	}

	for _, tc := range cases {
		t.Run(tc.profile, func(t *testing.T) {
			profile, ok := lookupProfile(tc.profile)
			if !ok {
				t.Fatalf("profile %s not found", tc.profile)
			}
			if profile.MaxContextTokens != tc.expectedMax {
				t.Fatalf("profile %s MaxContextTokens=%d want %d", tc.profile, profile.MaxContextTokens, tc.expectedMax)
			}

			data, err := os.ReadFile(filepath.Join(tc.modelDir, "tokenizer.json"))
			if err != nil {
				t.Fatalf("read tokenizer.json: %v", err)
			}
			var contract tokenizerContract
			if err := json.Unmarshal(data, &contract); err != nil {
				t.Fatalf("parse tokenizer.json: %v", err)
			}

			if tc.expectEnforced {
				if contract.Truncation == nil {
					t.Fatalf("expected tokenizer truncation contract for %s", tc.profile)
				}
				if contract.Truncation.MaxLength != tc.expectedMax {
					t.Fatalf("profile %s MaxContextTokens=%d but tokenizer enforces %d", tc.profile, tc.expectedMax, contract.Truncation.MaxLength)
				}
				return
			}

			if contract.Truncation != nil {
				t.Fatalf("expected tokenizer truncation to be disabled for %s, got max_length=%d", tc.profile, contract.Truncation.MaxLength)
			}
		})
	}
}
