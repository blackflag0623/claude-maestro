# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — runs server (`tsx watch` on `src/server/index.ts`, port 4050), Vite desktop client (port 4051), and Vite mobile client (port 4052) concurrently. Both Vite servers proxy `/api` and `/maestro-ws` to the backend.
- `npm run dev:server` / `npm run dev:client` / `npm run dev:client:mobile` — run one piece alone.
- `npm run build` — desktop `vite build` → `dist/client`, then mobile `vite build --config vite.mobile.config.ts` → `dist/client-mobile`, then `tsc -p tsconfig.server.json` → `dist/server`.
- `npm start` — runs the built server (`node dist/server/index.js`), which serves the desktop client at `/` and the mobile chat client at `/m` from the same port.

No test, lint, or typecheck scripts are configured.

## Debug logging

The server emits routine operational logs (hook events, transcript flushes,
session-restore counts) only when `MAESTRO_DEBUG` is set. Failures
(`console.error`) and the startup banner are always emitted.

```bash
MAESTRO_DEBUG=1 npm run dev:server
```

The browser clients have the same convention: set `localStorage.MAESTRO_DEBUG = '1'`
in DevTools and reload to see chat-bubble lifecycle logs.

## WebSocket liveness

The server sends a WS ping every 25 s; sockets that miss two consecutive
pongs are terminated. This is what frees `chatLocked` sessions when a chat
client crashes, backgrounds for too long, or loses the network (the
underlying TCP can otherwise hold the connection half-open for many
minutes). When tweaking, keep the interval well under any deployed reverse
proxy's idle timeout.

## Security headers

A Content-Security-Policy is sent on non-`/api/` responses (the static
clients). It blocks inline `<script>`, frame-embedding, and untrusted
external script sources — only `'self'` and `cdn.jsdelivr.net` (marked +
DOMPurify) are allowed. `style-src` keeps `'unsafe-inline'` because both
clients use inline `style="--var:…"` for dynamic CSS variables. `connect-src`
is permissive (`ws:` `wss:` `http:` `https:`) because the portal connects
to user-configured remote maestro servers at arbitrary origins.

`X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer` are
sent on every response. `X-Frame-Options: DENY` is sent on static pages
only (the API doesn't need it, since `frame-ancestors 'none'` in CSP
handles framing for browsers that support it).

## Known issues

See `KNOWN_ISSUES.md` for upstream quirks and platform restrictions. Check it before debugging puzzling behavior, and add new entries when you discover one.

## Architecture

A browser portal that manages multiple `claude-maestro` backends, each hosting 1..N persistent CLI sessions inside PTYs. Each session is backed by exactly one **agent** — currently `claude` (Claude Code) or `copilot` (GitHub Copilot CLI). Agent choice is per-session, not per-server, so both can coexist on one devbox.

### Server (`src/server/index.ts`)

Express + `ws` `WebSocketServer` (manual `noServer:true` upgrade, gated by `?sessionId=`), sharing one HTTP listener.

- **Session model** — each session's UUID **is** the agent CLI's session id. New sessions spawn the configured binary with the agent's "new session" flag (`claude --session-id <uuid>` or `copilot --session-id <uuid>`); sessions revived from disk spawn the resume flag (`--resume <uuid>`). The shell is bypassed entirely (no PowerShell/bash wrapper). Per-session spawn is dispatched through the agent strategy registry — see "Agent abstraction" below.
- **Persistence on disk** — `~/.claude-maestro/sessions.json` (override via `MAESTRO_STORE_DIR`) holds `{id, title, cwd, agentType, createdAt, hasResumeData}` per session. On boot the server loads this file and registers each session as **dormant** (no PTY spawned). The PTY is spawned lazily when the first WS client attaches. Entries missing `agentType` (pre-migration) default to `'claude'`; entries with unknown values are quarantined with a warning and skipped.
- **Per-process state** — `Map<id, Session>` carries the dormant metadata plus `term` (PTY handle, null when dormant), 256 KB scrollback ring, subscribers Set, and `reader` (an `AgentReader`, lazily created when the PTY spawns, disposed 1.5 s after PTY exit). Multiple WS subscribers can attach simultaneously.
- **Conversation continuity** — each agent CLI writes its own transcript file (Claude → `~/.claude/projects/<slug>/<uuid>.jsonl`, Copilot → `~/.copilot/session-state/<uuid>/events.jsonl`). `--resume` reads that file, so killing the maestro process (or the host) loses scrollback but **not** the conversation.
- **Auto-launch** — none needed: the agent CLI is the PTY's process, so there's no shell prompt to detect.
- **HTTP API** (CORS-permissive — assumes network-level trust):
  - `GET  /api/health` → `{ ok, sessions }`
  - `GET  /api/sessions` → `{ sessions: SessionInfo[] }` (each entry includes `agentType`)
  - `POST /api/sessions` body `CreateSessionBody` (`{cwd, title?, agentType?, cols?, rows?}`, `agentType` defaults to `'claude'`) → `{ session }`. **`cwd` must be an existing directory on the maestro host** or the call returns 400. An invalid `agentType` is rejected with 400.
  - `DELETE /api/sessions/:id` → `{ ok: true }`. Removes from the registry and persistence file. The agent's transcript file is left intact.
