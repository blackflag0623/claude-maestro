// Claude Code agent strategy.
//
// Claude-specific contracts:
//   - Spawn: `claude --session-id <uuid>` for new, `claude --resume <uuid>` for resume.
//   - Hooks: claude POSTs to `/api/hook` on PreToolUse / Stop / etc. We write a
//     Node hook script (`hook.mjs`) plus a settings file (`hooks.json`) and
//     pass `--settings hooks.json` to claude.
//   - Transcript: `TranscriptReader` parses `~/.claude/projects/<slug>/<uuid>.jsonl`.

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
import { TranscriptReader } from '../transcript-reader.js';
import { debug } from '../debug.js';
import { resolveBin } from '../bin-resolve.js';

const STORE_DIR =
  process.env.MAESTRO_STORE_DIR ?? path.join(os.homedir(), '.claude-maestro');

const CLAUDE_BIN_RAW = process.env.MAESTRO_CLAUDE_BIN ?? 'claude';
const CLAUDE_BIN = resolveBin(CLAUDE_BIN_RAW).path;

// ───────── hook files (Claude-specific) ─────────

const HOOK_SCRIPT = path.join(STORE_DIR, 'hook.mjs');
const HOOK_SETTINGS = path.join(STORE_DIR, 'hooks.json');
const NODE_BIN = process.execPath;

const HOOK_ACTIVITY = {
  UserPromptSubmit: 'working',
  PreToolUse: 'working',
  PostToolUse: 'working',
  Notification: 'waiting',
  Stop: 'idle',
} as const satisfies Record<string, SessionActivity>;

const quote = (s: string) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);
// Hook commands are JSON-decoded by claude then passed to a shell. On Windows
// the shell is often bash (Git Bash), which eats backslashes in unquoted
// `\n`/`\v`/etc. — turn paths into forward slashes so they survive both shells.
const shellPath = (p: string) => (process.platform === 'win32' ? p.replace(/\\/g, '/') : p);

function writeIfChanged(filePath: string, contents: string): boolean {
  try {
    if (fs.readFileSync(filePath, 'utf8') === contents) return false;
  } catch {
    // missing or unreadable — fall through and write
  }
  fs.writeFileSync(filePath, contents);
  return true;
}

export function ensureClaudeHookFiles(port: number): void {
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    const hookUrl = `http://127.0.0.1:${port}/api/hook`;
    // Cross-platform hook script. Two paths:
    //   PreToolUse  — blocks on maestro for a verdict (up to ~65s), then
    //                 writes Claude's expected hookSpecificOutput JSON to
    //                 stdout and exits 0. The verdict body shape is
    //                 { decision: 'allow'|'deny', reason?: string, timedOut?: boolean }.
    //   everything  — fire-and-forget; POSTs and exits, 2s ceiling.
    const script = `import http from 'node:http';
const event = process.argv[2] ?? '';
const isBlocking = event === 'PreToolUse';
let body = '';
process.stdin.on('data', (c) => { body += c; });
process.stdin.on('end', () => {
  const req = http.request(${JSON.stringify(hookUrl)}, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      'x-maestro-event': event,
    },
    timeout: isBlocking ? 65000 : 2000,
  });
  if (!isBlocking) {
    req.on('error', () => process.exit(0));
    req.on('response', () => process.exit(0));
    req.on('timeout', () => { req.destroy(); process.exit(0); });
    req.end(body);
    return;
  }
  req.on('error', () => { writeAllow('hook transport error'); process.exit(0); });
  req.on('timeout', () => { req.destroy(); writeAllow('hook timeout'); process.exit(0); });
  req.on('response', (res) => {
    let raw = '';
    res.setEncoding('utf8');
    res.on('data', (c) => { raw += c; });
    res.on('end', () => {
      let verdict;
      try { verdict = JSON.parse(raw); } catch { writeAllow('hook reply unparseable'); process.exit(0); return; }
      const out = {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: verdict && verdict.decision === 'deny' ? 'deny' : 'allow',
          permissionDecisionReason:
            (verdict && verdict.reason) ||
            (verdict && verdict.timedOut ? 'no answer from mobile chat — auto-allowed' : 'auto-allowed'),
        },
      };
      process.stdout.write(JSON.stringify(out));
      process.exit(0);
    });
  });
  req.end(body);
});
process.stdin.on('error', () => process.exit(0));

function writeAllow(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: reason,
    },
  }));
}
`;
    const scriptChanged = writeIfChanged(HOOK_SCRIPT, script);
    if (scriptChanged && process.platform !== 'win32') fs.chmodSync(HOOK_SCRIPT, 0o755);
    const command = `${quote(shellPath(NODE_BIN))} ${quote(shellPath(HOOK_SCRIPT))}`;
    // PreToolUse can block on a phone verdict for up to ~60s; give Claude's
    // per-hook timeout a matching budget. Others stay on the implicit default.
    const settings = {
      hooks: Object.fromEntries(
        Object.keys(HOOK_ACTIVITY).map((event) => {
          const entry: { hooks: Array<{ type: 'command'; command: string; timeout?: number }> } = {
            hooks: [{ type: 'command', command: `${command} ${event}` }],
          };
          if (event === 'PreToolUse') entry.hooks[0]!.timeout = 75;
          return [event, [entry]];
        }),
      ),
    };
    writeIfChanged(HOOK_SETTINGS, JSON.stringify(settings, null, 2));
  } catch (err) {
    console.error('[maestro] could not write hook files:', (err as Error).message);
  }
}

