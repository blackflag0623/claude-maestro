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

export interface SessionInfo {
  id: string;
  shell: string;
  cols: number;
  rows: number;
  createdAt: number; // epoch ms
  alive: boolean;
  title: string;
}

export interface CreateSessionBody {
  cols?: number;
  rows?: number;
  title?: string;
}

export type ClientMessage =
  | { type: 'attach'; cols: number; rows: number }
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number };

export type ServerMessage =
  | { type: 'attached'; session: SessionInfo; scrollback: string }
  | { type: 'output'; data: string }
  | { type: 'exit'; code: number | null }
  | { type: 'error'; message: string };
