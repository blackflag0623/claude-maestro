# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — runs server (`tsx watch` on `src/server/index.ts`, port 4050), Vite desktop client (port 4051), and Vite mobile client (port 4052) concurrently. Both Vite servers proxy `/api` and `/maestro-ws` to the backend.
- `npm run dev:server` / `npm run dev:client` / `npm run dev:client:mobile` — run one piece alone.
- `npm run build` — desktop `vite build` → `dist/client`, then mobile `vite build --config vite.mobile.config.ts` → `dist/client-mobile`, then `tsc -p tsconfig.server.json` → `dist/server`. Only the server gets strict typechecking here; Vite's client/mobile builds are esbuild-transpile-only.
- `npm run typecheck` — `tsc --noEmit -p tsconfig.json` over the whole repo (covers the client and mobile entry points that `npm run build` does not strict-check). Run this before sending a PR that touches client code.
- `npm start` — runs the built server (`node dist/server/index.js`), which serves the desktop client at `/` and the mobile chat client at `/m` from the same port.

No test or lint scripts are configured.

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
| `MAESTRO_COPILOT_BIN` | `copilot` | no | Path to the Copilot binary (supports spaces). Leave unset on Microsoft devboxes — maestro auto-detects `agency` (see "Copilot launch modes" below). |
| `MAESTRO_COPILOT_PREFIX_ARGS` | _(unset)_ | yes | Optional args inserted between the binary and the session flag. Leave unset in direct mode; leave unset in auto-detected agency mode (maestro prepends `copilot` automatically); set to `copilot` if you pin `MAESTRO_COPILOT_BIN=agency` explicitly. |
| `MAESTRO_COPILOT_AGENCY` | _(unset)_ | no | `1` forces agency mode regardless of binary; `0` disables auto-fallback (use this if you have an unrelated tool named `agency` on PATH that maestro keeps picking up). Unset = auto-detect. |
| `MAESTRO_STORE_DIR` | `~/.claude-maestro` | no | Override the registry directory. |

**Copilot launch modes:**

The Copilot strategy supports two launch modes, decided at maestro startup:

- **`direct`** (default when `copilot` is on PATH) — maestro owns the session uuid and always passes `--session-id=<uuid>`, regardless of new/resume intent. Per `copilot --help` this flag is symmetric: it creates a fresh session under the given uuid if none exists, or resumes the existing one if it does. This means maestro doesn't have to second-guess Copilot's on-disk state: if `~/.copilot/session-state/<uuid>/` has been cleaned up between maestro restarts, Copilot starts fresh under the same uuid rather than hard-failing with `No session matched`.
- **`agency`** — for Microsoft devboxes where Copilot must be launched through the `agency` wrapper (auth, env, sandbox). Agency injects its own `--session-id` for new sessions, so maestro must NOT pass one. Maestro discovers the agency-issued uuid post-spawn by snapshotting `~/.copilot/session-state/` before the spawn and watching for the newly created dir (10 s timeout, 200 ms poll, birthtime/ctime-filtered, fails closed on zero/multiple matches). The discovered uuid is persisted as `copilotSessionId`. For resume, maestro issues `agency copilot --resume=<copilotSessionId>` — verified to forward through `agency` to `copilot`. **Resume pre-flight:** before spawning, maestro checks that `~/.copilot/session-state/<copilotSessionId>/events.jsonl` still exists; if it's gone, maestro clears the recorded id, downgrades to a fresh agency session (agency picks a new uuid), and emits a yellow banner in the terminal explaining the reset — see `SpawnTarget.onResumeUnavailable` in `agents/index.ts`.

**Mode resolution priority (at maestro startup):**

1. User pinned `MAESTRO_COPILOT_BIN` → honor it. Launch mode comes from `MAESTRO_COPILOT_AGENCY` if explicit, else from the bin's basename (`agency`, `agency.exe`, `agency.cmd` → agency; otherwise direct).
2. `MAESTRO_COPILOT_AGENCY=1` → force agency with whatever bin/prefix args the user set.
3. **Auto-fallback** (the Microsoft-devbox happy path): no bin pin AND `copilot` is not on PATH AND `agency` is on PATH → promote silently to `agency copilot`. Opt out with `MAESTRO_COPILOT_AGENCY=0`.
4. Otherwise → direct mode with `copilot` (may fail at spawn time if missing).

Each Copilot session records its launch mode at create time (`copilotLaunchMode` in `sessions.json`). If maestro restarts in a different mode, spawn fails closed with a clear error rather than silently starting a fresh session and losing conversation history. To switch modes for an existing session, restart maestro with the original env vars, or delete the session and create a new one.

**Copilot events.jsonl mapping** (`agents/copilot.ts`):

