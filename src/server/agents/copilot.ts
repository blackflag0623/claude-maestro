// Copilot CLI strategy.
//
// Copilot ships a richer transcript than Claude — every interesting event
// (turn start / end, permission requested / completed, tool start / complete,
// assistant messages, user messages) is appended to a per-session JSONL at
// `~/.copilot/session-state/<uuid>/events.jsonl`. There is no hook system;
// activity and chat updates come from tailing that file.
//
// Two launch modes are supported:
//
//   1. DIRECT (default) — maestro owns the session uuid. Spawn invocation
//      is always `copilot --session-id=<uuid>` regardless of new/resume
//      intent: per `copilot --help`, --session-id is symmetric — it sets the
//      uuid for a new session if none exists, or resumes the existing one.
//      This makes maestro robust against Copilot or the user cleaning up
//      `~/.copilot/session-state/<uuid>/` between restarts: rather than
//      hard-failing with `No session matched <uuid>` (what `--resume=<uuid>`
//      would do), Copilot just creates a fresh session under the same uuid
//      and the node stays usable. The `=` form is REQUIRED — copilot's
//      parser treats `--session-id <uuid>` (space-separated) as a boolean
//      flag plus a positional resume name.
//
//   2. AGENCY — `agency` wraps copilot (e.g. Microsoft devboxes). The wrapper
//      injects its own session flags into the forwarded argv, so maestro
//      MUST NOT pass `--session-id`. Spawn invocation:
//        new:    `agency copilot`           (agency picks the uuid)
//        resume: `agency copilot --resume=<copilotSessionId>`  (agency forwards
//                                                                this through)
//      Post-spawn for "new", maestro discovers the agency-issued uuid by
//      watching `~/.copilot/session-state/` for a newly-created directory
//      (see `discoverAgencyUuid` below), then records it on the session via
//      `target.onCopilotSessionId(...)` so it's persisted for cross-restart
//      resume. Resume pre-flight: if the events.jsonl for the recorded
//      copilotSessionId is gone, clear the recorded id and downgrade to a
//      fresh agency session (agency picks a new uuid). The server surfaces a
//      banner via `target.onResumeUnavailable` so the user understands why
//      the conversation was reset.
//
// Mode detection (precedence):
//   1. `MAESTRO_COPILOT_AGENCY=1` → agency mode (explicit opt-in).
//   2. basename(MAESTRO_COPILOT_BIN) starts with `agency` (case-insensitive)
//      → agency mode (auto-detect; the usual MS-devbox config).
//   3. Otherwise → direct mode.
//
// Binary configuration:
//   MAESTRO_COPILOT_BIN          path to the executable (default: `copilot`).
//                                On a Microsoft devbox, set to `agency`.
//   MAESTRO_COPILOT_PREFIX_ARGS  optional whitespace-split prefix args
//                                inserted before the session flag. In agency
//                                mode, this must contain `copilot` (so the
//                                argv becomes `agency copilot [flags]`).
//   MAESTRO_COPILOT_AGENCY       set to `1` to force agency mode regardless
//                                of the binary name.
//
// Session id model:
//   - `target.id` is always the maestro session id (used for WS routing,
//     scrollback path, etc.).
//   - `target.copilotSessionId` is the agent's own uuid (used to locate
//     events.jsonl). In direct mode it equals `target.id`; in agency mode it
//     is the agency-issued uuid (undefined until discovery completes).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as pty from '@lydell/node-pty';
import type {
  AgentReader,
  AgentStrategy,
  ReaderCallbacks,
  SpawnMode,
  SpawnTarget,
} from './index.js';
import type { ChatMessage, SessionActivity } from '../../shared/protocol.js';
import { debug } from '../debug.js';
import { JsonlTail, parseJsonl } from '../jsonl-tail.js';
import { resolveBin, type ResolvedBin } from '../bin-resolve.js';

// ───────── binary resolution & launch-mode detection ─────────

const RAW_BIN_ENV = process.env.MAESTRO_COPILOT_BIN;
const USER_SET_BIN = RAW_BIN_ENV !== undefined && RAW_BIN_ENV.trim() !== '';
const RAW_BIN_REQUESTED = (RAW_BIN_ENV ?? 'copilot').trim() || 'copilot';

