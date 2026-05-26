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
//   1. DIRECT (default) — maestro owns the session uuid. Spawn invocation:
//        new:    `copilot --session-id=<uuid>`
//        resume: `copilot --resume=<uuid>`
//      The `=` form is REQUIRED — copilot's parser treats `--session-id <uuid>`
//      (space-separated) as a boolean flag plus a positional resume name.
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
//      resume.
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
import { StringDecoder } from 'node:string_decoder';
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

// ───────── binary resolution ─────────

const COPILOT_BIN_RAW = (process.env.MAESTRO_COPILOT_BIN ?? 'copilot').trim() || 'copilot';
const COPILOT_PREFIX_ARGS = (process.env.MAESTRO_COPILOT_PREFIX_ARGS ?? '')
  .split(/\s+/)
  .filter(Boolean);

interface ResolvedBin {
  /** The path that will be passed to pty.spawn. Either the literal name (if
   *  it contained a separator) or an absolute path discovered on PATH. If
   *  resolution failed we still return the literal name so the spawn attempt
   *  surfaces the user-visible error path. */
  path: string;
  /** True if the path was resolved from PATH (or the user supplied an
   *  explicit path). False if we fell through with no match. */
  found: boolean;
  /** Directories we searched on PATH (empty for explicit paths). Used to
   *  build a helpful spawn-failure message. */
  searched: string[];
}

function resolveBin(name: string): ResolvedBin {
  if (name.includes(path.sep) || name.includes('/')) {
    return { path: name, found: fs.existsSync(name), searched: [] };
  }
  const exts =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
          .split(';')
          .map((e) => e.toLowerCase())
      : [''];
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    for (const ext of exts) {
      const candidate = path.join(d, name + ext);
      try {
        if (fs.statSync(candidate).isFile()) {
          return { path: candidate, found: true, searched: dirs };
        }
      } catch {}
    }
  }
  return { path: name, found: false, searched: dirs };
}

const COPILOT_BIN_INFO = resolveBin(COPILOT_BIN_RAW);
const COPILOT_BIN = COPILOT_BIN_INFO.path;

/** True iff `agency` exists on PATH — used to steer users on Microsoft
 *  devboxes toward agency launch mode when `copilot` isn't directly on PATH.
 *  Resolved once at module load; intentionally cheap (no spawn). */
const AGENCY_ON_PATH = resolveBin('agency').found;

if (!COPILOT_BIN_INFO.found) {
  // Surface immediately at startup so the operator sees it before the first
  // user attempts a Copilot session and hits the (less helpful) spawn-time
  // failure on the wire.
  if (AGENCY_ON_PATH && COPILOT_BIN_RAW === 'copilot') {
    console.warn(
      `[maestro] WARNING: Copilot CLI binary "copilot" not found on PATH, but "agency" IS on PATH. ` +
        `This looks like a Microsoft devbox. Enable agency launch mode by setting these env vars ` +
        `before starting maestro:\n` +
        `    MAESTRO_COPILOT_BIN=agency\n` +
        `    MAESTRO_COPILOT_PREFIX_ARGS=copilot\n` +
        `(or just MAESTRO_COPILOT_AGENCY=1 if you keep MAESTRO_COPILOT_BIN unset, but you still need PREFIX_ARGS=copilot). ` +
        `See CLAUDE.md → "Copilot launch modes".`,
    );
  } else {
    console.warn(
      `[maestro] WARNING: Copilot CLI binary "${COPILOT_BIN_RAW}" not found on PATH. ` +
        `Copilot sessions will fail to spawn until either (a) "${COPILOT_BIN_RAW}" is installed and on PATH ` +
        `for the maestro server process, or (b) MAESTRO_COPILOT_BIN is set to an absolute path to the executable. ` +
        `Install hint: \`npm install -g @github/copilot\` (then ensure the npm global bin dir is on PATH), ` +
        `or on Windows install via WinGet (\`winget install GitHub.Copilot\`).`,
    );
  }
}

// ───────── launch mode (direct vs agency) ─────────

/** Recognised launch modes. Persisted per-session as `copilotLaunchMode` so
 *  that a maestro restart in a different mode can detect the mismatch and
 *  fail-closed rather than silently start a fresh agency session against an
 *  existing direct-mode session's uuid. */
export type CopilotLaunchMode = 'direct' | 'agency';

function detectLaunchMode(): CopilotLaunchMode {
  if (process.env.MAESTRO_COPILOT_AGENCY === '1') return 'agency';
  const base = path.basename(COPILOT_BIN_RAW).toLowerCase();
  // basename "agency", "agency.exe", "agency.cmd" all match. We avoid a
  // bare `.includes('agency')` so a path like `C:\agency-tools\copilot.exe`
  // does not get mis-detected.
  if (base === 'agency' || base.startsWith('agency.')) return 'agency';
  return 'direct';
}

export const COPILOT_LAUNCH_MODE: CopilotLaunchMode = detectLaunchMode();