Copilot CLI writes one JSON event per line to `~/.copilot/session-state/<uuid>/events.jsonl`. The Copilot reader tails this file with a 400 ms `pread + StringDecoder` poll (same pattern as the Claude transcript reader) and maps event types to chat bubbles / activity:

- Chat content — `assistant.message.data.content` (string, may be empty for tool-only turns → skipped) and `user.message.data.content`.
- Activity — `assistant.turn_start` / `tool.execution_start` / `external_tool.requested` / `subagent.started` / `user.message` → `working`; `permission.requested` → `waiting`; `permission.completed` → `working`; `assistant.turn_end` → `idle`; `session.shutdown` / `abort` → `unknown`.
- The reader's constructor first scans the existing file (if any) to set offset = EOF + emit the **last** derived activity (so stale events from a previous run never replay as live activity).

### Client (`src/client/`) — desktop terminal portal

The client is split into focused modules. `app-context.ts` owns the
shared mutable state and DOM refs, every other UI module imports from
it, and `main.ts` is a thin boot orchestrator. Import direction is
strictly one-way: nothing imports back into `app-context`, no UI module
imports from `main`, and the rough layering is
`app-context → {topbar, sidebar-toggle, server-popup, drag-reorder,
node, state, api} → {pane-manager, server-actions, node-actions} →
{sidebar, modals, hotkeys} → main`. Keep new code in this shape — do
not grow `main.ts` back into a god module.