const USER_PREFIX_ARGS = (process.env.MAESTRO_COPILOT_PREFIX_ARGS ?? '')
  .split(/\s+/)
  .filter(Boolean);

const RAW_AGENCY_ENV = process.env.MAESTRO_COPILOT_AGENCY;
const AGENCY_EXPLICITLY_ENABLED = RAW_AGENCY_ENV === '1';
const AGENCY_EXPLICITLY_DISABLED = RAW_AGENCY_ENV === '0';

/** Recognised launch modes. Persisted per-session as `copilotLaunchMode` so
 *  that a maestro restart in a different mode can detect the mismatch and
 *  fail-closed rather than silently start a fresh agency session against an
 *  existing direct-mode session's uuid. */
export type CopilotLaunchMode = 'direct' | 'agency';

/** Resolution of binary + launch mode. All four pieces (mode, bin, prefix
 *  args, display name) are decided together so auto-fallback can promote
 *  `copilot` → `agency copilot` atomically. */
interface CopilotResolution {
  mode: CopilotLaunchMode;
  binInfo: ResolvedBin;
  prefixArgs: string[];
  /** What to surface in logs/errors. For auto-fallback this is "agency"; for
   *  explicit configs it echoes what the user set. */
  displayBin: string;
  /** True when maestro promoted the binary from `copilot` to `agency`
   *  because `copilot` was missing on PATH. Used to make startup logs and
   *  spawn errors honest about what's actually being executed. */
  autoAgency: boolean;
}

/** Decide which binary + launch mode to use, in priority order:
 *
 *  1. If the user pinned `MAESTRO_COPILOT_BIN`, honor it. Launch mode comes
 *     from `MAESTRO_COPILOT_AGENCY` (if explicit) or the bin's basename.
 *  2. If the user set `MAESTRO_COPILOT_AGENCY=1` explicitly, force agency
 *     mode using whatever bin/prefix args they configured.
 *  3. **Auto-fallback** (the Microsoft-devbox happy path): if no bin pin
 *     and `copilot` is not on PATH but `agency` is, promote to
 *     `agency copilot` automatically. Opt out with `MAESTRO_COPILOT_AGENCY=0`.
 *  4. Otherwise: direct mode with `copilot` (which may still resolve fine,
 *     or fall through to a spawn-time error if missing).
 */
function resolveCopilot(): CopilotResolution {
  const requestedInfo = resolveBin(RAW_BIN_REQUESTED);
  const requestedBase = path.basename(RAW_BIN_REQUESTED).toLowerCase();
  const requestedIsAgency =
    requestedBase === 'agency' || requestedBase.startsWith('agency.');

  // Case 1+2: user pinned bin OR explicit agency=1 — no auto-fallback.
  if (USER_SET_BIN || AGENCY_EXPLICITLY_ENABLED) {
    const mode: CopilotLaunchMode =
      AGENCY_EXPLICITLY_ENABLED || requestedIsAgency ? 'agency' : 'direct';
    return {
      mode,
      binInfo: requestedInfo,
      prefixArgs: USER_PREFIX_ARGS,
      displayBin: RAW_BIN_REQUESTED,
      autoAgency: false,
    };
  }

  // Case 3: auto-fallback. Only when copilot is not on PATH and user did
  // not opt out via MAESTRO_COPILOT_AGENCY=0.
  if (!requestedInfo.found && !AGENCY_EXPLICITLY_DISABLED) {
    const agencyInfo = resolveBin('agency');
    if (agencyInfo.found) {
      const prefix = USER_PREFIX_ARGS.includes('copilot')
        ? USER_PREFIX_ARGS
        : ['copilot', ...USER_PREFIX_ARGS];
      return {
        mode: 'agency',
        binInfo: agencyInfo,
        prefixArgs: prefix,
        displayBin: 'agency',
        autoAgency: true,
      };
    }
  }

  // Case 4: direct, possibly unresolved.
  return {
    mode: 'direct',
    binInfo: requestedInfo,
    prefixArgs: USER_PREFIX_ARGS,
    displayBin: RAW_BIN_REQUESTED,
    autoAgency: false,
  };
}