if (COPILOT_LAUNCH_MODE === 'agency') {
  // Sanity check: in agency mode, prefix args must include `copilot` (or the
  // user is on a setup we don't recognise). Warn loudly so the misconfig is
  // visible at startup rather than at spawn time.
  if (!COPILOT_PREFIX_ARGS.includes('copilot')) {
    console.warn(
      `[maestro] WARNING: Copilot launch mode = agency, but MAESTRO_COPILOT_PREFIX_ARGS does not include "copilot". ` +
        `Expected env: MAESTRO_COPILOT_BIN=agency MAESTRO_COPILOT_PREFIX_ARGS=copilot. ` +
        `Current MAESTRO_COPILOT_PREFIX_ARGS="${(process.env.MAESTRO_COPILOT_PREFIX_ARGS ?? '').trim()}".`,
    );
  }
  console.warn(`[maestro] Copilot launch mode: agency (binary="${COPILOT_BIN_RAW}")`);
}

// ───────── events.jsonl helpers ─────────

const COPILOT_STATE_DIR = path.join(os.homedir(), '.copilot', 'session-state');

function eventsPathFor(sessionId: string): string {
  return path.join(COPILOT_STATE_DIR, sessionId, 'events.jsonl');
}

/** Resolve the copilot uuid that backs a given target. In direct mode this
 *  is always `target.id`. In agency mode it's `target.copilotSessionId` once
 *  discovery has completed (otherwise `undefined`). */
