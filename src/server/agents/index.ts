// Agent strategy registry.
//
// Each supported CLI agent (claude, copilot) provides a strategy module that
// answers three questions:
//   1. How do I spawn the agent's PTY?  (binary, args, env)
//   2. How do I get its conversation history + live updates?  (createReader)
//   3. Do I have a hook callback path that pokes activity / chat?  (handleHookEvent)
//
// The server (`index.ts`) calls strategies via this interface — it never
// branches on agent type itself. Adding a new agent type means dropping a
// strategy file here and registering it; no call-site changes elsewhere.

import type * as pty from '@lydell/node-pty';
import type {
  AgentType,
  ChatMessage,
  SessionActivity,
} from '../../shared/protocol.js';

export type SpawnMode = 'new' | 'resume';

/** The subset of session state a strategy needs to spawn / read for a
 *  session. The maestro session id (`id`) is always present; agent-specific
 *  fields below are populated only for agents that use them. The object is
 *  passed live (mutable) so a strategy can record a post-spawn discovery
 *  (e.g. Copilot agency mode) by writing back onto the same target. */
export interface SpawnTarget {
  id: string;
  cwd: string;
  cols: number;
  rows: number;
  /** For Copilot: the agent's own session uuid as recorded by the server, if
   *  known. Direct mode: equals `id` (the historical invariant). Agency mode:
   *  may be `undefined` on first spawn (will be discovered post-spawn) and is
   *  set to the agency-issued uuid on subsequent spawns. Ignored by non-
   *  Copilot agents. */
  copilotSessionId?: string;
  /** Called by the Copilot strategy after discovering an agency-issued uuid
   *  for a freshly-spawned agency session. The server persists this to
   *  `sessions.json` and updates the live session record. Strategies SHOULD
   *  also mutate `target.copilotSessionId` so downstream consumers (the
   *  reader) see the change immediately. No-op for non-Copilot agents. */
  onCopilotSessionId?: (id: string) => void;
}

/** Callbacks an `AgentReader` invokes when it observes new events. The server
 *  wires these to `setActivity()` and the chat broadcast respectively. */
export interface ReaderCallbacks {
  onActivity(activity: SessionActivity): void;
  onChatMessage(message: ChatMessage): void;
}

/** Per-session observer of an agent's on-disk transcript. Returned by
 *  `AgentStrategy.createReader`; the server creates it lazily on the first
 *  spawn or first chat-attach (whichever needs it) and disposes on session
 *  kill. */
export interface AgentReader {
  /** Snapshot of the entire transcript as chat messages, used to seed history
   *  on first chat-attach. Side effect: advances the reader's internal offset
   *  to end-of-file so subsequent live updates don't replay the snapshot. */
  readAll(): ChatMessage[];
  /** External signal that the underlying source likely has new content right
   *  now. Hook-driven readers (Claude) use this to trigger their poll; pure
   *  file-tailing readers (Copilot) ignore it because they're already
   *  watching. Always safe to call. */
  poke(): void;
  /** Stop timers / watchers. Idempotent. */
  dispose(): void;
}

/** What a hook event implies. The server applies these. */
export interface HookOutcome {
  /** Activity state to transition to, if recognized. */
  activity?: SessionActivity;
  /** Whether to poke the reader for new chat content (Claude on `Stop`). */
  flushChat?: boolean;
}

export interface AgentStrategy {
  readonly type: AgentType;

  /** Human-readable display name (shown in the new-node modal, the agent
   *  badges in sidebars, etc.). */
  readonly displayName: string;

  /** Spawn the agent process. The caller owns the returned IPty and wires
   *  `onData` / `onExit`. Throws on spawn failure with a clear message. */
  spawn(target: SpawnTarget, mode: SpawnMode): pty.IPty;

  /** Build a reader for this session. The reader is responsible for its own
   *  tailing strategy (file watcher, polling, etc.). Returns `null` if this
   *  agent has no machine-readable transcript at all (no agent type does
   *  today, but the option exists for terminal-only agents added later). */
  createReader(target: SpawnTarget, cb: ReaderCallbacks): AgentReader | null;

  /** Interpret an HTTP hook callback. Returns `null` if this agent has no
   *  hook system (e.g. Copilot — it derives state from events.jsonl
   *  directly). */
  handleHookEvent?(eventName: string, body: unknown): HookOutcome | null;
}

const STRATEGIES = new Map<AgentType, AgentStrategy>();

export function registerStrategy(s: AgentStrategy): void {
  STRATEGIES.set(s.type, s);
}

export function getStrategy(type: AgentType): AgentStrategy {
  const s = STRATEGIES.get(type);
  if (!s) throw new Error(`unknown agent type: ${type}`);
  return s;
}

export function listStrategies(): readonly AgentStrategy[] {
  return [...STRATEGIES.values()];
}
