/**
 * Format an unknown thrown value as a human-readable string.
 *
 * If the value is an Error with a non-blank message, returns the trimmed
 * message.  Otherwise falls back to `String(error)`, which produces
 * `"Error"` for `new Error("")` and preserves the original string for
 * non-Error throws.
 */
export function formatError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  return String(error);
}
