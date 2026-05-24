# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — runs server (`tsx watch` on `src/server/index.ts`, port 4050), Vite desktop client (port 4051), and Vite mobile client (port 4052) concurrently. Both Vite servers proxy `/api` and `/maestro-ws` to the backend.
- `npm run dev:server` / `npm run dev:client` / `npm run dev:client:mobile` — run one piece alone.
- `npm run build` — desktop `vite build` → `dist/client`, then mobile `vite build --config vite.mobile.config.ts` → `dist/client-mobile`, then `tsc -p tsconfig.server.json` → `dist/server`.
- `npm start` — runs the built server (`node dist/server/index.js`), which serves the desktop client at `/` and the mobile chat client at `/m` from the same port.

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
- **WebSocket** — `GET /maestro-ws?sessionId=<id>` upgrades. Two attach modes:
  - **Terminal**: client sends `{type:'attach', cols, rows}` → server replies `{type:'attached', session, scrollback}` then streams raw `{type:'output'}`. Multiple terminal subscribers per session are supported.
  - **Chat** (mobile): client sends `{type:'attachChat', cols, rows}`. **Exclusive** — rejected with `{type:'error', code:'chatLocked'}` if any other subscriber is already attached to this session. On success, server replies `{type:'chatAttached', session, history}` (history = scrollback re-parsed for NDJSON chat messages), then streams `{type:'chatMessage', message}` as Claude emits new NDJSON lines. Raw PTY output is suppressed for chat subscribers; terminal subscribers never see chat frames.

### Client (`src/client/`) — desktop terminal portal

- `state.ts` — localStorage-persisted `PersistedState`: `servers[]`, `activeNode`, `knownNodes` (map of serverId → NodeRef[]). Survives reload.
- `api.ts` — `MaestroApi` per server URL: `health/list/create/kill` over HTTP; `wsUrl(sessionId)` builds the matching `ws(s)://…/maestro-ws?sessionId=…`. Same-origin URLs go through Vite proxy in dev. **Reused verbatim by the mobile client.**
- `node.ts` — `TerminalNode` = one xterm `Terminal` + `FitAddon` + WS for one server-owned session. Stays mounted (DOM detach via `unmount()`, no dispose) so switching nodes preserves visual state. Auto-reconnects with exp backoff; on each (re)connect calls `term.reset()` then re-attaches and replays scrollback. Implements Ctrl/Cmd+V → `clipboard.readText` → input (xterm swallows it otherwise — see KNOWN_ISSUES).
- `main.ts` — orchestrator. Sidebar (servers + nodes tree), topbar (breadcrumb + status pulse), stage. First-run seeds a `local` server pointing at the current origin. Polls `/api/health`-via-`/api/sessions` every 10 s per server.

### Mobile client (`src/client-mobile/`) — chat UI

Phone-first browser UI served at `/m`. Renders Claude's output as chat bubbles (Telegram/WeChat-style) instead of a terminal. Built by `vite.mobile.config.ts` (separate Vite root + entry, output `dist/client-mobile`).

- `index.html` — single-page shell with viewport `viewport-fit=cover` for iOS safe-area handling.
- `main.ts` — tiny router across three screens: server picker → session picker → chat. No history-API integration (MVP: screen state is in memory only).
- `mobile-state.ts` — slim localStorage state (`maestro:mobile-state:v1`, separate from desktop), holding only `servers[]`. The current origin is always available as an implicit, non-removable "this device" entry.
- `server-picker.ts` — list of servers with health probe on tap; add/remove remote servers by base URL.
- `session-picker.ts` — list existing sessions (resume) and a "new session" form that calls `POST /api/sessions` with a `cwd`. No `fsList` browsing in MVP — user types the absolute path.
- `chat.ts` — opens WS with `attachChat`, renders history + live `chatMessage` frames as bubbles via `marked` (markdown rendered in safe defaults). User input is sent as `{type:'input', data: text+'\r'}` — same channel terminal clients use. Input box is **locked** while Claude is `working` (activity hook) or while we're awaiting the next `chatMessage`; **unlocked** on idle/waiting/exit-of-turn.
- `styles.css` — mobile-first, brutalist vocabulary preserved (bone background, 2px black rules, JetBrains Mono + Fraunces, acid-lime accent on the send button).

The desktop client is **not affected** by mobile traffic — chat messages are parsed from Claude's own JSONL transcript files, never from the PTY byte stream.

### Mobile chat data source — Claude's JSONL transcripts

Claude Code writes every conversation to `~/.claude/projects/<cwd-slug>/<uuid>.jsonl` (one JSON object per line: user messages, assistant messages, tool calls, snapshots). This is the same file `claude --resume <uuid>` reads. The maestro server **uses this file as the source of truth for chat bubbles** — it does not parse PTY output at all for the mobile UI.

