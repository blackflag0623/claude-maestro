import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ChatMessage } from '../shared/protocol.js';
import { debug } from './debug.js';
import { JsonlTail, parseJsonl } from './jsonl-tail.js';

/** Convert an absolute cwd to the slug Claude uses for its project directory.
 *  Observed rule (Claude Code 2.1.x on Windows):
 *    - lowercase drive letter
 *    - `:` → `-`
 *    - `\` and `/` → `-`
 *    - trailing `-` trimmed
 *  Examples:
 *    `E:\claude-maestro`           → `e--claude-maestro`
 *    `E:\YiGuThreeKingdomsCode/`   → `e--YiGuThreeKingdomsCode`
 *    `/Users/foo/repo`             → `-Users-foo-repo`   (POSIX, untested)
 *
 *  The rule may evolve in future Claude versions. If a slug derived here
 *  doesn't exist on disk we fall back to scanning ~/.claude/projects/ for a
 *  directory containing a JSONL whose first line's `cwd` matches.
 */
export function cwdToSlug(cwd: string): string {
  return cwd
    .replace(/[A-Z]:/g, (m) => m[0]!.toLowerCase() + ':')
    .replace(/:/g, '-')
    .replace(/[\\/]/g, '-')
    .replace(/-+$/, '');
}

const CLAUDE_PROJECTS = path.join(os.homedir(), '.claude', 'projects');

function transcriptCandidates(sessionId: string, cwd: string): string[] {
  const slug = cwdToSlug(cwd);
  const guessed = path.join(CLAUDE_PROJECTS, slug, `${sessionId}.jsonl`);
  const out = [guessed];

  // Fallback: walk every project dir, look for the exact filename.
  // O(n) over projects but n is small (one dir per cwd ever used).
  try {
    for (const entry of fs.readdirSync(CLAUDE_PROJECTS, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(CLAUDE_PROJECTS, entry.name, `${sessionId}.jsonl`);
      if (candidate !== guessed && fs.existsSync(candidate)) out.push(candidate);
    }
  } catch {}
  return out;
}

/** Resolve the transcript path for a session, returning null if not yet written. */
export function findTranscript(sessionId: string, cwd: string): string | null {
  for (const p of transcriptCandidates(sessionId, cwd)) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** Convert one JSONL entry into a ChatMessage, or null if not a rendered turn.
 *  Recognized:
 *    - `type:'assistant'` with `message.content[].type === 'text'`
 *    - `type:'user'` with `message.content` as string OR as an array of
 *      `{type:'text', text}` blocks. Tool-result user entries (synthetic
 *      messages Claude injects after a tool runs) are skipped — they carry
 *      `content[].type === 'tool_result'` and aren't user-typed text. */
function entryToChatMessage(entry: unknown): ChatMessage | null {
  if (!entry || typeof entry !== 'object') return null;
  const e = entry as Record<string, unknown>;
  const tsStr = typeof e.timestamp === 'string' ? e.timestamp : null;
  const ts = tsStr ? Date.parse(tsStr) || Date.now() : Date.now();

  if (e.type === 'assistant') {
    const message = e.message as { content?: unknown } | undefined;
    if (!message || !Array.isArray(message.content)) return null;
    const parts: string[] = [];
    for (const block of message.content as Array<Record<string, unknown>>) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text);
      }
    }
    if (parts.length === 0) return null;
    return { type: 'assistant_text', text: parts.join('\n\n'), ts };
  }

  if (e.type === 'user') {
    const message = e.message as { content?: unknown } | undefined;
    if (!message) return null;
    let text = '';
    if (typeof message.content === 'string') {
      text = message.content;
    } else if (Array.isArray(message.content)) {
      const parts: string[] = [];
      for (const block of message.content as Array<Record<string, unknown>>) {
        // Skip synthetic tool-result messages; only real user text.
        if (block?.type === 'text' && typeof block.text === 'string') {
          parts.push(block.text);
        }
      }
      text = parts.join('\n\n');
    }
    if (!text) return null;
    return { type: 'user_text', text, ts };
  }

  return null;
}

/** Per-session tail state. The transcript is append-only JSONL; we read it
 *  via JsonlTail (offset + StringDecoder + pread/fallback) and re-locate the
 *  file on each read so a delayed first write or rotation surfaces cleanly. */
export class TranscriptReader {
  private path: string | null = null;
  private tail: JsonlTail;

  constructor(
    private readonly sessionId: string,
    private readonly cwd: string,
  ) {
    this.tail = new JsonlTail(this.sessionId.slice(0, 8));
  }

  /** Read the entire transcript (used for history replay on first attach). */
  readAll(): ChatMessage[] {
    const p = this.locate();
    if (!p) return [];
    let buf: string;
    try {
      buf = fs.readFileSync(p, 'utf8');
    } catch {
      return [];
    }
    this.path = p;
    this.tail.markConsumed(Buffer.byteLength(buf, 'utf8'));
    return parseJsonl(buf, entryToChatMessage);
  }

  /** Read whatever appended since the last read. Returns ChatMessages parsed
   *  from new complete lines. Safe to call when the file does not yet exist. */
  readIncremental(): ChatMessage[] {
    const p = this.locate();
    if (!p) {
      debug(`[transcript] ${this.sessionId.slice(0, 8)} no transcript file found yet`);
      return [];
    }
    const complete = this.tail.read(p);
    if (!complete) return [];
    const msgs = parseJsonl(complete, entryToChatMessage);
    debug(`[transcript] ${this.sessionId.slice(0, 8)} → ${msgs.length} message(s)`);
    return msgs;
  }

  private locate(): string | null {
    if (this.path && fs.existsSync(this.path)) return this.path;
    const found = findTranscript(this.sessionId, this.cwd);
    if (found) this.path = found;
    return this.path;
  }
}