const COPILOT_RESOLUTION = resolveCopilot();
const COPILOT_BIN_INFO = COPILOT_RESOLUTION.binInfo;
const COPILOT_BIN = COPILOT_BIN_INFO.path;
const COPILOT_BIN_RAW = COPILOT_RESOLUTION.displayBin;
const COPILOT_PREFIX_ARGS = COPILOT_RESOLUTION.prefixArgs;
export const COPILOT_LAUNCH_MODE: CopilotLaunchMode = COPILOT_RESOLUTION.mode;
const COPILOT_AUTO_AGENCY = COPILOT_RESOLUTION.autoAgency;

// ───── startup diagnostics ─────

if (COPILOT_AUTO_AGENCY) {
  console.log(
    `[maestro] Copilot: auto-detected agency launch mode — \`copilot\` is not on PATH but \`agency\` is. ` +
      `Spawning sessions via \`agency copilot ...\`. ` +
      `Override with MAESTRO_COPILOT_BIN=<path>, or disable auto-detection with MAESTRO_COPILOT_AGENCY=0.`,
  );
} else if (COPILOT_LAUNCH_MODE === 'agency') {
  // Explicit agency configuration. Sanity-check prefix args.
  if (!COPILOT_PREFIX_ARGS.includes('copilot')) {
    console.warn(
      `[maestro] WARNING: Copilot launch mode = agency (explicit), but MAESTRO_COPILOT_PREFIX_ARGS does not include "copilot". ` +
        `Expected env: MAESTRO_COPILOT_BIN=agency MAESTRO_COPILOT_PREFIX_ARGS=copilot. ` +
        `Current MAESTRO_COPILOT_PREFIX_ARGS="${(process.env.MAESTRO_COPILOT_PREFIX_ARGS ?? '').trim()}".`,
    );
  }
  console.log(`[maestro] Copilot launch mode: agency (binary="${COPILOT_BIN_RAW}")`);
} else if (!COPILOT_BIN_INFO.found) {
  // Direct mode, copilot binary missing. Auto-fallback already covered the
  // common Microsoft-devbox case; this only fires when the user disabled
  // auto-fallback or pinned a missing custom path.
  console.warn(
    `[maestro] WARNING: Copilot CLI binary "${COPILOT_BIN_RAW}" not found on PATH. ` +
      `Copilot sessions will fail to spawn. ` +
      `Install hint: \`npm install -g @github/copilot\` (then ensure the npm global bin dir is on PATH), ` +
      `or on Windows install via WinGet (\`winget install GitHub.Copilot\`), ` +
      `or set MAESTRO_COPILOT_BIN to an absolute path to the executable, then restart maestro.`,
  );
}


// ───────── events.jsonl helpers ─────────

const COPILOT_STATE_DIR = path.join(os.homedir(), '.copilot', 'session-state');

function eventsPathFor(sessionId: string): string {
  return path.join(COPILOT_STATE_DIR, sessionId, 'events.jsonl');
}

/** Copilot's shape inside `SpawnTarget.agentState`. */
interface CopilotAgentState {
  /** The agent's own session uuid. In direct mode this equals `target.id`.
   *  In agency mode it's the agency-issued uuid, populated post-spawn after
   *  watching `~/.copilot/session-state/`. */
  copilotSessionId?: string;
  /** Launch mode the session was created with. Required (we set it at
   *  create-time). Used to fail-closed on cross-mode resumes. */
  copilotLaunchMode?: 'direct' | 'agency';
}

function getCopilotState(target: SpawnTarget): CopilotAgentState {
  return target.agentState as CopilotAgentState;
}

function setCopilotSessionId(target: SpawnTarget, id: string) {
  const state = getCopilotState(target);
  if (state.copilotSessionId === id) return;
  state.copilotSessionId = id;
  target.onAgentStateChange?.({ ...state });
}

