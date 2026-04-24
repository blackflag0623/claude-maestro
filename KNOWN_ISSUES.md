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

### Sessions are in-memory only — restarting the server kills everything

- **Symptom:** After `npm run dev` restart (server side), all previously-created nodes vanish; the client shows them as gone after the next refresh.
- **Root cause:** `sessions: Map<id, Session>` lives in process memory. PTYs are children of the maestro process and die with it. No on-disk persistence.
- **Workaround:** Treat server restarts as session-destructive. If durability across restarts is needed, persist `SessionInfo` + scrollback to disk and respawn PTYs on boot — non-trivial because the in-flight `claude` process state cannot be recovered.

---

## Protocol / WebSocket

### CORS is wide-open; trust assumed at the network layer

- **Symptom:** Any origin can hit `/api/*` and `/maestro-ws` if it can reach the host.
- **Root cause:** The portal is intended for trusted LANs / dev machines and `Access-Control-Allow-Origin` is reflected from the request. There is no auth token, no CSRF protection, and no per-session ownership check.
- **Workaround:** Bind the server to a private interface, or front it with a reverse proxy that adds auth. Do not expose `claude-maestro` directly to the public internet.

---

## Platform-specific

_(none recorded yet)_
