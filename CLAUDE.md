# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — runs server (`tsx watch` on `src/server/index.ts`, port 4050) and Vite client (port 4051) concurrently. Vite proxies `/api` and `/maestro-ws` to the backend.
- `npm run dev:server` / `npm run dev:client` — run either side alone.
- `npm run build` — `vite build` (client → `dist/client`) then `tsc -p tsconfig.server.json` (server → `dist/server`).
- `npm start` — runs the built server (`node dist/server/index.js`), which also serves the built client as static files from the same port.

No test, lint, or typecheck scripts are configured.

## Known issues

See `KNOWN_ISSUES.md` for upstream quirks and platform restrictions. Check it before debugging puzzling behavior, and add new entries when you discover one.

## Architecture

A browser portal that manages multiple `claude-maestro` backends, each hosting 1..N persistent `claude` CLI sessions inside PTYs.

### Server (`src/server/index.ts`)

Express + `ws` `WebSocketServer` (manual `noServer:true` upgrade, gated by `?sessionId=`), sharing one HTTP listener.

- **Session registry** — `sessions: Map<id, Session>`. Each `Session` owns one `@lydell/node-pty` process plus a 256 KB scrollback ring buffer (raw bytes including ANSI). Sessions persist across WS disconnects; multiple WS subscribers can attach to the same session simultaneously and all receive output.
- **Auto-launch claude** — per session, after detecting a shell prompt via `/(?:[>$#]\s)$/` against ANSI-stripped output (or 5 s fallback), the server writes `claude\r` into the PTY.
- **HTTP API** (CORS-permissive — assumes network-level trust):
  - `GET  /api/health` → `{ ok, sessions }`
  - `GET  /api/sessions` → `{ sessions: SessionInfo[] }`
  - `POST /api/sessions` body `CreateSessionBody` → `{ session }`
  - `DELETE /api/sessions/:id` → `{ ok: true }`
- **WebSocket** — `GET /maestro-ws?sessionId=<id>` upgrades. Client must send `{type:'attach', cols, rows}` first; server replies with `{type:'attached', session, scrollback}` (replays full ring buffer) then streams live `{type:'output'}` messages. If the PTY has already exited, an `{type:'exit'}` is sent right after `attached`.

### Client (`src/client/`)

- `state.ts` — localStorage-persisted `PersistedState`: `servers[]`, `activeNode`, `knownNodes` (map of serverId → NodeRef[]). Survives reload.
- `api.ts` — `MaestroApi` per server URL: `health/list/create/kill` over HTTP; `wsUrl(sessionId)` builds the matching `ws(s)://…/maestro-ws?sessionId=…`. Same-origin URLs go through Vite proxy in dev.
- `node.ts` — `TerminalNode` = one xterm `Terminal` + `FitAddon` + WS for one server-owned session. Stays mounted (DOM detach via `unmount()`, no dispose) so switching nodes preserves visual state. Auto-reconnects with exp backoff; on each (re)connect calls `term.reset()` then re-attaches and replays scrollback. Implements Ctrl/Cmd+V → `clipboard.readText` → input (xterm swallows it otherwise — see KNOWN_ISSUES).
- `main.ts` — orchestrator. Sidebar (servers + nodes tree), topbar (breadcrumb + status pulse), stage. First-run seeds a `local` server pointing at the current origin. Polls `/api/health`-via-`/api/sessions` every 10 s per server.

### Shared protocol (`src/shared/protocol.ts`)

- `SessionInfo`, `CreateSessionBody`, `ClientMessage` (`attach` | `input` | `resize`), `ServerMessage` (`attached` | `output` | `exit` | `error`).
- Server imports with `.js` extension (ESM) — keep that when adding shared modules.

### Persistence semantics

- **Sessions live on the server.** Closing/reloading the browser does not kill them. Removing a server from the portal does not kill its sessions.
- **Killing a node** (`DELETE /api/sessions/:id`) is destructive — the PTY and child `claude` process die.
- **Scrollback is bounded to 256 KB per session** in memory only; restarting the maestro server loses all sessions.

## Conventions

- ESM throughout (`"type": "module"`). Server TS imports of sibling files must use the `.js` extension; client TS does not (Vite resolver).
- Two tsconfigs: root `tsconfig.json` (`noEmit`, covers all of `src` for editor/typecheck) and `tsconfig.server.json` (emits server only, `rootDir: src`, includes `src/server` and `src/shared`). The client is built by Vite, not tsc.
- The server expects the built client at `../client` relative to its own output directory — preserve the `dist/server` + `dist/client` layout if changing the build.
- Aesthetic of the portal is intentional: brutalist control-room (bone background, hard 2 px black rules, JetBrains Mono + Fraunces, single acid-lime accent reserved for live state). Keep new UI inside this vocabulary unless changing the direction wholesale.