/** Resolve the copilot uuid that backs a given target. In direct mode this
 *  is always `target.id`. In agency mode it's the agency-issued uuid once
 *  discovery has completed (otherwise `undefined`). */
function resolveCopilotId(target: SpawnTarget): string | undefined {
  const state = getCopilotState(target);
  if (COPILOT_LAUNCH_MODE === 'direct') return state.copilotSessionId ?? target.id;
  return state.copilotSessionId;
}

// ───────── agency-mode discovery ─────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AGENCY_DISCOVERY_POLL_MS = 200;
const AGENCY_DISCOVERY_TIMEOUT_MS = 10_000;
/** Clock-skew slop applied when comparing dir birth/ctime to spawn time. */
const AGENCY_DISCOVERY_CTIME_SLOP_MS = 1_000;

/** Mutex: only one agency-mode spawn is in its discovery window at a time.
 *  Doesn't protect against other shells / other maestro processes on the same
 *  OS user (those are covered by the ctime filter + multi-candidate fail-
 *  closed below) — but eliminates intra-process races. */
let agencyDiscoveryChain: Promise<void> = Promise.resolve();

interface AgencyDiscoveryResult {
  ok: true;
  copilotSessionId: string;
}
interface AgencyDiscoveryFailure {
  ok: false;
  reason: string;
}

/** List uuid-named dirs in COPILOT_STATE_DIR with their ctime. Returns an
 *  empty array if the dir doesn't yet exist (first-ever copilot run on the
 *  host). */
function listSessionStateDirs(): Map<string, number> {
  const out = new Map<string, number>();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(COPILOT_STATE_DIR, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (!UUID_RE.test(ent.name)) continue;
    try {
      const st = fs.statSync(path.join(COPILOT_STATE_DIR, ent.name));
      // birthtime is preferred (Windows always supports it); ctime is the
      // POSIX fallback.
      const ts = st.birthtimeMs > 0 ? st.birthtimeMs : st.ctimeMs;
      out.set(ent.name, ts);
    } catch {
      // unreadable — skip
    }
  }
  return out;
}

/** Watch `COPILOT_STATE_DIR` for a NEW uuid-named directory that appeared
 *  after `spawnTime` and is not in `preSnapshot`. Resolves with the chosen
 *  uuid, or a failure with a human-readable reason.
 *
 *  Correctness rules (in priority order):
 *    1. Filter to dirs whose ctime/birthtime >= spawnTime - slop (eliminates
 *       races against unrelated pre-existing dirs that were missed by the
 *       pre-snapshot for some reason).
 *    2. Filter to dirs NOT in pre-snapshot (eliminates pre-existing dirs).
 *    3. If exactly one candidate emerges → adopt it.
 *    4. If multiple candidates emerge (another agency-copilot ran in another
 *       shell at the same time) → fail closed.
 *    5. If no candidates within the timeout → fail closed. */
async function watchForAgencyUuid(
  preSnapshot: Set<string>,
  spawnTime: number,
  signal: { cancelled: boolean },
): Promise<AgencyDiscoveryResult | AgencyDiscoveryFailure> {
  const deadline = Date.now() + AGENCY_DISCOVERY_TIMEOUT_MS;
  const ctimeFloor = spawnTime - AGENCY_DISCOVERY_CTIME_SLOP_MS;

  while (Date.now() < deadline) {
    if (signal.cancelled) {
      return { ok: false, reason: 'discovery cancelled (PTY exited before adoption)' };
    }
    const current = listSessionStateDirs();
    const candidates: string[] = [];
    for (const [name, ts] of current) {
      if (preSnapshot.has(name)) continue;
      if (ts < ctimeFloor) continue;
      candidates.push(name);
    }
    if (candidates.length === 1) {
      return { ok: true, copilotSessionId: candidates[0]! };
    }
    if (candidates.length > 1) {
      return {
        ok: false,
        reason:
          `multiple new session-state directories observed within the discovery window ` +
          `(${candidates.join(', ')}). This usually means another \`agency copilot\` was started ` +
          `concurrently from a different shell. Refusing to guess which one belongs to this maestro session.`,
      };
    }
    await new Promise<void>((r) => setTimeout(r, AGENCY_DISCOVERY_POLL_MS));
  }
  return {
    ok: false,
    reason: `no new ~/.copilot/session-state/<uuid>/ directory appeared within ${
      AGENCY_DISCOVERY_TIMEOUT_MS / 1000
    }s. Agency may have failed to launch copilot, or copilot's state directory layout has changed.`,
  };
}

