import fs from 'node:fs';
import path from 'node:path';
import { ScrollbackBuffer } from './scrollback.js';

/** Per-session scrollback persistence to `<dir>/<id>.bin`. PTY bytes mirrored
 *  with ANSI preserved. Writes debounce; SIGINT/SIGTERM must flush sync via
 *  `flushAll()` — async I/O queued in a signal handler is lost. */
export class ScrollbackStore {
  private readonly dir: string;
  private readonly debounceMs: number;
  private readonly enabled: boolean;
  private readonly pending = new Map<string, NodeJS.Timeout>();

  constructor(opts: { dir: string; debounceMs: number; enabled: boolean }) {
    this.dir = opts.dir;
    this.debounceMs = opts.debounceMs;
    this.enabled = opts.enabled;
  }

  private pathFor(id: string): string {
    return path.join(this.dir, `${id}.bin`);
  }

  /** Read on boot into `buf`. No-op when disabled or file missing. */
  hydrate(id: string, buf: ScrollbackBuffer): void {
    if (!this.enabled) return;
    const p = this.pathFor(id);
    try {
      if (!fs.existsSync(p)) return;
      buf.hydrate(fs.readFileSync(p, 'utf8'));
    } catch (err) {
      // Corrupt / unreadable file shouldn't block boot — just log and move on.
      console.warn(`[maestro] failed to read scrollback for ${id}:`, (err as Error).message);
    }
  }

  /** Schedule a debounced flush; subsequent calls within the window collapse. */
  schedule(id: string, read: () => string): void {
    if (!this.enabled) return;
    const existing = this.pending.get(id);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      this.pending.delete(id);
      this.flushOne(id, read());
    }, this.debounceMs);
    // Don't keep the process alive on debounce alone — exit handlers flush sync.
    t.unref();
    this.pending.set(id, t);
  }

  /** Drop the file and any pending flush for a killed session. */
  remove(id: string): void {
    const pending = this.pending.get(id);
    if (pending) {
      clearTimeout(pending);
      this.pending.delete(id);
    }
    if (!this.enabled) return;
    try {
      fs.unlinkSync(this.pathFor(id));
    } catch {
      // File may not exist (session created and killed before any flush).
    }
  }

  /** Synchronously flush every pending session. Called from SIGINT/SIGTERM. */
  flushAll(reads: Map<string, () => string>): void {
    if (!this.enabled) return;
    for (const [id, timer] of this.pending) {
      clearTimeout(timer);
      const read = reads.get(id);
      if (read) this.flushOne(id, read());
    }
    this.pending.clear();
  }

  private flushOne(id: string, data: string): void {
    const dst = this.pathFor(id);
    const tmp = `${dst}.tmp`;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(tmp, data, 'utf8');
      fs.renameSync(tmp, dst);
    } catch (err) {
      console.warn(`[maestro] failed to flush scrollback for ${id}:`, (err as Error).message);
      try {
        fs.unlinkSync(tmp);
      } catch {}
    }
  }
}