- **WebSocket** — `GET /maestro-ws?sessionId=<id>` upgrades. Two attach modes:
  - **Terminal**: client sends `{type:'attach', cols, rows}` → server replies `{type:'attached', session, scrollback}` then streams raw `{type:'output'}`. Multiple terminal subscribers per session are supported.
  - **Chat** (mobile): client sends `{type:'attachChat', cols, rows}`. **Exclusive** — rejected with `{type:'error', code:'chatLocked'}` if any other subscriber is already attached. Rejected with `{type:'error', code:'chatNotSupported'}` if the agent strategy did not produce a reader (e.g. transcript missing). On success, server replies `{type:'chatAttached', session, history}` (history comes from `reader.readAll()`), then streams `{type:'chatMessage', message}` as the agent emits new transcript entries. Raw PTY output is suppressed for chat subscribers; terminal subscribers never see chat frames.

### Agent abstraction (`src/server/agents/`)

The server is agnostic to which CLI backs a session. All agent-specific concerns sit behind the `AgentStrategy` interface in `agents/index.ts`:

- `spawn(target, mode)` — return a `pty.IPty` configured to launch the CLI in `target.cwd`. Strategies may force `--resume` defensively (e.g. Copilot when `events.jsonl` already exists for the uuid, even if the registry says `mode === 'new'`).
- `createReader(target, callbacks)` — return an `AgentReader { readAll(): ChatMessage[]; poke(): void; dispose(): void }`. Readers emit live `ChatMessage` and activity transitions through the supplied callbacks. Returning `null` means "no chat support for this agent" → mobile clients get `chatNotSupported`.
- `handleHookEvent?(event, body)` — optional. Maps a maestro `/api/hook` POST into a `HookOutcome { activity?, flushChat? }`. Only Claude uses this today (PreToolUse/PostToolUse/Stop/Notification mapping → activity transitions + transcript-tail poke). Copilot returns `null` because activity is derived from polling `events.jsonl` directly.