/** Translate one parsed event object into a ChatMessage, or null if not a
 *  rendered turn. Only text-bearing events are surfaced; tool calls, hooks,
 *  permission prompts, etc. are tracked separately as activity. */
function entryToChatMessage(entry: unknown): ChatMessage | null {
  if (!entry || typeof entry !== 'object') return null;
  const e = entry as Record<string, unknown>;
  const tsStr = typeof e.timestamp === 'string' ? e.timestamp : null;
  const ts = tsStr ? Date.parse(tsStr) || Date.now() : Date.now();
  const data = e.data as Record<string, unknown> | undefined;
  if (!data) return null;
  if (e.type === 'assistant.message') {
    const content = typeof data.content === 'string' ? data.content : '';
    if (!content) return null; // tool-only turns have empty content
    return { type: 'assistant_text', text: content, ts };
  }
  if (e.type === 'user.message') {
    const content = typeof data.content === 'string' ? data.content : '';
    if (!content) return null;
    return { type: 'user_text', text: content, ts };
  }
  return null;
}

/** Map an event type to an activity transition, or null to leave activity
 *  unchanged. Order in events.jsonl is roughly:
 *    session.start
 *    user.message              → working
 *    assistant.turn_start      → working
 *    tool.execution_start      → (stay working)
 *    permission.requested      → waiting
 *    permission.completed      → working
 *    tool.execution_complete   → (stay working)
 *    assistant.message
 *    assistant.turn_end        → idle */
function entryToActivity(entry: unknown): SessionActivity | null {
  if (!entry || typeof entry !== 'object') return null;
  const e = entry as Record<string, unknown>;
  switch (e.type) {
    case 'assistant.turn_start':
    case 'tool.execution_start':
    case 'external_tool.requested':
    case 'subagent.started':
    case 'user.message':
      return 'working';
    case 'permission.requested':
      return 'waiting';
    case 'permission.completed':
      return 'working';
    case 'assistant.turn_end':
      return 'idle';
    case 'session.shutdown':
    case 'abort':
      return 'unknown';
    default:
      return null;
  }
}

// ───────── reader ─────────

/** How often to poll the events.jsonl file. 400 ms balances activity-
 *  indicator latency against CPU cost (one stat + maybe a pread per session
 *  per tick). Active sessions usually have N≤10 so this is negligible. */
const POLL_INTERVAL_MS = 400;

/** Log a debug warning if history replay reads a file larger than this. */
const HISTORY_WARN_BYTES = 10 * 1024 * 1024;

/** Tail copilot's events.jsonl with the same pread+offset+StringDecoder
 *  pattern as Claude's `TranscriptReader`.
 *
 *  Agency-mode subtlety: at construction time, the file path may not be
 *  resolvable (target.copilotSessionId is not yet set). The reader holds the
 *  target by reference and re-derives the path on every tick. When the path
 *  first becomes resolvable AND the file exists, we run the deferred
 *  "initial scan" (advance offset to EOF, derive activity from history) so
 *  resuming agency sessions don't replay history as live updates. Direct
 *  mode behavior is unchanged. */
class CopilotReader implements AgentReader {
  private tail: JsonlTail;
  private timer: NodeJS.Timeout | null = null;
  private cb: ReaderCallbacks | null;
  private readonly target: SpawnTarget;
  private readonly logTag: string;
  /** Records the path against which the tail's offset is valid. If the path
   *  changes mid-tail (agency discovery flips the resolution), we reset the
   *  tail and re-run the initial scan against the new file. */
  private boundPath: string | null = null;
  /** Set after a successful initial scan against `boundPath`. Reset on path
   *  change. */
  private initialScanned = false;

