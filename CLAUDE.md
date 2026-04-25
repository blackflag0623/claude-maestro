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

- **Session model** — each session's UUID **is** the `claude` CLI session id. New sessions spawn `claude --session-id <uuid>`; sessions revived from disk spawn `claude --resume <uuid>`. The shell is bypassed entirely (no PowerShell/bash wrapper).
- **Persistence on disk** — `~/.claude-maestro/sessions.json` (override via `MAESTRO_STORE_DIR`) holds `{id, title, cwd, createdAt, hasResumeData}` per session. On boot the server loads this file and registers each session as **dormant** (no PTY spawned). The PTY is spawned lazily when the first WS client attaches.
- **Per-process state** — `Map<id, Session>` carries the dormant metadata plus `term` (PTY handle, null when dormant), 256 KB scrollback ring, subscribers Set. Multiple WS subscribers can attach simultaneously.
- **Conversation continuity** — Claude itself writes the conversation to `~/.claude/projects/<cwd-slug>/<uuid>.jsonl`. That file is what `--resume` reads, so killing the maestro process (or the host) loses scrollback but **not** the conversation.
- **Auto-launch** — none needed: `claude` is the PTY's process, so there's no shell prompt to detect.
- **HTTP API** (CORS-permissive — assumes network-level trust):
  - `GET  /api/health` → `{ ok, sessions }`
  - `GET  /api/sessions` → `{ sessions: SessionInfo[] }`
  - `POST /api/sessions` body `CreateSessionBody` (`{cwd, title?, cols?, rows?}`) → `{ session }`. **`cwd` must be an existing directory on the maestro host** or the call returns 400.
  - `DELETE /api/sessions/:id` → `{ ok: true }`. Removes from the registry and persistence file. The Claude conversation file under `~/.claude/projects/...` is left intact.
- **WebSocket** — `GET /maestro-ws?sessionId=<id>` upgrades. Client sends `{type:'attach', cols, rows}`; if the session is dormant the server spawns `claude --resume <uuid>` here, then replies with `{type:'attached', session, scrollback}` (replays the in-memory ring), then streams live `{type:'output'}`.

### Client (`src/client/`)

- `state.ts` — localStorage-persisted `PersistedState`: `servers[]`, `activeNode`, `knownNodes` (map of serverId → NodeRef[]). Survives reload.
- `api.ts` — `MaestroApi` per server URL: `health/list/create/kill` over HTTP; `wsUrl(sessionId)` builds the matching `ws(s)://…/maestro-ws?sessionId=…`. Same-origin URLs go through Vite proxy in dev.
- `node.ts` — `TerminalNode` = one xterm `Terminal` + `FitAddon` + WS for one server-owned session. Stays mounted (DOM detach via `unmount()`, no dispose) so switching nodes preserves visual state. Auto-reconnects with exp backoff; on each (re)connect calls `term.reset()` then re-attaches and replays scrollback. Implements Ctrl/Cmd+V → `clipboard.readText` → input (xterm swallows it otherwise — see KNOWN_ISSUES).
- `main.ts` — orchestrator. Sidebar (servers + nodes tree), topbar (breadcrumb + status pulse), stage. First-run seeds a `local` server pointing at the current origin. Polls `/api/health`-via-`/api/sessions` every 10 s per server.

### Shared protocol (`src/shared/protocol.ts`)

- `SessionInfo`, `CreateSessionBody`, `ClientMessage` (`attach` | `input` | `resize`), `ServerMessage` (`attached` | `output` | `exit` | `error`).
- Server imports with `.js` extension (ESM) — keep that when adding shared modules.

### Persistence semantics

- **Sessions persist across maestro restart** via `~/.claude-maestro/sessions.json` (the registry) plus Claude's own `~/.claude/projects/<slug>/<uuid>.jsonl` (the conversation). After a maestro restart, sessions appear in the API as `attached: false` (dormant) until a client attaches and triggers `claude --resume <uuid>`.
- **Closing/reloading the browser does not affect sessions.** Removing a server from the portal does not kill its sessions.
- **Killing a node** (`DELETE /api/sessions/:id`) removes the session from the registry. The underlying Claude conversation file is left on disk for manual recovery via `claude --resume <uuid>` from a shell.
- **Scrollback (terminal pixels) is lost on maestro restart.** The conversation (Claude's history of messages and tool calls) is not.

## Conventions

- **Cross-platform is the default target.** macOS, Linux, and Windows must all work for every feature, new or evolving. No POSIX-only shell scripts (`#!/bin/sh`, `bash`, `curl`, `chmod`, `&` backgrounding); no Windows-only assumptions either. When a feature needs an out-of-process helper, write it as a Node script invoked via `process.execPath` so it runs anywhere claude-maestro itself runs. Quote paths with spaces. Use `path.join` / `path.sep`, never hardcoded `/`. If a platform genuinely cannot be supported, gate explicitly and document why — silent `if (platform === 'win32') return;` is a regression.
- ESM throughout (`"type": "module"`). Server TS imports of sibling files must use the `.js` extension; client TS does not (Vite resolver).
- Two tsconfigs: root `tsconfig.json` (`noEmit`, covers all of `src` for editor/typecheck) and `tsconfig.server.json` (emits server only, `rootDir: src`, includes `src/server` and `src/shared`). The client is built by Vite, not tsc.
- The server expects the built client at `../client` relative to its own output directory — preserve the `dist/server` + `dist/client` layout if changing the build.
- Aesthetic of the portal is intentional: brutalist control-room (bone background, hard 2 px black rules, JetBrains Mono + Fraunces, single acid-lime accent reserved for live state). Keep new UI inside this vocabulary unless changing the direction wholesale.