- `state.ts` — localStorage-persisted `PersistedState`: `servers[]`, `activeNodes`, `knownNodes` (map of serverId → NodeRef[]), `lastCwd`, `lastAgentType` (last-picked agent per server for modal defaults). NodeRef carries an optional `agentType` so the sidebar can render the agent badge before `SessionInfo` arrives. Survives reload. Also owns the bundle import/export (`importBundle` returns `{state, result}`; `result` has `{added, skipped}` counts).
- `api.ts` — `MaestroApi` per server URL: `health/list/create/kill` over HTTP; `wsUrl(sessionId)` builds the matching `ws(s)://…/maestro-ws?sessionId=…`. Same-origin URLs go through Vite proxy in dev. **Reused verbatim by the mobile client.**
- `node.ts` — `TerminalNode` = one xterm `Terminal` + addons + WS for one server-owned session. Stays mounted (DOM detach via `unmount()`, no dispose) so switching nodes preserves visual state. Auto-reconnects with exp backoff; on each (re)connect calls `term.reset()` then re-attaches and replays scrollback. Implements Ctrl/Cmd+V → `clipboard.readText` → input (xterm swallows it otherwise — see KNOWN_ISSUES). Addons loaded: **FitAddon** (resize), **WebglAddon** (renderer, falls back to DOM on context loss), **WebLinksAddon** (hover/click http(s) URLs), **SearchAddon** (find-in-buffer with brand-colored decorations, exposed via `toggleSearch()` + the floating overlay in `search-overlay.ts`), **SerializeAddon** (buffer dump, exposed via `serialize()` / `serializeAsHTML()` and consumed by the ⌘⇧S snapshot hotkey).
- `app-context.ts` — the foundation module: `getState()` / `setState()`, the mutable runtime maps (`servers`, `nodes`, `explorers`, `explorerOpen`), all DOM `$refs`, primitive helpers (`nodeKey`, `runtimeFor`, `findSlotOf`, `isActive`, `persist`), and the render scheduler. Other modules call `scheduleRender()` freely; `main.ts` registers the actual callback once via `setRenderCallback` to avoid circular imports.
- `topbar.ts` — `renderTopbar` (breadcrumb), `renderHud` / `renderStageTag`, `setStatus` (server pulse), the uptime ticker, and shortcut localization (`IS_MAC`, `modGlyph`, `localizeShortcuts`).
- `sidebar.ts` — `renderSidebar` (servers + nodes tree with `[cla]`/`[cop]` agent badges). Coordinates with `server-popup` and `drag-reorder` via the `sidebarHasPendingRender` / `flushSidebarIfPending` flag, so renders that would yank the popup or drag target are deferred until the interaction ends.
- `sidebar-toggle.ts` — `applySidebarState` + `toggleSidebar` with the View Transitions API fallback. **⌘/Ctrl+B** is wired in `hotkeys.ts`.
- `server-popup.ts` — the hover popup on server rows (open/close/position, plus `installServerPopupGlobalListeners()` for the once-per-app scroll/resize/Escape handlers).
- `drag-reorder.ts` — FLIP-animated drag-and-drop for sidebar reorder. Exports `attachDrag`, `isDragging`, `currentDrag`, and `commitDragOrderFromDom`.
- `pane-manager.ts` — owns pane DOM, layout state, and focus: `getOrCreateNode` / `getOrCreateExplorer`, `toggleExplorer`, `destroyNode(sForServer)`, `setLayoutMode`, `placeInSlot` / `detachSlot`, `focusPane`, `selectNode`, plus the `focusedNode` / `focusedRef` getters consumed by `hotkeys` and `node-actions`.
- `server-actions.ts` — `refreshServer` / `refreshAll` (the 10 s poller calls `refreshAll`), `addServer`, `removeServer`.
- `node-actions.ts` — `createNode`, `killNode`.
- `modals.ts` — `openNodeModal` and `installModals()` (wires server + node modal submits, import/export). The new-node modal exposes an **agent** `<select>` next to `cwd`. Modal backdrop close uses the `data-close` attribute, not `e.target === modal`.
- `hotkeys.ts` — `installHotkeys()` registers the capture-phase document `keydown` (so xterm doesn't swallow them, ignored while any `<dialog open>` is present) and the topbar layout-switch + **node-actions group** buttons. Hotkeys: **⌘/Ctrl+B** toggles sidebar, **⌘/Ctrl+F** opens find-in-node on the focused pane, **⌘/Ctrl+Shift+S** downloads `.txt` snapshot (ANSI preserved), **⌘/Ctrl+Shift+H** downloads styled `.html` snapshot. Every shortcut has an equivalent topbar button so the features are discoverable without keyboard knowledge; buttons go `[disabled]` when no node is focused.
- `main.ts` — boot orchestrator only (~70 LoC). Registers the render callback, starts the uptime ticker, calls every `install*()` entry point, seeds the local server on first run, mounts previously-active nodes via `getOrCreateNode`, then starts the 10 s polling interval. Do not add feature logic here — extend the relevant module instead.

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

### Mobile tool-call gating (PreToolUse interception, Claude only)

Mobile chat intercepts Claude's tool calls via the PreToolUse hook. By default the gating is **off** (auto-allow): tool calls flow through unchanged, but the phone gets an informational `tool_call` bubble showing what Claude ran. This preserves the `bypassPermissions` daily workflow. Copilot has no hook system, so this feature is Claude-only — server-side the gating only fires when `s.agentType === 'claude'`.

The phone has a topbar mode toggle that cycles `auto` → `pause-next` → `always-pause`:

- **`pause-next`** — the next single tool call broadcasts a pending bubble with Allow / Deny + optional reason; once answered the mode reverts to auto.
- **`always-pause`** — every tool call pauses for phone approval until the user cycles back to auto.

Server-side, `src/server/hook-pending.ts` maintains a per-`(sessionId, toolCallId)` map of suspended `Promise`s. `POST /api/hook` for PreToolUse calls `requestVerdict()` with a 55s timeout; the WS `toolDecision` handler calls `resolveVerdict()`. The Claude hook script (`~/.claude-maestro/hook.mjs`, written by `src/server/agents/claude.ts > ensureClaudeHookFiles`) branches on event type — PreToolUse blocks on the HTTP response, all other events stay fire-and-forget. The script translates the verdict into Claude's `permissionDecision` JSON. Timeout falls through to allow, matching the bypass-mode default. Claude's per-hook `timeout: 75` is set on PreToolUse so Claude's own timer doesn't pre-empt the 65s blocking budget.

Mode is stored per WS subscriber (`WeakMap<WebSocket, ChatMode>`), so closing the mobile tab resets it. With chat-attach exclusivity, only one subscriber's mode is ever in effect at a time. On chat-WS close, `clearVerdictsForSession` releases any in-flight wait so Claude isn't blocked until the 55s timeout fires.

**Synthetic bubble persistence**: tool_call bubbles aren't in the JSONL transcript, so the server keeps them in `s.syntheticBubbles` (per-session `Map`, keyed by toolCallId) and persists them under `~/.claude-maestro/bubbles/<sessionId>.jsonl` (append-only, collapsed by toolCallId on load). On chat reconnect, the server merges JSONL transcript history with synthetic bubbles, sorted by `ts`, so the conversation reads chronologically.

**Per-tool rendering**: `chat.ts > renderToolSummary()` dispatches on `toolName` for Bash / Read / Write / Edit / Glob / Grep / TodoWrite / AskUserQuestion with bespoke compact layouts; unknown tools fall through to a JSON pretty-print. Add a `case` when a new tool deserves a custom view.

**AskUserQuestion bridging**: `AskUserQuestion` is intercepted unconditionally when a chat subscriber is attached, regardless of the pause mode. The phone gets a bubble with option buttons (or a free-text override); choosing an option sends `toolDecision` with `decision='deny'` and `reason='User answered AskUserQuestion — ...'`. The server forces deny+reason in this path, so Claude reads the user's selection as feedback in the `permissionDecisionReason` field and adapts. The actual `AskUserQuestion` tool never runs to its TUI menu — preventing a race between the phone answer and a desktop user selecting in the terminal. If no chat subscriber is present, the tool runs normally and the desktop TUI handles it.

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