  constructor(target: SpawnTarget, cb: ReaderCallbacks) {
    this.target = target;
    this.cb = cb;
    this.logTag = `[copilot.reader] ${target.id.slice(0, 8)}`;
    this.tail = new JsonlTail(target.id.slice(0, 8));

    // Eager initial scan for direct-mode resumes (file already on disk). For
    // agency-mode new sessions the path isn't yet resolvable; the first few
    // ticks no-op until discovery sets target.copilotSessionId.
    this.maybeInitialScan();
    this.startPolling();
  }

  private currentPath(): string | null {
    const sid = resolveCopilotId(this.target);
    return sid ? eventsPathFor(sid) : null;
  }

  /** Parse the entire existing file once, advance offset to EOF, and derive
   *  activity from the last activity-bearing event. Idempotent. */
  private maybeInitialScan(): boolean {
    const p = this.currentPath();
    if (!p) return false;
    if (p !== this.boundPath) {
      this.tail.resetForNewPath();
      this.boundPath = p;
      this.initialScanned = false;
    }
    if (this.initialScanned) return true;
    let buf: string;
    try {
      buf = fs.readFileSync(p, 'utf8');
    } catch {
      return false; // file not yet written; will retry on next tick.
    }
    let last: SessionActivity | null = null;
    for (const line of buf.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const a = entryToActivity(parsed);
      if (a) last = a;
    }
    this.tail.markConsumed(Buffer.byteLength(buf, 'utf8'));
    if (last && this.cb) this.cb.onActivity(last);
    this.initialScanned = true;
    debug(`${this.logTag} initial scan complete (activity=${last ?? 'none'}, ${p})`);
    return true;
  }

  readAll(): ChatMessage[] {
    const p = this.currentPath();
    if (!p) return [];
    let buf: string;
    try {
      buf = fs.readFileSync(p, 'utf8');
    } catch {
      return [];
    }
    if (Buffer.byteLength(buf, 'utf8') > HISTORY_WARN_BYTES) {
      debug(`${this.logTag} large transcript: ${buf.length} chars (consider streaming)`);
    }
    return parseJsonl(buf, entryToChatMessage);
  }

  poke(): void {
    // Pure file-tailer — already polling on its own interval. No-op.
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.cb = null;
  }

  private startPolling(): void {
    this.timer = setInterval(() => this.tick(), POLL_INTERVAL_MS);
    this.timer.unref?.();
  }

  private tick(): void {
    if (!this.cb) return;
    if (!this.maybeInitialScan()) return;
    const p = this.boundPath!;
    const complete = this.tail.read(p);
    if (!complete) return;

    // Walk lines, emitting chat + activity in order. We re-parse rather than
    // calling parseJsonl twice so events stay strictly ordered.
    for (const line of complete.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const activity = entryToActivity(parsed);
      if (activity && this.cb) this.cb.onActivity(activity);
      const msg = entryToChatMessage(parsed);
      if (msg && this.cb) this.cb.onChatMessage(msg);
    }
  }
}



// ───────── strategy ─────────

