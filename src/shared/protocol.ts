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

export type ClientMessage =
  | { type: 'attach'; cols: number; rows: number }
  | { type: 'attachChat'; cols: number; rows: number }
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number };

/** Structured chat message extracted from an agent's on-disk transcript.
 *  `assistant_text` = an assistant turn's rendered text content.
 *  `user_text`      = a user prompt's text content (history replay only — live
 *                     user inputs are rendered locally on send to avoid
 *                     double-displaying when the transcript flush echoes them
 *                     back). */
export type ChatMessage =
  | { type: 'assistant_text'; text: string; ts: number }
  | { type: 'user_text'; text: string; ts: number };

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
  | { type: 'chatAttached'; session: SessionInfo; history: ChatMessage[] }
  | { type: 'chatMessage'; message: ChatMessage }
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