- `src/server/transcript-reader.ts` derives the slug from the session's cwd (`E:\foo\bar` → `e--foo-bar` on Windows; trailing separators trimmed; `:` and `\`/`/` all become `-`), with a fallback that scans `~/.claude/projects/` for a matching JSONL filename if the slug rule changes in a future Claude version.
- On `attachChat`, the server creates a `TranscriptReader` (one per session, lazy), calls `readAll()` to extract historical assistant messages, and sends them as the `history` payload of `chatAttached`. Offset is set to end-of-file so subsequent reads only return new entries.
- On the existing `Stop` hook event (fired at the end of each assistant turn), the server calls `readIncremental()` and broadcasts any new `type:'assistant'` entries to chat subscribers as `chatMessage` frames.
- MVP extracts only `content[].type === 'text'` blocks; `tool_use` / thinking blocks are ignored. Adding them later is a matter of mapping more cases in `entryToChatMessage()`.

**Implications**: any repo works out of the box — no CLAUDE.md changes required in target repos to enable mobile chat. The chat UI sees exactly what `claude --resume` would replay.

### Shared protocol (`src/shared/protocol.ts`)

- `SessionInfo`, `CreateSessionBody`.
- `ClientMessage` = `attach` | `attachChat` | `input` | `resize`.
- `ServerMessage` = `attached` | `chatAttached` | `chatMessage` | `output` | `activity` | `exit` | `error` (`error` has optional `code: 'chatLocked'`).
- `ChatMessage` (MVP) = `{type:'assistant_text', text, ts}` — extensible discriminated union.
- Server imports with `.js` extension (ESM) — keep that when adding shared modules.

### Persistence semantics

- **Sessions persist across maestro restart** via `~/.claude-maestro/sessions.json` (the registry) plus Claude's own `~/.claude/projects/<slug>/<uuid>.jsonl` (the conversation). After a maestro restart, sessions appear in the API as `attached: false` (dormant) until a client attaches and triggers `claude --resume <uuid>`.
- **Closing/reloading the browser does not affect sessions.** Removing a server from the portal does not kill its sessions.
- **Killing a node** (`DELETE /api/sessions/:id`) removes the session from the registry. The underlying Claude conversation file is left on disk for manual recovery via `claude --resume <uuid>` from a shell.
- **Scrollback (terminal pixels) is lost on maestro restart.** The conversation (Claude's history of messages and tool calls) is not.

## Working style

- **Surface tradeoffs, don't pick silently.** If a request has multiple reasonable interpretations or a meaningfully simpler approach exists, name them in one or two sentences before implementing. State load-bearing assumptions explicitly.
- **Ask vs. proceed.** Reversible local changes (edits, refactors inside the scope of the request, restartable dev server): just do them. Architectural choices, anything touching persistence format / WS protocol / external surfaces, or work where you'd have to guess at intent: ask first.
- **Define what "done" looks like before you start non-trivial work.** This repo has no test/lint/typecheck scripts, so success usually means one of: `npm run build` passes, a concrete manual repro in the browser (state the steps), or a specific behavior observed in the PTY/WS traffic. "Make it work" is not a success criterion — name the check.
- **Report failures as failures.** If a change is partial, a build breaks, or a manual check wasn't run, say so plainly. Don't paper over with a confident summary.

## Conventions

- **Cross-platform is the default target.** macOS, Linux, and Windows must all work for every feature, new or evolving. No POSIX-only shell scripts (`#!/bin/sh`, `bash`, `curl`, `chmod`, `&` backgrounding); no Windows-only assumptions either. When a feature needs an out-of-process helper, write it as a Node script invoked via `process.execPath` so it runs anywhere claude-maestro itself runs. Quote paths with spaces. Use `path.join` / `path.sep`, never hardcoded `/`. If a platform genuinely cannot be supported, gate explicitly and document why — silent `if (platform === 'win32') return;` is a regression.
- ESM throughout (`"type": "module"`). Server TS imports of sibling files must use the `.js` extension; client TS does not (Vite resolver).
- Two tsconfigs: root `tsconfig.json` (`noEmit`, covers all of `src` for editor/typecheck) and `tsconfig.server.json` (emits server only, `rootDir: src`, includes `src/server` and `src/shared`). The client is built by Vite, not tsc.
- The server expects the built client at `../client` relative to its own output directory — preserve the `dist/server` + `dist/client` layout if changing the build.
- Aesthetic of the portal is intentional: brutalist control-room (bone background, hard 2 px black rules, JetBrains Mono + Fraunces, single acid-lime accent reserved for live state). Keep new UI inside this vocabulary unless changing the direction wholesale.
