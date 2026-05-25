# Known Issues & Restrictions

Tracks known limitations, upstream quirks, and platform restrictions affecting claude-maestro. Add new entries at the top of the relevant section. Each entry should include: symptom, root cause, workaround, and links.

---

## Client (xterm.js / browser)

### Ctrl+V does not paste; right-click → Paste works

- **Symptom:** Pressing Ctrl+V (or Cmd+V) in the web terminal does nothing visible — the keystroke is swallowed. Right-click → Paste from the browser context menu pastes correctly.
- **Root cause:** xterm.js attaches a hidden `textarea` that captures `keydown`. Ctrl+V is interpreted as the terminal control sequence `\x16` (SYN) and forwarded to the PTY via `onData`, so it never reaches the browser's native paste handler. The right-click path fires a DOM `paste` event directly on the textarea, which xterm.js handles natively and forwards to the PTY as text. This is upstream "as-designed" behavior, not a bug.
- **Workaround:** Intercept Ctrl/Cmd+V via `term.attachCustomKeyEventHandler`, call `navigator.clipboard.readText()`, and send the text over the WS as an `input` message. Requires a secure context (https or localhost — our dev URLs qualify) and may prompt for clipboard permission. Optionally do the same for Ctrl/Cmd+C when `term.hasSelection()` is true.
- **References:**
  - [xtermjs/xterm.js#2478 — Browser Copy/Paste support documentation](https://github.com/xtermjs/xterm.js/issues/2478)
  - [xtermjs/xterm.js#4745 — How to copy and paste with ctrl+C / ctrl+V](https://github.com/xtermjs/xterm.js/issues/4745)
  - [xtermjs/xterm.js#5297 — Paste in VSCode + Powershell + Node (closed as-designed)](https://github.com/xtermjs/xterm.js/issues/5297)

---

## Server (node-pty / shell auto-launch)

### Scrollback (terminal output) is lost on maestro restart

- **Symptom:** After restarting `npm run dev` (server side), reattaching to a previously-running node shows an empty terminal — `claude` is rehydrated mid-conversation but the visual scrollback before the restart is gone.
- **Root cause:** Scrollback is the rendered ANSI byte stream from xterm; it lives in maestro's process memory (256 KB ring per session) and is not persisted. The Claude *conversation* itself is rebuilt by `claude --resume <uuid>` from its on-disk JSONL, but xterm has nothing to replay against.
- **Workaround:** None within maestro. The conversation history is preserved — just scroll up inside the rehydrated Claude TUI to see prior turns.

---

## Protocol / WebSocket

### CORS is wide-open; trust assumed at the network layer

- **Symptom:** Any origin can hit `/api/*` and `/maestro-ws` if it can reach the host.
- **Root cause:** The portal is intended for trusted LANs / dev machines and `Access-Control-Allow-Origin` is reflected from the request. There is no auth token, no CSRF protection, and no per-session ownership check.
- **Workaround:** Bind the server to a private interface, or front it with a reverse proxy that adds auth. Do not expose `claude-maestro` directly to the public internet.

---

## Platform-specific

_(none recorded yet)_

---

## Agent integrations

### Copilot CLI launched via the Microsoft `agency` wrapper — **not supported**

- **Symptom:** Spawning a Copilot node via `MAESTRO_COPILOT_BIN=agency` + `MAESTRO_COPILOT_PREFIX_ARGS=copilot` fails with `Error: option '--session-id <id>' cannot be used with option '--resume[=value]'` (or, with the older `--session-id <uuid>` two-token form, the more confusing `Error: No session, task, or name matched '<uuid>'`).
- **Root cause:** `agency` synthesizes its **own** session UUID and unconditionally injects `--resume <agency-uuid>` into the underlying `copilot.exe` invocation. There is no agency flag to suppress this. Maestro then appends `--session-id=<our-uuid>`, and Copilot rejects the conflict. Verified by inspecting the live `copilot.exe` command line via `Get-CimInstance Win32_Process` while `agency copilot --acp` was running — agency had already added `--resume f2a70fe3-…` before our args.
- **Workaround:** **Bypass `agency` entirely.** On Microsoft devboxes the underlying Copilot CLI is on `PATH` at `C:\Users\<you>\AppData\Local\Microsoft\WinGet\Links\copilot.exe`, so the defaults (`MAESTRO_COPILOT_BIN=copilot`, no `MAESTRO_COPILOT_PREFIX_ARGS`) just work — clear those env vars before starting maestro. If `copilot` is not on `PATH` for the maestro process, point `MAESTRO_COPILOT_BIN` directly at the full `copilot.exe` path (still no prefix args). Agency's own job (session lifecycle, MCP wiring) overlaps with what maestro itself does, so going through it is not just unsupported but undesirable.

### Copilot CLI mobile chat: tool-only turns appear silent

- **Symptom:** When Copilot answers with only tool calls (no `assistant.message` text), nothing is added to the mobile chat history for that turn.
- **Root cause:** The Copilot reader extracts `assistant.message.data.content` (text) and `user.message.data.content` only; tool calls, system messages, and thinking blocks are intentionally skipped for MVP.
- **Workaround:** Open the session from the desktop terminal portal to see the full transcript including tool invocations. Mapping `tool.execution_complete` events into chat bubbles is a future enhancement.

---

## Mobile chat frontend (`/m`)

### Permission prompts freeze the chat (MVP)

- **Symptom:** When Claude requests a tool whose use is not pre-allowed (e.g. `Bash`, `Write`), it emits an interactive permission prompt to the TUI. The mobile chat client renders nothing for this — the chat appears to hang, and the user cannot answer the prompt from the phone.
- **Root cause:** The mobile UI's only source of structured data is Claude's JSONL transcript file. The transcript records the *outcome* of permission decisions but not the interactive prompt itself, so there is nothing to render or respond to from the phone.
- **Workaround:** Pre-allow common tools in the target repo's `.claude/settings.json` (`permissions.allow`) so Claude does not need to prompt. For full interactivity, attach a desktop terminal client to the same session (after closing the mobile tab, since chat mode is exclusive) to clear the prompt.

### Mobile chat mode is exclusive — only one client per session

- **Symptom:** Opening a session in the mobile chat UI while a desktop terminal is attached to the same session shows "another client is connected to this session". Same in reverse.
- **Root cause:** Chat mode requires `s.subscribers.size === 0` at attach time. This is deliberate — terminal byte streams and structured chat frames cannot safely coexist for the same WS connection set, and we want predictable behavior over flexibility for MVP.
- **Workaround:** Close other clients before opening chat. Refresh / re-open the mobile tab once the other client disconnects.

---