export const copilotStrategy: AgentStrategy = {
  type: 'copilot',
  displayName: 'GitHub Copilot CLI',

  initialAgentState(id: string): Record<string, unknown> {
    // Direct mode: the copilot uuid equals our id. Agency mode: agency owns
    // the uuid; we'll discover and persist it after the first spawn.
    const state: CopilotAgentState = {
      copilotLaunchMode: COPILOT_LAUNCH_MODE,
      copilotSessionId: COPILOT_LAUNCH_MODE === 'direct' ? id : undefined,
    };
    return state as Record<string, unknown>;
  },

  validateAgentState(raw: Record<string, unknown>): void {
    const state = raw as CopilotAgentState;
    // Pre-feature records (no copilotLaunchMode field) predate the agency
    // launch mode and so were direct-mode by definition.
    const persistedMode = state.copilotLaunchMode ?? 'direct';
    if (persistedMode !== COPILOT_LAUNCH_MODE) {
      throw new Error(
        `Copilot session was created in '${persistedMode}' launch mode, ` +
          `but this maestro process is running in '${COPILOT_LAUNCH_MODE}' mode. ` +
          `To resume, restart maestro with the original mode ` +
          `(set/unset MAESTRO_COPILOT_AGENCY and MAESTRO_COPILOT_BIN accordingly). ` +
          `To start over, delete the session and create a new one.`,
      );
    }
    // Direct-mode legacy backfill: if the old record didn't carry a
    // copilotSessionId, the uuid is the maestro id (set lazily on spawn from
    // resolveCopilotId's fallback).
  },

  spawn(target: SpawnTarget, mode: SpawnMode): pty.IPty {
    // Pre-flight (agency mode only): if a resume was requested but the
    // agency-issued session-state dir is gone (cleaned up by the user, by
    // Copilot, or by agency itself between maestro restarts), the
    // `--resume=<uuid>` call would hard-fail with
    //   "Error: No session, task, or name matched '<uuid>'."
    // Detect ahead of time, clear the stale copilotSessionId, and downgrade
    // to a fresh agency session. The server-side `onResumeUnavailable`
    // callback shows a banner so the user knows the conversation was reset.
    //
    // Direct mode doesn't need this: --session-id is symmetric (creates if
    // missing, resumes if present), so Copilot recovers transparently.
    let effectiveMode = mode;
    const state = getCopilotState(target);
    if (
      mode === 'resume' &&
      COPILOT_LAUNCH_MODE === 'agency' &&
      state.copilotSessionId &&
      !fs.existsSync(eventsPathFor(state.copilotSessionId))
    ) {
      const oldId = state.copilotSessionId;
      state.copilotSessionId = undefined;
      target.onAgentStateChange?.({ ...state });
      target.onResumeUnavailable?.(
        `agency-issued Copilot session ~/.copilot/session-state/${oldId}/ is gone`,
      );
      effectiveMode = 'new';
    }

    const args = buildSpawnArgs(target, effectiveMode);
    let term: pty.IPty;
    try {
      term = pty.spawn(COPILOT_BIN, args, {
        name: 'xterm-256color',
        cols: target.cols,
        rows: target.rows,
        cwd: target.cwd,
        env: { ...process.env, MAESTRO_SESSION: target.id } as Record<string, string>,
      });
    } catch (err) {
      throw buildSpawnError(err, args);
    }

    // Agency mode + new session: agency owns the uuid; we discover it after
    // spawn by watching `~/.copilot/session-state/` for a new dir. The
    // CopilotReader holds `target` by reference and re-resolves the events
    // path on each tick, so once we record the copilot session id on
    // agentState the reader picks up automatically.
    if (COPILOT_LAUNCH_MODE === 'agency' && !getCopilotState(target).copilotSessionId) {
      kickOffAgencyDiscovery(target, term);
    }

    return term;
  },

  createReader(target: SpawnTarget, cb: ReaderCallbacks): AgentReader {
    return new CopilotReader(target, cb);
  },

  // Copilot has no hook system — activity and chat come from events.jsonl.
};

// ───────── spawn helpers ─────────

function buildSpawnArgs(target: SpawnTarget, mode: SpawnMode): string[] {
  const state = getCopilotState(target);
  if (COPILOT_LAUNCH_MODE === 'agency') {
    // Agency owns the uuid for new sessions. For resume, we forward the
    // agency-issued uuid back through agency to copilot. Empirically (user-
    // verified) agency forwards `--resume=<uuid>` through.
    if (mode === 'resume' && state.copilotSessionId) {
      return [...COPILOT_PREFIX_ARGS, `--resume=${state.copilotSessionId}`];
    }
    return [...COPILOT_PREFIX_ARGS];
  }

  // Direct mode: `--session-id=<uuid>` is symmetric per `copilot --help`:
  //   "Resume an existing session or task by ID, or set the UUID for a new
  //    session."
  // So we always pass the maestro session id with this flag regardless of
  // new/resume intent. Concrete advantages:
  //   - First spawn ever:  Copilot creates ~/.copilot/session-state/<uuid>/
  //     and uses that uuid going forward. (Same as before.)
  //   - Subsequent attach: if the dir still exists Copilot resumes; if it's
  //     gone (manual cleanup, Copilot's own GC, OS reinstall), Copilot starts
  //     a fresh session under the same uuid instead of hard-failing with
  //     "No session, task, or name matched '<uuid>'" — which is what
  //     `--resume=<uuid>` would do. Maestro never has to second-guess the
  //     on-disk state.
  // The `=` form is REQUIRED — copilot's parser treats `--session-id <uuid>`
  // (space-separated) as a boolean flag plus a positional resume name.
  void mode; // intentional: --session-id handles both branches.
  return [...COPILOT_PREFIX_ARGS, `--session-id=${target.id}`];
}

