package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	ort "github.com/yalue/onnxruntime_go"
)

func main() {
	var (
		asComment bool
		ortLib    string
	)

	flag.BoolVar(&asComment, "comment", false, "wrap output as a Go comment block")
	flag.StringVar(&ortLib, "ort-lib", strings.TrimSpace(os.Getenv("ORT_LIB_PATH")), "path to libonnxruntime shared library; defaults to ORT_LIB_PATH")
	flag.Parse()

	if flag.NArg() == 0 {
		fmt.Fprintln(os.Stderr, "usage: inspect_onnx [-comment] [-ort-lib /path/to/libonnxruntime] <model.onnx> [more-models.onnx]")
		os.Exit(2)
	}
	if strings.TrimSpace(ortLib) == "" {
		fmt.Fprintln(os.Stderr, "inspect_onnx: ORT library path is required via -ort-lib or ORT_LIB_PATH")
		os.Exit(2)
	}

	ort.SetSharedLibraryPath(ortLib)
	if err := ort.InitializeEnvironment(); err != nil {
		fmt.Fprintf(os.Stderr, "inspect_onnx: ort init: %v\n", err)
		os.Exit(1)
	}
	defer func() {
		if err := ort.DestroyEnvironment(); err != nil {
			fmt.Fprintf(os.Stderr, "inspect_onnx: ort shutdown: %v\n", err)
			os.Exit(1)
		}
	}()

	for i, path := range flag.Args() {
		inputs, outputs, err := ort.GetInputOutputInfo(path)
		if err != nil {
			fmt.Fprintf(os.Stderr, "inspect_onnx: inspect %s: %v\n", path, err)
			os.Exit(1)
		}

		record := formatRecord(filepath.Base(path), inputs, outputs, asComment)
		if i > 0 {
			fmt.Println()
		}
		fmt.Print(record)
	}
}

func formatRecord(model string, inputs, outputs []ort.InputOutputInfo, asComment bool) string {
	lines := []string{
		"--- ONNX Graph Record ---",
		fmt.Sprintf("Model:    %s", model),
		fmt.Sprintf("Inspected: %s", time.Now().Format("2006-01-02 15:04:05 MST")),
		"",
		"INPUTS:",
	}
	lines = append(lines, formatInfos(inputs)...)
	lines = append(lines, "")
	lines = append(lines, "OUTPUTS:")
	lines = append(lines, formatInfos(outputs)...)
	lines = append(lines, "-------------------------")

	if !asComment {
		return strings.Join(lines, "\n") + "\n"
	}

	for i, line := range lines {
		lines[i] = "// " + line
	}
	return strings.Join(lines, "\n") + "\n"
}

func formatInfos(items []ort.InputOutputInfo) []string {
	if len(items) == 0 {
		return []string{"  <none>"}
	}

	lines := make([]string, 0, len(items))
	for _, item := range items {
		lines = append(lines, fmt.Sprintf("  %-40s %-10s %s", item.Name, item.DataType, formatDims(item.Dimensions)))
	}
	return lines
}

func formatDims(shape ort.Shape) string {
	if len(shape) == 0 {
		return "[]"
	}
	parts := make([]string, len(shape))
	for i, dim := range shape {
		parts[i] = fmt.Sprintf("%d", dim)
	}
	return "[" + strings.Join(parts, " ") + "]"
}
