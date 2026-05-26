// Wire protocol shared between client and server.
//
// HTTP REST endpoints (JSON):
//   GET    /api/sessions              -> { sessions: SessionInfo[] }
//   POST   /api/sessions              -> { session: SessionInfo }     body: CreateSessionBody
//   DELETE /api/sessions/:id          -> { ok: true }
//
// WebSocket endpoint:
//   GET /maestro-ws?sessionId=<id>    upgrades; client must send {type:'attach'}
//                                     before any input. On attach the server replays
//                                     the scrollback buffer, then streams live output.

export type SessionActivity = 'unknown' | 'working' | 'waiting' | 'idle';

/** Which CLI agent backs a session. The server picks the spawn binary, args,
 *  and (if available) the activity/transcript reader from a per-agent strategy
 *  module. Adding a new agent means adding a strategy file; no call sites in
 *  index.ts need to change. */
export type AgentType = 'claude' | 'copilot';

export const AGENT_TYPES: readonly AgentType[] = ['claude', 'copilot'];

export interface SessionInfo {
  id: string;
  cwd: string;
  cols: number;
  rows: number;
  createdAt: number; // epoch ms
  alive: boolean;
  title: string;
  /** False until the PTY is spawned. Persisted-but-not-yet-attached sessions
   * created by a previous maestro process start out dormant. */
  attached: boolean;
  /** Current activity state. For claude this is driven by hook callbacks;
   *  for copilot it is derived from tailing the agent's events.jsonl. */
  activity: SessionActivity;
  /** Which agent CLI backs this session. Defaults to `'claude'` for
   *  sessions persisted before the agent abstraction was introduced. */
  agentType: AgentType;
}

export interface CreateSessionBody {
  cols?: number;
  rows?: number;
  title?: string;
  cwd?: string;
  /** Optional agent type; defaults to `'claude'` on the server when omitted. */
  agentType?: AgentType;
}

export type ChatMode = 'auto' | 'pause-next' | 'always-pause';

export type ClientMessage =
  | { type: 'attach'; cols: number; rows: number }
  | { type: 'attachChat'; cols: number; rows: number }
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'setChatMode'; mode: ChatMode }
  | { type: 'toolDecision'; toolCallId: string; decision: 'allow' | 'deny'; reason?: string };

/** Status lifecycle for a `tool_call` bubble. `pending` is shown while the
 *  phone is awaiting Allow/Deny; resolves to `allowed` / `denied` / `timedout`.
 *  `answered` is the AskUserQuestion bridge's terminal state. */
export type ToolCallStatus = 'pending' | 'allowed' | 'denied' | 'timedout' | 'answered';

/** Prefix used when the mobile client translates an AskUserQuestion answer
 *  into a `toolDecision` reason. The server strips this prefix before
 *  rendering the bubble's clean "answer" view but forwards the full
 *  prefixed string to Claude as `permissionDecisionReason`, so Claude reads
 *  it as user feedback. Both ends must use the exact same string. */
export const ASK_UQ_ANSWER_PREFIX = 'User answered AskUserQuestion — ';

/** Structured chat message extracted from an agent's on-disk transcript or
 *  fabricated by the server.
 *  `assistant_text` / `user_text` come from the transcript file.
 *  `tool_call`      = synthetic bubble for a Claude tool invocation. Status
 *                     starts as `pending` when paused waiting for the phone;
 *                     flips to `allowed`/`denied`/`timedout`/`answered`. In
 *                     auto mode, the bubble is emitted as `allowed` directly. */
export type ChatMessage =
  | { type: 'assistant_text'; text: string; ts: number }
  | { type: 'user_text'; text: string; ts: number }
  | {
      type: 'tool_call';
      toolCallId: string;
      toolName: string;
      toolInput: unknown;
      status: ToolCallStatus;
      denyReason?: string;
      ts: number;
    };

export interface FsListEntry {
  name: string;
  kind: 'dir' | 'file' | 'other';
  size?: number;
  mtime?: number;
}

export interface FsListResponse {
  cwd: string;
  path: string; // relative to cwd; '' = root
  abs: string;
  entries: FsListEntry[];
}

export type FsReadResponse =
  | { binary: false; size: number; mtime: number; content: string; abs: string }
  | { binary: true; size: number; abs: string };

export type ServerMessage =
  | { type: 'attached'; session: SessionInfo; scrollback: string }
  | { type: 'chatAttached'; session: SessionInfo; history: ChatMessage[]; mode: ChatMode }
  | { type: 'chatMessage'; message: ChatMessage }
  | { type: 'chatMode'; mode: ChatMode }
  | { type: 'output'; data: string }
  | { type: 'activity'; activity: SessionActivity }
  | { type: 'exit'; code: number | null }
  | {
      type: 'error';
      message: string;
      /** Discriminator for known, programmatically-handled error states.
       *   - `chatLocked`        — another client already holds the chat
       *                           channel for this session (exclusive).
       *   - `chatNotSupported`  — this agent has no chat reader (e.g. an
       *                           agent type added later that only does
       *                           terminal). Clients should hide / disable
       *                           the chat UI rather than retry. */
      code?: 'chatLocked' | 'chatNotSupported';
    };
