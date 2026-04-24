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

export interface SessionInfo {
  id: string;
  shell: string;
  cwd: string;
  cols: number;
  rows: number;
  createdAt: number; // epoch ms
  alive: boolean;
  title: string;
  /** False until the PTY is spawned. Persisted-but-not-yet-attached sessions
   * created by a previous maestro process start out dormant. */
  attached: boolean;
  /** Claude's current state, derived from hook callbacks. */
  activity: SessionActivity;
}

export interface CreateSessionBody {
  cols?: number;
  rows?: number;
  title?: string;
  cwd?: string;
}

export type ClientMessage =
  | { type: 'attach'; cols: number; rows: number }
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number };

export type ServerMessage =
  | { type: 'attached'; session: SessionInfo; scrollback: string }
  | { type: 'output'; data: string }
  | { type: 'activity'; activity: SessionActivity }
  | { type: 'exit'; code: number | null }
  | { type: 'error'; message: string };
