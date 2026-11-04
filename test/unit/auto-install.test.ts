import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const installer = path.join(process.cwd(), "scripts", "auto-install.sh");
const bashAvailable = spawnSync("bash", ["--version"]).status === 0;

for (const mode of ["download-failure", "checksum-failure", "checksum-mismatch", "success"]) {
  test(`manual daemon upgrade stages and verifies replacement: ${mode}`, {
    skip: !bashAvailable && "Bash is required to run the installer",
  }, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "libravdb-installer-"));
    try {
      const commands = path.join(root, "commands");
      fs.mkdirSync(commands);
      fs.writeFileSync(path.join(commands, "curl"), `#!${process.execPath}
const fs = require("node:fs");
const crypto = require("node:crypto");
const args = process.argv.slice(2);
const content = "verified new daemon\\n";
const mode = process.env.CURL_FIXTURE_MODE;
if (args.at(-1).endsWith(".sha256")) {
  if (mode === "checksum-failure") process.exit(22);
  console.log(mode === "checksum-mismatch" ? "0".repeat(64) : crypto.createHash("sha256").update(content).digest("hex"));
} else {
  fs.writeFileSync(args[args.indexOf("-o") + 1], content);
  if (mode === "download-failure") process.exit(22);
}
`, { mode: 0o755 });
      const binary = path.join(root, "libravdbd");
      fs.writeFileSync(binary, "previous daemon\n", { mode: 0o755 });
      const result = spawnSync("bash", [
        "-c",
        'source "$1"; trap cleanup_on_exit EXIT; install_daemon_asset "$2" "$3"',
        "installer-test",
        installer,
        "https://example.invalid/libravdbd",
        binary,
      ], {
        env: {
          ...process.env,
          PATH: `${commands}${path.delimiter}${process.env.PATH || ""}`,
          CURL_FIXTURE_MODE: mode,
        },
        encoding: "utf8",
      });
      if (mode === "success") {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(fs.readFileSync(binary, "utf8"), "verified new daemon\n");
        if (process.platform !== "win32") assert.ok(fs.statSync(binary).mode & 0o111);
      } else {
        assert.equal(result.status, 1, result.stderr);
        assert.equal(fs.readFileSync(binary, "utf8"), "previous daemon\n");
      }
      assert.deepEqual(fs.readdirSync(root).sort(), ["commands", "libravdbd"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
