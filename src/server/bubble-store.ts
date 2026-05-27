import fs from 'node:fs';
import path from 'node:path';
import type { ChatMessage } from '../shared/protocol.js';

const MAX_BUBBLES_PER_SESSION = 500;

/** Per-session append-only JSONL store for synthetic chat bubbles (tool_call
 *  status frames). Collapsed by toolCallId on load — latest status wins.
 *
 *  Pairs with an in-memory `Map<toolCallId, ChatMessage>` per session that
 *  the server holds so a reconnecting chat client can replay bubbles in
 *  chronological order alongside JSONL transcript history. */
export class BubbleStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private pathFor(sessionId: string): string {
    return path.join(this.dir, `${sessionId}.jsonl`);
  }

  /** Load the on-disk JSONL into a Map keyed by toolCallId (latest wins). */
  load(sessionId: string): Map<string, ChatMessage> {
    const out = new Map<string, ChatMessage>();
    const p = this.pathFor(sessionId);
    if (!fs.existsSync(p)) return out;
    let raw: string;
    try {
      raw = fs.readFileSync(p, 'utf8');
    } catch {
      return out;
    }
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: ChatMessage;
      try {
        parsed = JSON.parse(trimmed) as ChatMessage;
      } catch {
        continue;
      }
      if (parsed && parsed.type === 'tool_call') {
        out.set(parsed.toolCallId, parsed);
      }
    }
    return out;
  }

  /** Append a bubble to the session's JSONL and update its in-memory Map.
   *  Caps the Map at MAX_BUBBLES_PER_SESSION by evicting the oldest entry. */
  append(sessionId: string, bubbles: Map<string, ChatMessage>, m: ChatMessage): void {
    if (m.type !== 'tool_call') return;
    bubbles.set(m.toolCallId, m);
    if (bubbles.size > MAX_BUBBLES_PER_SESSION) {
      const firstKey = bubbles.keys().next().value as string | undefined;
      if (firstKey !== undefined) bubbles.delete(firstKey);
    }
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.appendFileSync(this.pathFor(sessionId), JSON.stringify(m) + '\n');
    } catch (err) {
      console.error('[maestro] bubble persist failed:', (err as Error).message);
    }
  }

  /** Drop the session's bubble file. Called from killSession. */
  remove(sessionId: string): void {
    try {
      fs.rmSync(this.pathFor(sessionId), { force: true });
    } catch {}
  }
}
