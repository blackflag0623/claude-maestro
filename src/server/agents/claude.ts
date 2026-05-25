// Claude Code strategy. Extracted verbatim from the original monolithic
// `index.ts` — the spawn args, hook script, settings layout, and bin lookup
// rules are unchanged. Only the call surface has been reshaped to fit
// `AgentStrategy`.
//
// What's Claude-specific here:
//   - `claude --session-id <uuid>` / `claude --resume <uuid>` invocation.
//   - A hook system: claude POSTs to `/api/hook` on PreToolUse / Stop / etc.
//     We write a tiny Node-only hook script (`hook.mjs`) plus a settings
//     file (`hooks.json`) and pass `--settings hooks.json` to claude.
//   - The transcript reader (`TranscriptReader`) parses Claude's own
//     `~/.claude/projects/<slug>/<uuid>.jsonl` files.

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

// Shared resolution rules with index.ts (kept in sync; both read env directly).
const PORT = Number(process.env.PORT ?? 4050);
const STORE_DIR =
  process.env.MAESTRO_STORE_DIR ?? path.join(os.homedir(), '.claude-maestro');

const CLAUDE_BIN_RAW = process.env.MAESTRO_CLAUDE_BIN ?? 'claude';

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

const CLAUDE_BIN = resolveBin(CLAUDE_BIN_RAW);

// ───────── hook files (Claude-specific) ─────────

const HOOK_SCRIPT = path.join(STORE_DIR, 'hook.mjs');
const HOOK_SETTINGS = path.join(STORE_DIR, 'hooks.json');
const HOOK_URL = `http://127.0.0.1:${PORT}/api/hook`;
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

export function ensureClaudeHookFiles(): void {
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    // Cross-platform hook: tiny Node script. Reads JSON from stdin, fires a
    // POST to the maestro server, exits immediately. No shell dependency.
    const script = `import http from 'node:http';
const event = process.argv[2] ?? '';
let body = '';
process.stdin.on('data', (c) => { body += c; });
process.stdin.on('end', () => {
  const req = http.request(${JSON.stringify(HOOK_URL)}, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      'x-maestro-event': event,
    },
    timeout: 2000,
  });
  req.on('error', () => process.exit(0));
  req.on('response', () => process.exit(0));
  req.on('timeout', () => { req.destroy(); process.exit(0); });
  req.end(body);
});
process.stdin.on('error', () => process.exit(0));
`;
    const scriptChanged = writeIfChanged(HOOK_SCRIPT, script);
    if (scriptChanged && process.platform !== 'win32') fs.chmodSync(HOOK_SCRIPT, 0o755);
    const command = `${quote(shellPath(NODE_BIN))} ${quote(shellPath(HOOK_SCRIPT))}`;
    const settings = {
      hooks: Object.fromEntries(
        Object.keys(HOOK_ACTIVITY).map((event) => [
          event,
          [{ hooks: [{ type: 'command', command: `${command} ${event}` }] }],
        ]),
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
