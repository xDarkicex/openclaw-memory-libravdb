import { setTimeout as sleep } from "node:timers/promises";

// Diagnostic-only polling: do not mistake an unfinished background index for
// a failed positive control. The deadline also bounds a stalled scan.
export async function waitForPositiveControl(scan, timeoutMs = 30000, pollMs = 100) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("No tool-backed frame available before probe deadline")), timeoutMs);
  let rejectDeadline;
  const deadline = new Promise((_, reject) => { rejectDeadline = reject; });
  const abort = () => rejectDeadline(controller.signal.reason);
  controller.signal.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      const result = await Promise.race([scan(controller.signal), deadline]);
      if (result) return result;
      await sleep(pollMs, undefined, { signal: controller.signal });
    }
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timeout);
    controller.abort();
    controller.signal.removeEventListener("abort", abort);
  }
}
