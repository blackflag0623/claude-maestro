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

### Persisted scrollback is cached on disk (privacy implication)

- **Symptom:** Maestro mirrors each session's PTY byte stream to `~/.claude-maestro/scrollback/<uuid>.bin` (raw UTF-8, ANSI escapes preserved) so the visual buffer survives maestro restart. On shared hosts these files are readable by anything running as the same user and may contain tokens pasted into the terminal, file paths, command output, etc.
- **Root cause:** Without an on-disk cache, scrollback is recreated only by `claude --resume` / Copilot's reader replaying the structured transcript — which loses the visual buffer (TUI redraws, colors, tool-call rendering) the user actually saw before the restart.
- **Workaround:** Set `MAESTRO_DISABLE_SCROLLBACK_PERSIST=1` before starting maestro to keep scrollback in memory only. Files for killed sessions are removed automatically; files for sessions explicitly deleted via `DELETE /api/sessions/:id` are also removed. The `~/.claude-maestro/scrollback/` directory can be safely wiped at any time — only the visual buffer is affected, not the agent's conversation.

### Scrollback ring may overshoot 256 KB for a single oversized chunk

- **Symptom:** If a single PTY write exceeds 256 KB (e.g. a large image escape sequence emitted by an agent that supports sixel / iTerm graphics), `ScrollbackBuffer` keeps it as-is rather than slicing it, so the effective buffer can briefly hold more than the configured limit.
- **Root cause:** The trim loop drops oldest chunks until one is left; slicing the survivor on every write would re-allocate and defeat the chunk-array design.
- **Workaround:** None needed in practice — typical PTY chunks are <1 KB. If an agent starts emitting hundreds of KB per write, lower its image-output verbosity or strip image escapes upstream.

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

### Copilot CLI launched via the Microsoft `agency` wrapper — supported, with caveats

Agency mode is now a first-class Copilot launch mode (see CLAUDE.md → "Copilot launch modes"). Enable by setting `MAESTRO_COPILOT_BIN=agency` and `MAESTRO_COPILOT_PREFIX_ARGS=copilot` (or set `MAESTRO_COPILOT_AGENCY=1` to force the mode without renaming the binary). Two known limitations:

- **Concurrent `agency copilot` from another shell during the discovery window.** In agency mode maestro snapshots `~/.copilot/session-state/` immediately before spawning and watches for the new uuid-named dir for up to 10 s. If a different shell on the same OS user also runs `agency copilot` inside that window, both new dirs will pass the birthtime filter and maestro will **fail closed** with `multiple new session-state directories observed: …`, refusing to guess which uuid belongs to its child PTY. The PTY itself remains running but maestro never wires up the events.jsonl tail, so chat history and activity indicators stay empty. **Workaround:** kill the half-attached node and retry the create once the other invocation has fully settled (~1 s).

- **Launch-mode lock per session.** Each Copilot session records `copilotLaunchMode` (`direct` or `agency`) at create time. If maestro restarts with a different mode, spawn for that session fails closed with a clear mismatch error rather than silently starting a fresh conversation. **Workaround:** restart maestro with the original env vars (set/unset `MAESTRO_COPILOT_AGENCY` and `MAESTRO_COPILOT_BIN` accordingly), or delete the session and create a new one.

### Copilot CLI mobile chat: tool-only turns appear silent

- **Symptom:** When Copilot answers with only tool calls (no `assistant.message` text), nothing is added to the mobile chat history for that turn.
- **Root cause:** The Copilot reader extracts `assistant.message.data.content` (text) and `user.message.data.content` only; tool calls, system messages, and thinking blocks are intentionally skipped for MVP.
- **Workaround:** Open the session from the desktop terminal portal to see the full transcript including tool invocations. Mapping `tool.execution_complete` events into chat bubbles is a future enhancement.

---

## Mobile chat frontend (`/m`)

### TUI-only interactive states remain unbridged

- **Symptom:** Some interactive Claude Code prompts don't surface on the mobile chat UI. Examples: slash command picker (e.g. typing `/` on desktop opens an arrow-key menu), `--continue` confirmations, login flows.
- **Root cause:** These flows live only in the TUI byte stream — Claude does not write them to the JSONL transcript, and they don't go through the PreToolUse hook either. The mobile client only sees JSONL-derived bubbles and hook-derived tool_call bubbles, so it has no signal for them.
- **Status:** Tool-use permission prompts are **resolved** — the maestro PreToolUse hook bridges them to phone-side Allow/Deny bubbles (off by default; toggleable in the mobile topbar). Slash menus / continue prompts remain TUI-only.
- **Workaround:** For sessions whose workflows need those interactions, use the desktop terminal client. The mobile chat-attach is exclusive, so you'll need to close the mobile tab first.

### Mobile chat mode is exclusive — only one client per session

- **Symptom:** Opening a session in the mobile chat UI while a desktop terminal is attached to the same session shows "another client is connected to this session". Same in reverse.
- **Root cause:** Chat mode requires `s.subscribers.size === 0` at attach time. This is deliberate — terminal byte streams and structured chat frames cannot safely coexist for the same WS connection set, and we want predictable behavior over flexibility for MVP.
- **Workaround:** Close other clients before opening chat. Refresh / re-open the mobile tab once the other client disconnects.

---