function buildSpawnError(err: unknown, args: readonly string[]): Error {
  const inner = (err as Error).message || String(err);
  const parts = [
    `failed to spawn Copilot CLI: ${inner}`,
    `  attempted binary: ${COPILOT_BIN}`,
    `  argv:             ${args.join(' ')}`,
    `  launch mode:      ${COPILOT_LAUNCH_MODE}${COPILOT_AUTO_AGENCY ? ' (auto-detected)' : ''}`,
  ];
  if (COPILOT_BIN_RAW !== COPILOT_BIN) {
    parts.push(`  configured name:  ${COPILOT_BIN_RAW}`);
  }
  if (!COPILOT_BIN_INFO.found) {
    parts.push(
      `  resolution:       NOT FOUND on PATH at server startup`,
      `  fix:              install Copilot CLI on this host (e.g. \`npm install -g @github/copilot\` or \`winget install GitHub.Copilot\`),`,
      `                    or set MAESTRO_COPILOT_BIN to an absolute path to the executable, then restart maestro.`,
    );
    if (AGENCY_EXPLICITLY_DISABLED) {
      parts.push(
        `  note:             MAESTRO_COPILOT_AGENCY=0 disabled auto-fallback to \`agency copilot\`.`,
        `                    Unset it (or set to 1) to let maestro pick up \`agency\` automatically.`,
      );
    }
  } else {
    parts.push(
      `  resolution:       found on PATH`,
      `  hint:             if this is a wrapper script or symlink that node-pty can't execute,`,
      `                    set MAESTRO_COPILOT_BIN to the real target binary and restart maestro.`,
    );
  }
  const message = parts.join('\n');
  console.error(`[maestro] ${message}`);
  return new Error(message);
}

/** Snapshot session-state dirs, await mutex, then race a watcher against the
 *  PTY-exit signal. On success: mutate `target.copilotSessionId` and notify
 *  the server via `target.onCopilotSessionId(...)`. On failure: emit a
 *  diagnostic; the reader will keep no-oping (no copilotSessionId set), and
 *  the user will see no chat history. The PTY itself continues running. */
function kickOffAgencyDiscovery(target: SpawnTarget, term: pty.IPty): void {
  const preSnapshot = new Set(listSessionStateDirs().keys());
  const spawnTime = Date.now();
  const signal = { cancelled: false };

  // If the PTY exits before discovery completes, cancel — the session is
  // dead and there's no point continuing to poll.
  term.onExit(() => {
    signal.cancelled = true;
  });

  agencyDiscoveryChain = agencyDiscoveryChain.then(async () => {
    debug(
      `[copilot.agency] discovery start session=${target.id.slice(0, 8)} ` +
        `preSnapshot=${preSnapshot.size}`,
    );
    const result = await watchForAgencyUuid(preSnapshot, spawnTime, signal);
    if (!result.ok) {
      console.error(
        `[maestro] Copilot agency-mode session ${target.id} discovery failed: ${result.reason}`,
      );
      return;
    }
    debug(
      `[copilot.agency] discovered session=${target.id.slice(0, 8)} → ` +
        `copilotSessionId=${result.copilotSessionId}`,
    );
    try {
      setCopilotSessionId(target, result.copilotSessionId);
    } catch (err) {
      console.error(
        `[maestro] persist copilot session id failed for ${target.id}: ${
          (err as Error).message
        }`,
      );
    }
  });
}
