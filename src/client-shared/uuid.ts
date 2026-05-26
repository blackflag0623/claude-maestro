/** Stable id helper. Prefers `crypto.randomUUID` when available (modern
 *  browsers, all maestro-supported targets); falls back to a short base36
 *  random for very old contexts. The fallback collision risk is acceptable
 *  for client-only ids (server entries, etc.) — sessions use server-issued
 *  ids, not these. */
export function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return 'm-' + Math.random().toString(36).slice(2, 10);
}
