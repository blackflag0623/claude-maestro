import crypto from 'node:crypto';
import type { WebSocket } from 'ws';
import type {
  ChatMessage,
  ChatMode,
  ServerMessage,
  ToolCallStatus,
} from '../shared/protocol.js';
import { ASK_UQ_ANSWER_PREFIX } from '../shared/protocol.js';
import {
  requestVerdict,
  type ToolVerdict,
} from './hook-pending.js';
import type { BubbleStore } from './bubble-store.js';
import { debug } from './debug.js';

/** Minimum-shape `Session` view this module needs. Avoids importing the full
 *  Session struct so chat-gating stays decoupled from session lifecycle. */
export interface GatingSession {
  readonly id: string;
  readonly chatSubscribers: Set<WebSocket>;
  readonly syntheticBubbles: Map<string, ChatMessage>;
}

/** Mobile-chat tool-gating runtime.
 *
 *  Owns:
 *   - the per-WS chat-mode WeakMap (auto / pause-next / always-pause)
 *   - the PreToolUse handler that fabricates pending bubbles and awaits verdicts
 *   - the broadcastToolCall path that persists + replays synthetic bubbles
 *
 *  AskUserQuestion is always intercepted when a chat client is present (even
 *  in auto mode) so the desktop TUI menu can't race the phone answer.
 */
export class ChatGating {
  /** WebSocket → mode. WeakMap so socket GC auto-cleans on disconnect. */
  private readonly modes = new WeakMap<WebSocket, ChatMode>();
  private readonly bubbleStore: BubbleStore;
  private readonly broadcastChat: (s: GatingSession, msg: ServerMessage) => void;
  private readonly verdictTimeoutMs: number;

  constructor(opts: {
    bubbleStore: BubbleStore;
    broadcastChat: (s: GatingSession, msg: ServerMessage) => void;
    verdictTimeoutMs?: number;
  }) {
    this.bubbleStore = opts.bubbleStore;
    this.broadcastChat = opts.broadcastChat;
    this.verdictTimeoutMs = opts.verdictTimeoutMs ?? 55_000;
  }

  getMode(ws: WebSocket): ChatMode {
    return this.modes.get(ws) ?? 'auto';
  }

  setMode(ws: WebSocket, m: ChatMode): void {
    this.modes.set(ws, m);
  }

  /** Strictest mode across all chat subscribers. With exclusive attach this is
   *  just the one subscriber's mode, but the API stays correct under future
   *  multi-subscriber relaxation. */
  effectiveMode(s: GatingSession): ChatMode {
    let best: ChatMode = 'auto';
    for (const ws of s.chatSubscribers) {
      const m = this.getMode(ws);
      if (m === 'always-pause') return 'always-pause';
      if (m === 'pause-next') best = 'pause-next';
    }
    return best;
  }

  /** pause-next is one-shot. Reverts every subscriber from pause-next → auto
   *  and echoes a `chatMode` frame so their UI keeps in sync. */
  consumePauseNext(s: GatingSession): void {
    for (const ws of s.chatSubscribers) {
      if (this.getMode(ws) === 'pause-next') {
        this.setMode(ws, 'auto');
        const echo: ServerMessage = { type: 'chatMode', mode: 'auto' };
        try { ws.send(JSON.stringify(echo)); } catch {}
      }
    }
  }

  /** Fabricate a tool_call bubble: persist + broadcast + remember in the
   *  session's synthetic-bubble Map so a reconnecting chat client replays it. */
  broadcastToolCall(s: GatingSession, m: Extract<ChatMessage, { type: 'tool_call' }>): void {
    this.bubbleStore.append(s.id, s.syntheticBubbles, m);
    this.broadcastChat(s, { type: 'chatMessage', message: m });
  }

  /** Handle a PreToolUse hook body. Always resolves with a verdict the hook
   *  script can serialize as `permissionDecision: 'allow' | 'deny'`. */
  async handlePreToolUse(s: GatingSession, body: Record<string, unknown>): Promise<ToolVerdict> {
    const toolName = String(body.tool_name ?? 'unknown');
    const toolInput = body.tool_input ?? {};
    const toolCallId =
      (body.tool_use_id as string | undefined) ?? crypto.randomUUID();
    const ts = Date.now();
    const mode = this.effectiveMode(s);

    // AskUserQuestion: always intercept when a chat client is attached, even
    // in auto mode — otherwise the desktop TUI menu grabs the answer and the
    // phone sees a spurious result. Without a chat subscriber, fall through
    // to allow so the desktop TUI handles it normally.
    const isAskUQ = toolName === 'AskUserQuestion';
    const forcePause = isAskUQ && s.chatSubscribers.size > 0;

    if (mode === 'auto' && !forcePause) {
      this.broadcastToolCall(s, {
        type: 'tool_call',
        toolCallId,
        toolName,
        toolInput,
        status: 'allowed',
        ts,
      });
      return { decision: 'allow' };
    }

    this.broadcastToolCall(s, {
      type: 'tool_call',
      toolCallId,
      toolName,
      toolInput,
      status: 'pending',
      ts,
    });
    debug(`[hook] PreToolUse ${s.id.slice(0, 8)} ${toolName} — awaiting verdict (mode=${mode}${forcePause ? ', force-pause' : ''})`);
    const verdict = await requestVerdict(s.id, toolCallId, this.verdictTimeoutMs);
    debug(`[hook] PreToolUse ${s.id.slice(0, 8)} ${toolName} → ${verdict.decision}${verdict.timedOut ? ' (timeout)' : ''}`);

    // AskUserQuestion bridge: convert any verdict to deny+reason so Claude
    // reads it as user feedback. On timeout, deny with a "no answer" reason
    // so Claude moves on rather than auto-allowing into a broken TUI flow.
    let effectiveVerdict: ToolVerdict = verdict;
    if (isAskUQ) {
      effectiveVerdict = {
        decision: 'deny',
        reason: verdict.reason ?? (verdict.timedOut ? 'no answer from mobile user' : 'no selection'),
        timedOut: verdict.timedOut,
      };
    }

    let status: ToolCallStatus;
    let displayReason = effectiveVerdict.reason;
    if (isAskUQ) {
      if (effectiveVerdict.timedOut) {
        status = 'timedout';
      } else {
        status = 'answered';
        if (displayReason && displayReason.startsWith(ASK_UQ_ANSWER_PREFIX)) {
          displayReason = displayReason.slice(ASK_UQ_ANSWER_PREFIX.length);
        }
      }
    } else {
      status = effectiveVerdict.timedOut
        ? 'timedout'
        : effectiveVerdict.decision === 'deny'
          ? 'denied'
          : 'allowed';
    }
    this.broadcastToolCall(s, {
      type: 'tool_call',
      toolCallId,
      toolName,
      toolInput,
      status,
      denyReason: displayReason,
      ts: Date.now(),
    });

    // pause-next is one-shot. AskUQ doesn't consume it (the pause was forced
    // for this tool regardless of mode).
    if (!isAskUQ) this.consumePauseNext(s);

    return effectiveVerdict;
  }
}