// ───────── reader ─────────

/** Claude's reader wraps the JSONL `TranscriptReader`. It does not poll on
 *  its own: it relies on `poke()` being called by the strategy's
 *  `handleHookEvent` on `Stop`. We poll across an exponential schedule then
 *  because claude's Stop hook fires before assistant entries are fully
 *  appended, and one turn can write multiple assistant entries. */
class ClaudeReader implements AgentReader {
  private inner: TranscriptReader;
  private cb: ReaderCallbacks | null;
  private disposed = false;

  constructor(target: SpawnTarget, cb: ReaderCallbacks) {
    this.inner = new TranscriptReader(target.id, target.cwd);
    this.cb = cb;
  }

  readAll(): ChatMessage[] {
    return this.inner.readAll();
  }

  poke(): void {
    if (this.disposed || !this.cb) return;
    const POLL_DELAYS_MS = [0, 120, 300, 600, 1200, 2400, 4000];
    let attempt = 0;
    const tick = () => {
      if (this.disposed || !this.cb) return;
      const msgs = this.inner.readIncremental();
      if (msgs.length) {
        debug(`[claude.reader] attempt ${attempt} → ${msgs.length} msg(s)`);
      }
      for (const m of msgs) this.cb.onChatMessage(m);
      attempt++;
      if (attempt < POLL_DELAYS_MS.length) {
        setTimeout(tick, POLL_DELAYS_MS[attempt]!);
      }
    };
    tick();
  }

  dispose(): void {
    this.disposed = true;
    this.cb = null;
  }
}

// ───────── strategy ─────────

export const claudeStrategy: AgentStrategy = {
  type: 'claude',
  displayName: 'Claude Code',
  supportsPermissionGating: true,

  spawn(target: SpawnTarget, mode: SpawnMode): pty.IPty {
    const baseArgs =
      mode === 'new' ? ['--session-id', target.id] : ['--resume', target.id];
    const args = [...baseArgs, '--settings', HOOK_SETTINGS];
    try {
      return pty.spawn(CLAUDE_BIN, args, {
        name: 'xterm-256color',
        cols: target.cols,
        rows: target.rows,
        cwd: target.cwd,
        env: { ...process.env, MAESTRO_SESSION: target.id } as Record<string, string>,
      });
    } catch (err) {
      const message = `failed to spawn ${CLAUDE_BIN}: ${(err as Error).message}`;
      console.error(`[maestro] ${message}`);
      throw new Error(message);
    }
  },

  createReader(target: SpawnTarget, cb: ReaderCallbacks): AgentReader {
    return new ClaudeReader(target, cb);
  },

  handleHookEvent(eventName: string) {
    const activity = (HOOK_ACTIVITY as Record<string, SessionActivity>)[eventName];
    if (!activity && eventName !== 'Stop') return null;
    return {
      activity,
      flushChat: eventName === 'Stop',
    };
  },
};