function resolveCopilotId(target: SpawnTarget): string | undefined {
  if (COPILOT_LAUNCH_MODE === 'direct') return target.copilotSessionId ?? target.id;
  return target.copilotSessionId;
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
  // Offset state for the *live* tailer. Independent of `readAll()` which
  // does its own fresh whole-file read on every call.
  private offset = 0;
  private partial = '';
  private decoder = new StringDecoder('utf8');
  private timer: NodeJS.Timeout | null = null;
  private cb: ReaderCallbacks | null;
  private readonly target: SpawnTarget;
  private readonly logTag: string;
  /** Records the path against which `offset` is valid. If the path changes
   *  mid-tail (agency discovery flips the resolution), we reset offsets and
   *  re-run the initial scan against the new file. */
  private boundPath: string | null = null;
  /** Set after a successful initial scan against `boundPath`. Reset on path
   *  change. */
  private initialScanned = false;

  constructor(target: SpawnTarget, cb: ReaderCallbacks) {
    this.target = target;
    this.cb = cb;
    this.logTag = `[copilot.reader] ${target.id.slice(0, 8)}`;

    // Eager initial scan for direct-mode resumes (file already on disk). For
    // agency-mode new sessions the path isn't yet resolvable; the first few
    // ticks no-op until discovery sets target.copilotSessionId, at which
    // point tick() re-runs the initial scan against the new path.
    this.maybeInitialScan();
    this.startPolling();
  }

  /** Current path to events.jsonl, or null if the copilot uuid is not yet
   *  known (agency mode, pre-discovery). */
  private currentPath(): string | null {
    const sid = resolveCopilotId(this.target);
    return sid ? eventsPathFor(sid) : null;
  }

  /** Initial scan logic: parse the entire existing file once, advance
   *  `offset` to EOF, and derive activity from the last activity-bearing
   *  event. Idempotent — only runs once per `boundPath`. Returns true if a
   *  scan was successfully completed (or already had been). */
  private maybeInitialScan(): boolean {
    const p = this.currentPath();
    if (!p) return false;
    if (p !== this.boundPath) {
      // Path changed (or first resolution). Reset before scanning.
      this.offset = 0;
      this.partial = '';
      this.decoder = new StringDecoder('utf8');
      this.boundPath = p;
      this.initialScanned = false;
    }
    if (this.initialScanned) return true;
    try {
      const buf = fs.readFileSync(p, 'utf8');
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
      this.offset = Buffer.byteLength(buf, 'utf8');
      if (last && this.cb) this.cb.onActivity(last);
      this.initialScanned = true;
      debug(`${this.logTag} initial scan: offset=${this.offset}, activity=${last ?? 'none'} (${p})`);
      return true;
    } catch {
      // File not yet written; will retry on next tick.
      return false;
    }
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
    // Detect path resolution / change; do initial scan when ready.
    if (!this.maybeInitialScan()) return;
    const p = this.boundPath!;
    let st: fs.Stats;
    try {
      st = fs.statSync(p);
    } catch {
      return; // file not written yet
    }
    if (st.size === this.offset) return;
    if (st.size < this.offset) {
      debug(`${this.logTag} shrank ${this.offset}→${st.size}, restarting`);
      this.offset = 0;
      this.partial = '';
      this.decoder = new StringDecoder('utf8');
    }
    const length = st.size - this.offset;
    let chunk: string;
    try {
      const fd = fs.openSync(p, 'r');
      try {
        const buf = Buffer.allocUnsafe(length);
        const read = fs.readSync(fd, buf, 0, length, this.offset);
        chunk = this.partial + this.decoder.write(buf.slice(0, read));
        this.offset += read;
      } finally {
        fs.closeSync(fd);
      }
    } catch (err) {
      debug(`${this.logTag} pread failed (${(err as Error).message}), fallback`);
      try {
        const whole = fs.readFileSync(p, 'utf8');
        const totalBytes = Buffer.byteLength(whole, 'utf8');
        if (totalBytes < this.offset) {
          this.offset = 0;
          this.partial = '';
        }
        this.decoder = new StringDecoder('utf8');
        const tail = Buffer.from(whole, 'utf8').slice(this.offset).toString('utf8');
        chunk = this.partial + tail;
        this.offset = totalBytes;
      } catch (err2) {
        debug(`${this.logTag} fallback failed: ${(err2 as Error).message}`);
        return;
      }
    }
    const lastNl = chunk.lastIndexOf('\n');
    if (lastNl < 0) {
      this.partial = chunk;
      return;
    }
    this.partial = chunk.slice(lastNl + 1);
    const complete = chunk.slice(0, lastNl);

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

function parseJsonl<T>(buf: string, map: (entry: unknown) => T | null): T[] {
  const out: T[] = [];
  for (const line of buf.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const m = map(parsed);
    if (m !== null) out.push(m);
  }
  return out;
}

// ───────── strategy ─────────

export const copilotStrategy: AgentStrategy = {
  type: 'copilot',
  displayName: 'GitHub Copilot CLI',

  spawn(target: SpawnTarget, mode: SpawnMode): pty.IPty {
    const args = buildSpawnArgs(target, mode);
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
    // path on each tick, so once we set `target.copilotSessionId` and call
    // `target.onCopilotSessionId(...)` the reader picks up automatically.
    if (COPILOT_LAUNCH_MODE === 'agency' && !target.copilotSessionId) {
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
  if (COPILOT_LAUNCH_MODE === 'agency') {
    // Agency owns the uuid for new sessions. For resume, we forward the
    // agency-issued uuid back through agency to copilot. Empirically (user-
    // verified) agency forwards `--resume=<uuid>` through.
    if (mode === 'resume' && target.copilotSessionId) {
      return [...COPILOT_PREFIX_ARGS, `--resume=${target.copilotSessionId}`];
    }
    return [...COPILOT_PREFIX_ARGS];
  }

  // Direct mode. Defensive: if events.jsonl already exists for this session
  // ID, force --resume even if hasResumeData was false. Catches the edge
  // case where Maestro crashed between events.jsonl creation and the first
  // PTY output that would normally have flipped hasResumeData.
  const effectiveMode: SpawnMode =
    mode === 'new' && fs.existsSync(eventsPathFor(target.id)) ? 'resume' : mode;
  const sessionFlag = effectiveMode === 'new' ? '--session-id' : '--resume';
  // Copilot's CLI parser requires `--flag=value`, not `--flag value`. Passing
  // them as two tokens makes copilot treat the uuid as a positional resume
  // name, which fails with "No session, task, or name matched '<uuid>'".
  return [...COPILOT_PREFIX_ARGS, `${sessionFlag}=${target.id}`];
}

function buildSpawnError(err: unknown, args: readonly string[]): Error {
  const inner = (err as Error).message || String(err);
  const parts = [
    `failed to spawn Copilot CLI: ${inner}`,
    `  attempted binary: ${COPILOT_BIN}`,
    `  argv:             ${args.join(' ')}`,
    `  launch mode:      ${COPILOT_LAUNCH_MODE}`,
  ];
  if (COPILOT_BIN_RAW !== COPILOT_BIN) {
    parts.push(`  configured name:  ${COPILOT_BIN_RAW}`);
  }
  if (!COPILOT_BIN_INFO.found) {
    if (AGENCY_ON_PATH && COPILOT_BIN_RAW === 'copilot') {
      parts.push(
        `  resolution:       NOT FOUND on PATH at server startup`,
        `  detected:         "agency" IS on PATH — this looks like a Microsoft devbox.`,
        `  fix:              restart maestro with agency launch mode enabled:`,
        `                        MAESTRO_COPILOT_BIN=agency`,
        `                        MAESTRO_COPILOT_PREFIX_ARGS=copilot`,
        `                    (see CLAUDE.md → "Copilot launch modes")`,
      );
    } else {
      parts.push(
        `  resolution:       NOT FOUND on PATH at server startup`,
        `  fix:              install Copilot CLI on this host (e.g. \`npm install -g @github/copilot\` or \`winget install GitHub.Copilot\`),`,
        `                    or set MAESTRO_COPILOT_BIN to an absolute path to the executable, then restart maestro.`,
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
    target.copilotSessionId = result.copilotSessionId;
    try {
      target.onCopilotSessionId?.(result.copilotSessionId);
    } catch (err) {
      console.error(
        `[maestro] onCopilotSessionId callback threw for session ${target.id}: ${
          (err as Error).message
        }`,
      );
    }
  });
}
