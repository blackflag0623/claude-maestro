// Tiny debug helper gated on the `MAESTRO_DEBUG` env var.
//
// Routine `console.log` calls for normal operation are noisy in production
// (one per hook event, one per transcript flush, etc.). Funnelling them
// through `debug()` keeps the default startup clean while letting operators
// opt in with `MAESTRO_DEBUG=1 npm start`.
//
// `console.error` for real failures stays unguarded — those are always logged.

const ENABLED = Boolean(process.env.MAESTRO_DEBUG);

export function debug(...args: unknown[]): void {
  if (ENABLED) console.log(...args);
}

export const debugEnabled = ENABLED;
