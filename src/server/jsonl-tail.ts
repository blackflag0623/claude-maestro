import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { debug } from './debug.js';

/** Parse a string of JSONL into a list of T's. Skips blank and unparseable
 *  lines silently. */
export function parseJsonl<T>(buf: string, map: (entry: unknown) => T | null): T[] {
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

/** Incremental JSONL file tail.
 *
 *  Tracks how many bytes have been consumed and only parses newly-appended
 *  bytes on each `read()`. StringDecoder preserves incomplete multi-byte
 *  UTF-8 sequences across chunk boundaries — a chunk boundary mid-codepoint
 *  would otherwise become a replacement char and corrupt the JSONL stream
 *  forever (since `offset` already advanced past those bytes).
 *
 *  Pread is preferred; on Windows where the writer's exclusive handle can
 *  block a separate `open`, falls back to whole-file readFileSync.
 *
 *  External truncation/rotation surfaces as size shrinking from one read to
 *  the next, in which case offset resets to 0 and history is re-read. */
export class JsonlTail {
  private offset = 0;
  private partial = '';
  private decoder = new StringDecoder('utf8');

  constructor(private readonly tag: string) {}

  /** Read every newly-appended line and return it as a single string (without
   *  a trailing newline). Caller passes that into `parseJsonl` (or walks
   *  lines manually if it wants per-line side effects).
   *
   *  Returns `null` when nothing changed; `''` when bytes arrived but no
   *  complete line yet. */
  read(filePath: string): string | null {
    let st: fs.Stats;
    try {
      st = fs.statSync(filePath);
    } catch (err) {
      debug(`[jsonl-tail] ${this.tag} stat failed: ${(err as Error).message}`);
      return null;
    }
    if (st.size === this.offset) return null;
    if (st.size < this.offset) {
      debug(`[jsonl-tail] ${this.tag} shrank ${this.offset}→${st.size}, restarting`);
      this.reset();
    }
    const length = st.size - this.offset;
    let chunk: string;
    try {
      const fd = fs.openSync(filePath, 'r');
      try {
        const buf = Buffer.allocUnsafe(length);
        const read = fs.readSync(fd, buf, 0, length, this.offset);
        chunk = this.partial + this.decoder.write(buf.slice(0, read));
        this.offset += read;
      } finally {
        fs.closeSync(fd);
      }
    } catch (err) {
      debug(`[jsonl-tail] ${this.tag} pread failed (${(err as Error).message}), fallback`);
      try {
        const whole = fs.readFileSync(filePath, 'utf8');
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
        debug(`[jsonl-tail] ${this.tag} fallback failed: ${(err2 as Error).message}`);
        return null;
      }
    }
    const lastNl = chunk.lastIndexOf('\n');
    if (lastNl < 0) {
      this.partial = chunk;
      return '';
    }
    this.partial = chunk.slice(lastNl + 1);
    return chunk.slice(0, lastNl);
  }

  /** Mark the entire current file as already-consumed without parsing it.
   *  Used after a `readAll()` history snapshot so subsequent `read()` calls
   *  only return new content. */
  markConsumed(byteSize: number): void {
    this.offset = byteSize;
    this.partial = '';
    this.decoder = new StringDecoder('utf8');
  }

  /** Reset all tail state. Used when the underlying file path changes (e.g.
   *  Copilot agency-mode discovery flips the resolved transcript path). */
  resetForNewPath(): void {
    this.reset();
  }

  private reset(): void {
    this.offset = 0;
    this.partial = '';
    this.decoder = new StringDecoder('utf8');
  }
}
