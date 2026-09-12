import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { waitForPositiveControl } from "./hydration-probe-control.mjs";

test("Gateway probe creates private output and rejects existing files and symlinks before execution", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydration-probe-"));
  try {
    const report = path.join(dir, "sessions.json");
    const cli = path.join(dir, "gateway.mjs");
    const output = path.join(dir, "output.json");
    const marker = path.join(dir, "executed");
    await fs.writeFile(report, JSON.stringify({ sessions: [{ key: "test", sessionId: "test" }] }));
    await fs.writeFile(cli, 'import fs from "node:fs"; fs.writeFileSync(process.env.MARKER,"yes"); console.log(JSON.stringify({status:"ok"}));');
    const run = () => promisify(execFile)(process.execPath, [new URL("./probe-hydration-gateway.mjs", import.meta.url).pathname], {
      env: { ...process.env, SESSIONS_REPORT: report, PROBE_SESSION_KEY: "test", GATEWAY_CLI: cli, PROBE_OUTPUT: output, MARKER: marker },
    });
    await run();
    assert.equal((await fs.stat(output)).mode & 0o777, 0o600);
    await fs.unlink(marker);
    await fs.chmod(output, 0o644);
    await fs.writeFile(output, "original");
    await assert.rejects(run, /EEXIST/);
    assert.equal(await fs.readFile(output, "utf8"), "original");
    await assert.rejects(fs.stat(marker), { code: "ENOENT" });
    await fs.unlink(output);
    await fs.symlink(report, output);
    await assert.rejects(run, /EEXIST/);
    assert.equal(JSON.parse(await fs.readFile(report, "utf8")).sessions[0].key, "test");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("positive control waits for catch-up instead of failing on an empty initial index", async () => {
  let scans = 0;
  assert.equal(await waitForPositiveControl(async () => ++scans >= 3 ? "research" : undefined, 1000, 1), "research");
  assert.equal(scans, 3);
});

test("positive control bounds empty and stalled scans and propagates real failures", async () => {
  await assert.rejects(waitForPositiveControl(async () => undefined, 20, 1000), /probe deadline/);
  await assert.rejects(waitForPositiveControl(() => new Promise(() => {}), 20, 1), /deadline/);
  await assert.rejects(waitForPositiveControl(async () => { throw new Error("RPC failed"); }), /RPC failed/);
});

test("probe deadline cancels an active cooperative read", async () => {
  let active = 0;
  await assert.rejects(waitForPositiveControl(signal => new Promise((_, reject) => {
    active++;
    signal.addEventListener("abort", () => { active--; reject(signal.reason); }, { once: true });
  }), 20, 1), /probe deadline/);
  assert.equal(active, 0);
});
