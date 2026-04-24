# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — runs server (`tsx watch` on `src/server/index.ts`, port 4050) and Vite client (port 4051) concurrently. Use this for development; the Vite dev server proxies `/maestro-ws` to the backend.
- `npm run dev:server` / `npm run dev:client` — run either side alone.
- `npm run build` — `vite build` (client → `dist/client`) then `tsc -p tsconfig.server.json` (server → `dist/server`).
- `npm start` — runs the built server (`node dist/server/index.js`), which also serves the built client as static files from the same port.

No test, lint, or typecheck scripts are configured.

## Known issues

See `KNOWN_ISSUES.md` for upstream quirks and platform restrictions (e.g. xterm.js swallows Ctrl+V). Check it before debugging puzzling behavior, and add new entries when you discover one.

## Architecture

A thin browser-hosted terminal that auto-launches the `claude` CLI inside a PTY on the server.

- **Server (`src/server/index.ts`)** — Express + `ws` `WebSocketServer` on path `/maestro-ws`, sharing one HTTP server. Each WS connection spawns a `@lydell/node-pty` process: `powershell.exe` on Windows, `$SHELL` (or `/bin/bash`) elsewhere. After detecting a shell prompt via regex (`/(?:[>$#]\s)$/` against ANSI-stripped output buffer), the server writes `claude\r` into the PTY to auto-launch Claude Code. A 5s timeout fires the same launch if no prompt is detected. PTY output → `{type:'output'}` WS messages; client `input`/`resize` messages drive `term.write` / `term.resize`.
- **Client (`src/client/main.ts`)** — xterm.js Terminal + FitAddon. Connects to `/maestro-ws` (relative URL — works in dev via Vite proxy and in prod where Express serves the built client on the same port). Auto-reconnects with exponential backoff up to 5s.
- **Shared protocol (`src/shared/protocol.ts`)** — `ClientMessage` (`input` | `resize`) and `ServerMessage` (`output` | `exit`) discriminated unions. Server imports with `.js` extension (ESM) — keep that when adding shared modules.

## Conventions

- ESM throughout (`"type": "module"`). Server TS imports of sibling files must use the `.js` extension; client TS does not (Vite resolver).
- Two tsconfigs: root `tsconfig.json` (`noEmit`, covers all of `src` for editor/typecheck) and `tsconfig.server.json` (emits server only, `rootDir: src`, includes `src/server` and `src/shared`). The client is built by Vite, not tsc.
- The server expects the built client at `../client` relative to its own output directory — preserve the `dist/server` + `dist/client` layout if changing the build.
