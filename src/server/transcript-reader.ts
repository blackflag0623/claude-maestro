import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ChatMessage } from '../shared/protocol.js';

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

/** Per-session tail state. The transcript is append-only JSONL; we remember
 *  how many bytes we've consumed and only parse newly-arrived bytes on each
 *  poll. The file is opened fresh each read so external truncation/rotation
 *  surfaces as size shrinking, in which case we reset and re-read whole. */
export class TranscriptReader {
  private offset = 0;
  private partial = ''; // incomplete trailing line carried across reads
  private path: string | null = null;

  constructor(
    private readonly sessionId: string,
    private readonly cwd: string,
  ) {}

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
    this.offset = Buffer.byteLength(buf, 'utf8');
    this.partial = '';
    return parseJsonl(buf);
  }

  /** Read whatever appended since the last read. Returns ChatMessages parsed
   *  from new complete lines. Safe to call when the file does not yet exist. */
  readIncremental(): ChatMessage[] {
    const p = this.locate();
    if (!p) {
      console.log(`[transcript] ${this.sessionId.slice(0, 8)} no transcript file found yet`);
      return [];
    }
    let st: fs.Stats;
    try {
      st = fs.statSync(p);
    } catch (err) {
      console.log(`[transcript] ${this.sessionId.slice(0, 8)} stat failed: ${(err as Error).message}`);
      return [];
    }
    if (st.size === this.offset) {
      console.log(`[transcript] ${this.sessionId.slice(0, 8)} no growth (size=${st.size})`);
      return [];
    }
    if (st.size < this.offset) {
      console.log(`[transcript] ${this.sessionId.slice(0, 8)} shrank ${this.offset}→${st.size}, restarting`);
      this.offset = 0;
      this.partial = '';
    }
    const length = st.size - this.offset;
    let chunk: string;
    // Prefer pread (openSync+readSync at offset) but fall back to whole-file
    // read on Windows where the writer's exclusive handle can block us.
    try {
      const fd = fs.openSync(p, 'r');
      try {
        const buf = Buffer.allocUnsafe(length);
        const read = fs.readSync(fd, buf, 0, length, this.offset);
        chunk = this.partial + buf.slice(0, read).toString('utf8');
        this.offset += read;
      } finally {
        fs.closeSync(fd);
      }
    } catch (err) {
      console.log(`[transcript] ${this.sessionId.slice(0, 8)} pread failed (${(err as Error).message}), falling back to readFile`);
      try {
        const whole = fs.readFileSync(p, 'utf8');
        const totalBytes = Buffer.byteLength(whole, 'utf8');
        if (totalBytes < this.offset) {
          this.offset = 0;
          this.partial = '';
        }
        // Best-effort byte slice; the file is UTF-8 and JSONL lines are
        // self-contained so a wrong split would still resolve at the next
        // newline boundary via this.partial.
        const tail = Buffer.from(whole, 'utf8').slice(this.offset).toString('utf8');
        chunk = this.partial + tail;
        this.offset = totalBytes;
      } catch (err2) {
        console.log(`[transcript] ${this.sessionId.slice(0, 8)} fallback also failed: ${(err2 as Error).message}`);
        return [];
      }
    }
    const lastNl = chunk.lastIndexOf('\n');
    if (lastNl < 0) {
      this.partial = chunk;
      return [];
    }
    this.partial = chunk.slice(lastNl + 1);
    const msgs = parseJsonl(chunk.slice(0, lastNl));
    console.log(`[transcript] ${this.sessionId.slice(0, 8)} read ${length} bytes → ${msgs.length} message(s) (offset now ${this.offset})`);
    return msgs;
  }

  private locate(): string | null {
    if (this.path && fs.existsSync(this.path)) return this.path;
    const found = findTranscript(this.sessionId, this.cwd);
    if (found) {
      this.path = found;
      // Reset offset when we first locate; readAll/readIncremental decide how to use it.
    }
    return this.path;
  }
}

function parseJsonl(buf: string): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const line of buf.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const m = entryToChatMessage(parsed);
    if (m) out.push(m);
  }
  return out;
}