Strategies are registered as side-effects of importing `agents/all.ts`, which also exports `initAgentEnvironments()` (called once at startup to write Claude's hook scripts / settings).

**Binary configuration env vars (set on the maestro host):**

| Var | Default | Whitespace-split? | Purpose |
| --- | --- | --- | --- |
| `MAESTRO_CLAUDE_BIN` | `claude` | no | Path to the Claude binary (supports spaces). |
| `MAESTRO_COPILOT_BIN` | `copilot` | no | Path to the Copilot binary (supports spaces). On Microsoft devboxes, point this at `agency` and **also** set `MAESTRO_COPILOT_PREFIX_ARGS=copilot` to launch via `agency copilot` (see "Copilot launch modes" below). |
| `MAESTRO_COPILOT_PREFIX_ARGS` | _(unset)_ | yes | Optional args inserted between the binary and the session flag. In direct mode, leave unset. In agency mode, set to `copilot` (the subcommand `agency` dispatches to). |
| `MAESTRO_COPILOT_AGENCY` | _(unset)_ | no | Set to `1` to force agency launch mode regardless of `MAESTRO_COPILOT_BIN` basename. Useful when `MAESTRO_COPILOT_BIN` is an absolute path or wrapper whose basename isn't `agency`. |
| `MAESTRO_STORE_DIR` | `~/.claude-maestro` | no | Override the registry directory. |

**Copilot launch modes:**

The Copilot strategy supports two launch modes, detected at maestro startup:

- **`direct`** (default) — maestro owns the session uuid and passes it as `--session-id=<uuid>` for new sessions, `--resume=<uuid>` for resume. Used when `MAESTRO_COPILOT_BIN` points directly at `copilot` (or `copilot.exe`, `copilot.cmd`, …).
- **`agency`** — for Microsoft devboxes where Copilot must be launched through the `agency` wrapper (auth, env, sandbox). Agency injects its own `--session-id` for new sessions, so maestro must NOT pass one. Maestro discovers the agency-issued uuid post-spawn by snapshotting `~/.copilot/session-state/` before the spawn and watching for the newly created dir (10 s timeout, 200 ms poll, birthtime/ctime-filtered, fails closed on zero/multiple matches). The discovered uuid is persisted as `copilotSessionId`. For resume, maestro issues `agency copilot --resume=<copilotSessionId>` — verified to forward through `agency` to `copilot`.

Mode detection priority: `MAESTRO_COPILOT_AGENCY=1` (explicit override) > `path.basename(MAESTRO_COPILOT_BIN).toLowerCase()` is `agency` or starts with `agency.` (catches `agency.exe`, `agency.cmd`) > `direct`.

Each Copilot session records its launch mode at create time (`copilotLaunchMode` in `sessions.json`). If maestro restarts in a different mode, spawn fails closed with a clear error rather than silently starting a fresh session and losing conversation history. To switch modes for an existing session, restart maestro with the original env vars, or delete the session and create a new one.

**Copilot events.jsonl mapping** (`agents/copilot.ts`):

Copilot CLI writes one JSON event per line to `~/.copilot/session-state/<uuid>/events.jsonl`. The Copilot reader tails this file with a 400 ms `pread + StringDecoder` poll (same pattern as the Claude transcript reader) and maps event types to chat bubbles / activity:

- Chat content — `assistant.message.data.content` (string, may be empty for tool-only turns → skipped) and `user.message.data.content`.
- Activity — `assistant.turn_start` / `tool.execution_start` / `external_tool.requested` / `subagent.started` / `user.message` → `working`; `permission.requested` → `waiting`; `permission.completed` → `working`; `assistant.turn_end` → `idle`; `session.shutdown` / `abort` → `unknown`.
- The reader's constructor first scans the existing file (if any) to set offset = EOF + emit the **last** derived activity (so stale events from a previous run never replay as live activity).

### Client (`src/client/`) — desktop terminal portal

- `state.ts` — localStorage-persisted `PersistedState`: `servers[]`, `activeNodes`, `knownNodes` (map of serverId → NodeRef[]), `lastCwd`, `lastAgentType` (last-picked agent per server for modal defaults). NodeRef carries an optional `agentType` so the sidebar can render the agent badge before `SessionInfo` arrives. Survives reload.
- `api.ts` — `MaestroApi` per server URL: `health/list/create/kill` over HTTP; `wsUrl(sessionId)` builds the matching `ws(s)://…/maestro-ws?sessionId=…`. Same-origin URLs go through Vite proxy in dev. **Reused verbatim by the mobile client.**
- `node.ts` — `TerminalNode` = one xterm `Terminal` + addons + WS for one server-owned session. Stays mounted (DOM detach via `unmount()`, no dispose) so switching nodes preserves visual state. Auto-reconnects with exp backoff; on each (re)connect calls `term.reset()` then re-attaches and replays scrollback. Implements Ctrl/Cmd+V → `clipboard.readText` → input (xterm swallows it otherwise — see KNOWN_ISSUES). Addons loaded: **FitAddon** (resize), **WebglAddon** (renderer, falls back to DOM on context loss), **WebLinksAddon** (hover/click http(s) URLs), **SearchAddon** (find-in-buffer with brand-colored decorations, exposed via `toggleSearch()` + the floating overlay in `search-overlay.ts`), **SerializeAddon** (buffer dump, exposed via `serialize()` / `serializeAsHTML()` and consumed by the ⌘⇧S snapshot hotkey).
- `main.ts` — orchestrator. Sidebar (servers + nodes tree with `[cla]`/`[cop]` agent badges), topbar (breadcrumb + status pulse + layout-switch + **node-actions group**), stage. New-node modal exposes an **agent** `<select>` next to `cwd`. First-run seeds a `local` server pointing at the current origin. Polls `/api/health`-via-`/api/sessions` every 10 s per server. Owns global hotkeys (capture-phase document `keydown` so xterm doesn't swallow them, ignored while any `<dialog open>` is present): **⌘/Ctrl+B** toggles sidebar, **⌘/Ctrl+F** opens find-in-node on the focused pane, **⌘/Ctrl+Shift+S** downloads `.txt` snapshot (ANSI preserved), **⌘/Ctrl+Shift+H** downloads styled `.html` snapshot. Every keyboard shortcut has an equivalent button in the topbar `node-actions` group so the features are discoverable without keyboard knowledge; buttons go `[disabled]` when no node is focused.

### Mobile client (`src/client-mobile/`) — chat UI

Phone-first browser UI served at `/m`. Renders the agent's output as chat bubbles (Telegram/WeChat-style) instead of a terminal. Built by `vite.mobile.config.ts` (separate Vite root + entry, output `dist/client-mobile`).

- `index.html` — single-page shell with viewport `viewport-fit=cover` for iOS safe-area handling.
- `main.ts` — tiny router across three screens: server picker → session picker → chat. No history-API integration (MVP: screen state is in memory only).
- `mobile-state.ts` — slim localStorage state (`maestro:mobile-state:v1`, separate from desktop), holding only `servers[]`. The current origin is always available as an implicit, non-removable "this device" entry.
- `server-picker.ts` — list of servers with health probe on tap; add/remove remote servers by base URL.
- `session-picker.ts` — list existing sessions (resume, each tagged with its agent badge) and a "new session" form that includes an **agent** `<select>` before the `cwd` field. No `fsList` browsing in MVP — user types the absolute path.
- `chat.ts` — opens WS with `attachChat`, renders history + live `chatMessage` frames as bubbles via `marked` (markdown rendered in safe defaults). User input is sent as `{type:'input', data: text+'\r'}` — same channel terminal clients use. Input box is **locked** while the agent is `working` (activity hook) or while we're awaiting the next `chatMessage`; **unlocked** on idle/waiting/exit-of-turn. If the server responds with `{type:'error', code:'chatNotSupported'}`, the view switches to an inline explainer pointing the user at the desktop terminal portal (no reconnect loop).
- `styles.css` — mobile-first, brutalist vocabulary preserved (bone background, 2px black rules, JetBrains Mono + Fraunces, acid-lime accent on the send button).

The desktop client is **not affected** by mobile traffic — chat messages are parsed from each agent's own transcript file, never from the PTY byte stream.

### Mobile chat data source — agent transcript files

Each agent CLI writes its conversation to a known on-disk file (Claude: `~/.claude/projects/<cwd-slug>/<uuid>.jsonl`; Copilot: `~/.copilot/session-state/<uuid>/events.jsonl`). This is the same file `--resume <uuid>` reads. The maestro server **uses these files as the source of truth for chat bubbles** — it does not parse PTY output at all for the mobile UI. Each agent strategy owns its own reader implementation behind the `AgentReader` interface (see "Agent abstraction").

- `src/server/transcript-reader.ts` is the **Claude-specific** transcript tailer. It derives the slug from the session's cwd (`E:\foo\bar` → `e--foo-bar` on Windows; trailing separators trimmed; `:` and `\`/`/` all become `-`), with a fallback that scans `~/.claude/projects/` for a matching JSONL filename if the slug rule changes in a future Claude version. Used internally by `agents/claude.ts → ClaudeReader`.
- `src/server/agents/copilot.ts` contains the analogous Copilot tailer (no separate file — small enough to colocate with the strategy).
- On `attachChat`, the server calls `reader.readAll()` to extract historical chat messages and sends them as the `history` payload of `chatAttached`. The reader's offset is at end-of-file so subsequent reads only return new entries.
- On new transcript entries the reader broadcasts `chatMessage` frames to chat subscribers. Claude wakes its reader via the `/api/hook` Stop event with exponential backoff; Copilot simply polls every 400 ms.
- MVP extracts only text-content blocks; tool calls, thinking blocks, and system messages are intentionally skipped.

**Implications**: any repo works out of the box — no CLAUDE.md changes required in target repos to enable mobile chat. The chat UI sees exactly what `--resume` would replay.

### Shared client code (`src/client-shared/`)

Both the desktop client (`src/client/`) and the mobile client (`src/client-mobile/`)
import from here. This is the single source of truth for cross-client concerns;
neither client may import from the other (no `client-mobile → client` or vice
versa). Adding a new shared module is preferred over duplicating utilities.

- `api.ts` — `MaestroApi` (HTTP + WebSocket client). All GET methods accept an
  optional `{ signal }` for cancellation.
- `html.ts` — `escapeHtml(s)` for text-context escaping. **Not** an HTML
  sanitizer — never feed its output back to `innerHTML` of attacker-controlled
  content. Use DOMPurify for sanitization (see mobile chat).
- `debug.ts` — `debug(...)` gated on `localStorage.MAESTRO_DEBUG`. Use this
  instead of bare `console.log` for any routine browser-side instrumentation.
- `tokens.css` — design tokens (`--bone`, `--ink`, `--rule`, `--muted`,
  `--lime`, `--warn`, `--err`, `--mono`, `--serif`). Each client's
  `styles.css` `@import`s this file and may add client-local extensions
  (e.g. mobile's `--bubble-*` tokens, desktop's `--bone-2`/`--bone-3` sidebar
  tints). Do not redefine shared tokens locally.

### Shared protocol (`src/shared/protocol.ts`)

- `AgentType = 'claude' | 'copilot'` + `AGENT_TYPES` const (single source of truth — clients import this for validation; server uses `isAgentType()` to gate `POST /api/sessions`).
- `SessionInfo`, `CreateSessionBody` — both carry `agentType`.
- `ClientMessage` = `attach` | `attachChat` | `input` | `resize`.
- `ServerMessage` = `attached` | `chatAttached` | `chatMessage` | `output` | `activity` | `exit` | `error` (`error.code` may be `'chatLocked'` or `'chatNotSupported'`).
- `ChatMessage` (MVP) = `{type:'assistant_text', text, ts}` | `{type:'user_text', text, ts}` — extensible discriminated union.
- Server imports with `.js` extension (ESM) — keep that when adding shared modules.

### Persistence semantics

- **Sessions persist across maestro restart** via `~/.claude-maestro/sessions.json` (the registry) plus the agent's own transcript file (Claude: `~/.claude/projects/<slug>/<uuid>.jsonl`; Copilot: `~/.copilot/session-state/<uuid>/events.jsonl`). After a maestro restart, sessions appear in the API as `attached: false` (dormant) until a client attaches and triggers `<agent> --resume <uuid>`.
- **Persistence migration:** registry entries written before the agent abstraction (no `agentType` field) are loaded as `'claude'`. Entries with an unknown `agentType` value are quarantined with a warning and skipped at load — they remain on disk for forensic inspection but do not appear in the API.
- **Closing/reloading the browser does not affect sessions.** Removing a server from the portal does not kill its sessions.
- **Killing a node** (`DELETE /api/sessions/:id`) removes the session from the registry and deletes its scrollback file. The underlying agent transcript file is left on disk for manual recovery via `<agent> --resume <uuid>` from a shell.
- **Scrollback (the rendered ANSI byte stream) persists across maestro restart** via `~/.claude-maestro/scrollback/<uuid>.bin` — debounced ~2s on every PTY write, flushed synchronously on SIGINT/SIGTERM/beforeExit. Set `MAESTRO_DISABLE_SCROLLBACK_PERSIST=1` to keep scrollback in-memory only (privacy / shared-host scenarios — see `KNOWN_ISSUES.md`).

## Working style

- **Surface tradeoffs, don't pick silently.** If a request has multiple reasonable interpretations or a meaningfully simpler approach exists, name them in one or two sentences before implementing. State load-bearing assumptions explicitly.
- **Ask vs. proceed.** Reversible local changes (edits, refactors inside the scope of the request, restartable dev server): just do them. Architectural choices, anything touching persistence format / WS protocol / external surfaces, or work where you'd have to guess at intent: ask first.
- **Define what "done" looks like before you start non-trivial work.** This repo has no test/lint/typecheck scripts, so success usually means one of: `npm run build` passes, a concrete manual repro in the browser (state the steps), or a specific behavior observed in the PTY/WS traffic. "Make it work" is not a success criterion — name the check.
- **Report failures as failures.** If a change is partial, a build breaks, or a manual check wasn't run, say so plainly. Don't paper over with a confident summary.

## Conventions

- **Cross-platform is the default target.** macOS, Linux, and Windows must all work for every feature, new or evolving. No POSIX-only shell scripts (`#!/bin/sh`, `bash`, `curl`, `chmod`, `&` backgrounding); no Windows-only assumptions either. When a feature needs an out-of-process helper, write it as a Node script invoked via `process.execPath` so it runs anywhere claude-maestro itself runs. Quote paths with spaces. Use `path.join` / `path.sep`, never hardcoded `/`. If a platform genuinely cannot be supported, gate explicitly and document why — silent `if (platform === 'win32') return;` is a regression.
- ESM throughout (`"type": "module"`). Server TS imports of sibling files must use the `.js` extension; client TS does not (Vite resolver).
- Two tsconfigs: root `tsconfig.json` (`noEmit`, covers all of `src` for editor/typecheck) and `tsconfig.server.json` (emits server + shared, `rootDir: src`, `outDir: dist`, so the layout becomes `dist/server/`, `dist/shared/`, alongside Vite's `dist/client/` and `dist/client-mobile/`). The client is built by Vite, not tsc.
- The server expects the built client at `../client` relative to its own output directory — preserve the `dist/server` + `dist/client` layout if changing the build.
- Aesthetic of the portal is intentional: brutalist control-room (bone background, hard 2 px black rules, JetBrains Mono + Fraunces, single acid-lime accent reserved for live state). Keep new UI inside this vocabulary unless changing the direction wholesale.
