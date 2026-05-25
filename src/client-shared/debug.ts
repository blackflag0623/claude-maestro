/** Browser-side debug logging gated by `localStorage.MAESTRO_DEBUG`.
 *
 * Usage: open devtools and run `localStorage.MAESTRO_DEBUG = '1'`, reload.
 * Set to '' or remove the key to silence.
 *
 * Errors and warnings should still use `console.error` / `console.warn`
 * directly — those are not gated. */

let cachedEnabled: boolean | null = null;

function enabled(): boolean {
  if (cachedEnabled !== null) return cachedEnabled;
  try {
    cachedEnabled = !!localStorage.getItem('MAESTRO_DEBUG');
  } catch {
    cachedEnabled = false;
  }
  return cachedEnabled;
}

export function debug(...args: unknown[]): void {
  if (!enabled()) return;
  console.log(...args);
}

/** Reset the cached flag — call after toggling localStorage at runtime. */
export function refreshDebug(): void {
  cachedEnabled = null;
}
