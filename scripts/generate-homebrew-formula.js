#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const REQUIRED_TARGETS = {
  "__SHA256_DARWIN_ARM64__": "libravdbd-darwin-arm64.sha256",
  "__SHA256_DARWIN_AMD64__": "libravdbd-darwin-amd64.sha256",
  "__SHA256_LINUX_ARM64__": "libravdbd-linux-arm64.sha256",
  "__SHA256_LINUX_AMD64__": "libravdbd-linux-amd64.sha256",
};

const OPTIONAL_TARGETS = {
  "__SHA256_PROVISION__": "provision.sh.sha256",
};

export function readChecksumFile(filePath) {
  const text = fs.readFileSync(filePath, "utf8").trim();
  const match = text.match(/[a-f0-9]{64}/i);
  if (!match) {
    throw new Error(`No SHA-256 checksum found in ${filePath}`);
  }
  return match[0].toLowerCase();
}

export function collectChecksums(distDir) {
  const checksums = {};
  for (const [placeholder, fileName] of Object.entries(REQUIRED_TARGETS)) {
    checksums[placeholder] = readChecksumFile(path.join(distDir, fileName));
  }
  for (const [placeholder, fileName] of Object.entries(OPTIONAL_TARGETS)) {
    const filePath = path.join(distDir, fileName);
    if (fs.existsSync(filePath)) {
      checksums[placeholder] = readChecksumFile(filePath);
    }
  }
  return checksums;
}

export function buildFormula({ version, template, checksums }) {
  let output = template.replaceAll("__VERSION__", version);
  for (const [placeholder, checksum] of Object.entries(checksums)) {
    output = output.replaceAll(placeholder, checksum);
  }
  const unreplaced = output.match(/__[A-Z0-9_]+__/g) ?? [];
  if (unreplaced.length > 0) {
    const missing = [...new Set(unreplaced)].join(", ");
    console.warn(`Warning: unreplaced placeholders in formula output: ${missing}`);
  }
  return output;
}

function parseArgs(argv) {
  const args = { version: "", dist: "", template: "", output: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === "--version") {
      args.version = value ?? "";
      i += 1;
    } else if (arg === "--dist") {
      args.dist = value ?? "";
      i += 1;
    } else if (arg === "--template") {
      args.template = value ?? "";
      i += 1;
    } else if (arg === "--output") {
      args.output = value ?? "";
      i += 1;
    }
  }
  if (!args.version || !args.dist || !args.template || !args.output) {
    throw new Error("Usage: node scripts/generate-homebrew-formula.js --version <version> --dist <dist-dir> --template <template> --output <output>");
  }
  return args;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  const template = fs.readFileSync(args.template, "utf8");
  const checksums = collectChecksums(args.dist);
  const formula = buildFormula({
    version: args.version,
    template,
    checksums,
  });
  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.writeFileSync(args.output, formula);
}
