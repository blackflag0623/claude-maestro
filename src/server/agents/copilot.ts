// Copilot CLI strategy.
//
// Copilot ships a richer transcript than Claude — every interesting event
// (turn start / end, permission requested / completed, tool start / complete,
// assistant messages, user messages) is appended to a per-session JSONL at
// `~/.copilot/session-state/<uuid>/events.jsonl`. There is no hook system;
// activity and chat updates come from tailing that file.
//
// Invocation shape (verified against `copilot --help` 1.0.55+):
//   - new:    `copilot --session-id <uuid>`
//   - resume: `copilot --resume <uuid>`
//
// Binary configuration:
//   MAESTRO_COPILOT_BIN          path to the executable (default: `copilot`).
//                                Paths with spaces are supported as-is — no
//                                splitting, so Windows paths like
//                                `C:\Program Files\copilot.exe` work.
//   MAESTRO_COPILOT_PREFIX_ARGS  optional whitespace-split prefix args
//                                inserted before the session flag, for users
//                                of launchers like Microsoft's Agency:
//                                  MAESTRO_COPILOT_BIN=agency
//                                  MAESTRO_COPILOT_PREFIX_ARGS=copilot

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

function resolveBin(name: string): string {
  if (name.includes(path.sep) || name.includes('/')) return name;
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
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {}
    }
  }
  return name;
}

const COPILOT_BIN = resolveBin(COPILOT_BIN_RAW);

// ───────── events.jsonl helpers ─────────

const COPILOT_STATE_DIR = path.join(os.homedir(), '.copilot', 'session-state');

function eventsPathFor(sessionId: string): string {
  return path.join(COPILOT_STATE_DIR, sessionId, 'events.jsonl');
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
 *  pattern as Claude's `TranscriptReader`. */
class CopilotReader implements AgentReader {
  // Offset state for the *live* tailer. Independent of `readAll()` which
  // does its own fresh whole-file read on every call.
  private offset = 0;
  private partial = '';
  private decoder = new StringDecoder('utf8');
  private timer: NodeJS.Timeout | null = null;
  private cb: ReaderCallbacks | null;
  private readonly filePath: string;
  private readonly logTag: string;

  constructor(target: SpawnTarget, cb: ReaderCallbacks) {
    this.filePath = eventsPathFor(target.id);
    this.cb = cb;
    this.logTag = `[copilot.reader] ${target.id.slice(0, 8)}`;

    // Initial scan: if events.jsonl already exists (resumed session, or a
    // restart between PTY spawn and Maestro startup), advance the live-tail
    // offset to EOF so we don't re-emit historical events as "live", and
    // derive the latest activity from history so the UI reflects the true
    // state on first attach. For brand-new sessions the file doesn't exist
    // yet; first tick discovers it and emits everything from offset 0.
    try {
      const buf = fs.readFileSync(this.filePath, 'utf8');
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
      if (last) cb.onActivity(last);
      debug(`${this.logTag} initial scan: offset=${this.offset}, activity=${last ?? 'none'}`);
    } catch {
      // file not yet written — fine, first tick handles it.
    }

    this.startPolling();
  }

  readAll(): ChatMessage[] {
    // Fresh whole-file read. Does NOT touch live-tail offset state — that's
    // managed independently by tick(). Safe to call any number of times.
    let buf: string;
    try {
      buf = fs.readFileSync(this.filePath, 'utf8');
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
    let st: fs.Stats;
    try {
      st = fs.statSync(this.filePath);
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
      const fd = fs.openSync(this.filePath, 'r');
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
        const whole = fs.readFileSync(this.filePath, 'utf8');
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
    // Defensive: if events.jsonl already exists for this session ID, force
    // --resume even if hasResumeData was false. Catches the edge case where
    // Maestro crashed between events.jsonl creation and the first PTY output
    // that would normally have flipped hasResumeData.
    const effectiveMode: SpawnMode =
      mode === 'new' && fs.existsSync(eventsPathFor(target.id)) ? 'resume' : mode;
    const sessionFlag = effectiveMode === 'new' ? '--session-id' : '--resume';
    const args = [...COPILOT_PREFIX_ARGS, sessionFlag, target.id];
    try {
      return pty.spawn(COPILOT_BIN, args, {
        name: 'xterm-256color',
        cols: target.cols,
        rows: target.rows,
        cwd: target.cwd,
        env: { ...process.env, MAESTRO_SESSION: target.id } as Record<string, string>,
      });
    } catch (err) {
      const message = `failed to spawn ${COPILOT_BIN}: ${(err as Error).message}`;
      console.error(`[maestro] ${message}`);
      throw new Error(message);
    }
  },

  createReader(target: SpawnTarget, cb: ReaderCallbacks): AgentReader {
    return new CopilotReader(target, cb);
  },

  // Copilot has no hook system — activity and chat come from events.jsonl.
};
