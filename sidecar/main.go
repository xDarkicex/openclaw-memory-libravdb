package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/xDarkicex/openclaw-memory-libravdb/sidecar/compact"
	"github.com/xDarkicex/openclaw-memory-libravdb/sidecar/config"
	"github.com/xDarkicex/openclaw-memory-libravdb/sidecar/embed"
	"github.com/xDarkicex/openclaw-memory-libravdb/sidecar/health"
	"github.com/xDarkicex/openclaw-memory-libravdb/sidecar/model"
	"github.com/xDarkicex/openclaw-memory-libravdb/sidecar/server"
	"github.com/xDarkicex/openclaw-memory-libravdb/sidecar/store"
	"github.com/xDarkicex/openclaw-memory-libravdb/sidecar/summarize"
)

var Version = "dev"

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "serve":
			runServe()
			return
		case "version":
			fmt.Printf("libravdbd %s\n", Version)
			return
		default:
			fmt.Fprintf(os.Stderr, "unknown command %q\nusage: libravdbd [serve|version]\n", os.Args[1])
			os.Exit(1)
		}
	}

	runServe()
}

func runServe() {
	cfg := config.FromEnv()
	if err := preflightONNXRuntime(cfg); err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
		os.Exit(1)
	}
	embedder := embed.NewWithConfig(embed.Config{
		Backend:         cfg.EmbeddingBackend,
		Profile:         cfg.EmbeddingProfile,
		FallbackProfile: cfg.FallbackProfile,
		RuntimePath:     cfg.ONNXRuntimePath,
		ModelPath:       cfg.EmbeddingModelPath,
		TokenizerPath:   cfg.EmbeddingTokenizerPath,
		Dimensions:      cfg.EmbeddingDimensions,
		Normalize:       cfg.EmbeddingNormalize,
	})
	summarizerRuntimePath := cfg.SummarizerRuntimePath
	if summarizerRuntimePath == "" {
		summarizerRuntimePath = cfg.ONNXRuntimePath
	}
	extractive := summarize.NewExtractive(embedder, "extractive")
	configuredSummarizer := summarize.NewWithDeps(summarize.Config{
		Backend:       cfg.SummarizerBackend,
		Profile:       cfg.SummarizerProfile,
		RuntimePath:   summarizerRuntimePath,
		ModelPath:     cfg.SummarizerModelPath,
		TokenizerPath: cfg.SummarizerTokenizerPath,
		Model:         cfg.SummarizerModel,
		Endpoint:      cfg.SummarizerEndpoint,
	}, summarize.Dependencies{
		Embedder: embedder,
		Registry: model.DefaultRegistry(),
	})
	var abstractive summarize.Summarizer
	if configuredSummarizer != nil && configuredSummarizer.Ready() && configuredSummarizer.Mode() != "extractive" {
		abstractive = configuredSummarizer
	}
	st, err := store.Open(cfg.DBPath, embedder)
	if err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
		os.Exit(1)
	}
	if err := st.BackfillDirtyTiers(context.Background()); err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
		os.Exit(1)
	}

	status := health.Check(embedder, st)
	if !status.OK {
		fmt.Fprintln(os.Stderr, status.Message)
		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	srv := server.New(embedder, extractive, abstractive, st, compact.GatingConfig{
		W1c: cfg.GatingW1c,
		W2c: cfg.GatingW2c,
		W3c: cfg.GatingW3c,
		W1t: cfg.GatingW1t,
		W2t: cfg.GatingW2t,
		W3t: cfg.GatingW3t,
		TechNorm:  cfg.GatingTechNorm,
		Threshold: cfg.GatingThreshold,
	})
	listener, endpoint, cleanup, err := server.Listen(cfg.RPCEndpoint)
	if err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
		os.Exit(1)
	}
	defer cleanup()

	fmt.Println(endpoint)
	if err := server.Serve(ctx, listener, srv); err != nil && !errors.Is(err, server.ErrServerClosed) {
		fmt.Fprintln(os.Stderr, err.Error())
		os.Exit(1)
	}
}

func preflightONNXRuntime(cfg config.Config) error {
	paths := make([]string, 0, 2)

	embeddingPath, err := resolvedRuntimePath(cfg.EmbeddingBackend, cfg.ONNXRuntimePath)
	if err != nil {
		return err
	}
	if embeddingPath != "" {
		paths = append(paths, embeddingPath)
	}

	summarizerRuntimePath := cfg.SummarizerRuntimePath
	if summarizerRuntimePath == "" {
		summarizerRuntimePath = cfg.ONNXRuntimePath
	}
	summarizerPath, err := resolvedRuntimePath(cfg.SummarizerBackend, summarizerRuntimePath)
	if err != nil {
		return err
	}
	if summarizerPath != "" {
		paths = append(paths, summarizerPath)
	}

	seen := map[string]struct{}{}
	for _, runtimePath := range paths {
		if _, ok := seen[runtimePath]; ok {
			continue
		}
		seen[runtimePath] = struct{}{}
		if _, err := os.Stat(runtimePath); err != nil {
			if os.IsNotExist(err) {
				return fmt.Errorf("ONNX Runtime library not found at %s\nRun scripts/setup.sh to unpack it.", runtimePath)
			}
			return fmt.Errorf("failed to stat ONNX Runtime library %s: %w", runtimePath, err)
		}
	}

	return nil
}

func resolvedRuntimePath(backend, explicit string) (string, error) {
	switch backend {
	case "", "bundled", "onnx-local":
		return embed.ResolveRuntimePath(embed.Config{
			Backend:     backend,
			RuntimePath: explicit,
		})
	default:
		return "", nil
	}
}
