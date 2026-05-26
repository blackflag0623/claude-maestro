/** Pending-verdict registry for PreToolUse hook interception.
 *
 *  When the maestro server intercepts a PreToolUse hook in pause mode, it
 *  needs to suspend the HTTP response until the phone user clicks
 *  Allow/Deny. We register a Promise keyed by toolCallId; the WS message
 *  handler resolves it from the user's `toolDecision` message. A timer
 *  also resolves the Promise with `{decision:'allow', timedOut:true}` if
 *  no answer arrives in time.
 *
 *  Keys are scoped per-session (`<sessionId>:<toolCallId>`) so collisions
 *  between sessions are impossible.
 */

export interface ToolVerdict {
  decision: 'allow' | 'deny';
  reason?: string;
  timedOut?: boolean;
}

interface PendingEntry {
  resolve: (v: ToolVerdict) => void;
  timer: NodeJS.Timeout;
}

const pending = new Map<string, PendingEntry>();

function keyFor(sessionId: string, toolCallId: string): string {
  return `${sessionId}:${toolCallId}`;
}

/** Begin awaiting a verdict. Promise always resolves (never rejects);
 *  callers should respect `timedOut` and decide what stdout JSON to emit. */
export function requestVerdict(
  sessionId: string,
  toolCallId: string,
  timeoutMs: number,
): Promise<ToolVerdict> {
  const k = keyFor(sessionId, toolCallId);
  return new Promise<ToolVerdict>((resolve) => {
    // If a previous entry for the same key somehow exists, resolve it as
    // timed-out before installing the new one. Should not happen in practice.
    const prev = pending.get(k);
    if (prev) {
      clearTimeout(prev.timer);
      prev.resolve({ decision: 'allow', timedOut: true });
    }
    const timer = setTimeout(() => {
      const entry = pending.get(k);
      if (!entry) return;
      pending.delete(k);
      entry.resolve({ decision: 'allow', timedOut: true });
    }, timeoutMs);
    pending.set(k, { resolve, timer });
  });
}

/** Resolve a pending verdict from a `toolDecision` WS message. Returns
 *  `true` if a pending entry was found and resolved, `false` if the key
 *  was unknown (e.g. user clicked after the hook already timed out). */
export function resolveVerdict(
  sessionId: string,
  toolCallId: string,
  verdict: ToolVerdict,
): boolean {
  const k = keyFor(sessionId, toolCallId);
  const entry = pending.get(k);
  if (!entry) return false;
  clearTimeout(entry.timer);
  pending.delete(k);
  entry.resolve(verdict);
  return true;
}

/** Clear all pending verdicts for a session — used when the chat client
 *  disconnects (so Claude doesn't sit blocked waiting on nobody). The
 *  current PreToolUse call will fall through to `timedOut → allow` via
 *  its own timer; this just clears them out earlier. */
export function clearVerdictsForSession(sessionId: string) {
  const prefix = `${sessionId}:`;
  for (const [k, entry] of pending) {
    if (!k.startsWith(prefix)) continue;
    clearTimeout(entry.timer);
    pending.delete(k);
    entry.resolve({ decision: 'allow', timedOut: true });
  }
}
