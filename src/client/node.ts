import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import { SerializeAddon } from '@xterm/addon-serialize';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { ImageAddon, type IImageAddonOptions } from '@xterm/addon-image';
import '@xterm/xterm/css/xterm.css';
import type { ClientMessage, ServerMessage, SessionInfo, SessionActivity } from '../shared/protocol';
import type { MaestroApi } from '../client-shared/api';
import { buildCursorIndicator, type CursorIndicator } from './cursor-indicator';
import { buildSearchOverlay, type SearchOverlay } from './search-overlay';

export type NodeStatus = 'connecting' | 'live' | 'reconnecting' | 'exited' | 'error';

export interface NodeEvents {
  status?: (s: NodeStatus) => void;
  title?: (t: string) => void;
  activity?: (a: SessionActivity) => void;
}

const TERM_BG = '#0a0a0a';
const TERM_FG = '#e8e8e3';
const TERM_LIME = '#c6ff3d';

/**
 * One Node = one xterm Terminal bound to one server-owned session by id.
 * The Terminal stays mounted (in a host element) for the node's lifetime so
 * scrollback survives switching. WS auto-reconnects with exponential backoff.
 */
export class TerminalNode {
  readonly el: HTMLDivElement;
  readonly term: Terminal;
  private readonly fit = new FitAddon();
  private readonly search = new SearchAddon();
  private readonly serializer = new SerializeAddon();
  private readonly searchOverlay: SearchOverlay;
  private readonly imageAddon: ImageAddon;
  private webgl: WebglAddon | null = null;
  private ws: WebSocket | null = null;
  private reconnectDelay = 500;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private resizeObserver: ResizeObserver | null = null;
  private _status: NodeStatus = 'connecting';
  private _activity: SessionActivity = 'unknown';
  private lastPasteAt = 0;
  private readonly indicator: CursorIndicator;
  private readonly jumpPill: HTMLButtonElement;
  private jumpPillCount: HTMLSpanElement;
  private replayingScrollback = false;
  private newLinesWhileAway = 0;
  private prevBaseY = 0;
  session: SessionInfo | null = null;

  constructor(
    readonly api: MaestroApi,
    readonly sessionId: string,
    private readonly events: NodeEvents = {},
  ) {
    this.el = document.createElement('div');
    this.el.className = 'node-host';

    this.term = new Terminal({
      cursorBlink: false,
      cursorInactiveStyle: 'none',
      cursorStyle: 'bar',
      cursorWidth: 1,
      fontFamily: '"JetBrains Mono", Consolas, "Cascadia Mono", Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      letterSpacing: 0,
      allowProposedApi: true,
      theme: {
        background: TERM_BG,
        foreground: TERM_FG,
        // Visible cursor color. For Claude sessions xterm's cursor is hidden
        // via CSS (Claude draws an inline reverse-video block as its caret);
        // for Copilot CLI the user relies on xterm's native cursor — we set
        // it to the acid-lime accent so the caret matches the portal theme.
        cursor: TERM_LIME,
        cursorAccent: TERM_BG,
        selectionBackground: TERM_LIME + '44',
        black: TERM_BG,
        brightBlack: '#3a3a3a',
        red: '#ff5c57',
        brightRed: '#ff6b66',
        green: TERM_LIME,
        brightGreen: '#d4ff66',
        yellow: '#f3f99d',
        brightYellow: '#f8faa8',
        blue: '#57c7ff',
        brightBlue: '#6bd2ff',
        magenta: '#ff6ac1',
        brightMagenta: '#ff7fcf',
        cyan: '#9aedfe',
        brightCyan: '#b4f1ff',
        white: TERM_FG,
        brightWhite: '#ffffff',
      },
    });
    this.term.loadAddon(this.fit);
    this.term.loadAddon(this.search);
    this.term.loadAddon(this.serializer);
    // Unicode 11 width tables — without this xterm uses Unicode 6 widths, so
    // modern emoji, CJK and box-drawing glyphs (which Claude / Copilot emit
    // freely) get the wrong cell width and misalign columns. Must be loaded
    // and activated BEFORE the first `term.write()` so the buffer is parsed
    // with the right widths from the very first byte.
    this.term.loadAddon(new Unicode11Addon());
    this.term.unicode.activeVersion = '11';
    // Inline-image support: sixel + iTerm IIP escape sequences are decoded
    // by addon-image and rendered onto an overlay canvas. Tools like
    // `imgcat`, `viu`, matplotlib in sixel mode, and various TUI plot
    // libraries depend on this. MUST be loaded before `term.open()` per
    // the addon's docs — it hooks the parser at addon-load time and won't
    // intercept escapes emitted before that point.
    //
    // Limits are tightened well below upstream defaults so a runaway agent
    // can't blow the renderer's memory budget — on a phone or a tab kept
    // open for days, the defaults (128 MB storage, 16 Mpx, 25 MB sixel)
    // are too generous.
    const imageOptions: IImageAddonOptions = {
      enableSizeReports: true,
      pixelLimit: 4_096 * 4_096, // 16 Mpx, sufficient for any realistic terminal-emitted image
      storageLimit: 16, // MB of decoded image data retained in scrollback
      showPlaceholder: true,
      sixelSizeLimit: 8 * 1024 * 1024,
      sixelPaletteLimit: 256,
      sixelScrolling: true,
      iipSupport: true,
      iipSizeLimit: 8 * 1024 * 1024,
    };
    this.imageAddon = new ImageAddon(imageOptions);
    this.term.loadAddon(this.imageAddon);
    // Web-links: hover-underline + Ctrl/Cmd+click to open in a new tab.
    // Default URL regex covers `http(s)://` only — enough for what Claude
    // typically prints (doc links, PRs, issues).
    this.term.loadAddon(new WebLinksAddon());
    this.term.open(this.el);
    // WebGL renderer — falls back to DOM on context loss.
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        try { webgl.dispose(); } catch {}
        this.webgl = null;
      });
      this.term.loadAddon(webgl);
      this.webgl = webgl;
    } catch (err) {
      console.warn('[maestro] WebGL renderer unavailable, falling back to DOM:', err);
    }
    this.indicator = buildCursorIndicator();
    this.el.appendChild(this.indicator.el);
    this.searchOverlay = buildSearchOverlay(this.search);
    this.el.appendChild(this.searchOverlay.el);

    // Jump-to-bottom pill. Pinned bottom-right of the terminal pane, offset
    // left of the xterm scrollbar (the cursor-indicator uses the same offset
    // pattern). Hidden when the viewport is already at the bottom of the
    // buffer. While scrolled away from the bottom, accumulates a count of
    // newly-arrived scrollback lines so the user knows there is fresh
    // output waiting below.
    this.jumpPill = document.createElement('button');
    this.jumpPill.type = 'button';
    this.jumpPill.className = 'jump-to-bottom';
    this.jumpPill.hidden = true;
    this.jumpPill.setAttribute('aria-label', 'jump to bottom');
    this.jumpPill.title = 'jump to bottom';
    const arrow = document.createElement('span');
    arrow.className = 'jump-to-bottom__arrow';
    arrow.textContent = '↓';
    this.jumpPillCount = document.createElement('span');
    this.jumpPillCount.className = 'jump-to-bottom__count';
    this.jumpPill.appendChild(arrow);
    this.jumpPill.appendChild(this.jumpPillCount);
    this.jumpPill.addEventListener('click', () => {
      this.term.scrollToBottom();
      this.newLinesWhileAway = 0;
      this.updateJumpPill();
      this.term.focus();
    });
    this.el.appendChild(this.jumpPill);

    // onScroll fires for both user-driven scroll and buffer growth. We use
    // the delta in `buffer.active.baseY` to detect new content (lines pushed
    // into scrollback) and `viewportY >= baseY` to detect "at bottom". When
    // the user is scrolled away and new lines arrive, we accumulate a
    // counter; when they jump back to the bottom we reset.
    this.term.onScroll(() => this.onScroll());

    // All paste paths funnel through pasteText() which wraps content in
    // bracketed-paste markers. Keyboard and DOM entry points coordinate
    // via lastPasteAt to avoid double-firing.
    this.term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key.toLowerCase() === 'v') {
        this.lastPasteAt = Date.now();
        navigator.clipboard
          .readText()
          .then((text) => this.pasteText(text))
          .catch(() => {});
        return false;
      }
      if (ctrl && e.key.toLowerCase() === 'c' && this.term.hasSelection()) {
        navigator.clipboard.writeText(this.term.getSelection()).catch(() => {});
        return false;
      }
      return true;
    });

    // Catch right-click / middle-click / IME paste. Capture phase blocks
    // xterm's built-in handler.
    this.el.addEventListener(
      'paste',
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (Date.now() - this.lastPasteAt < 250) return;
        this.pasteText(e.clipboardData?.getData('text') ?? '');
      },
      true,
    );

    this.term.onData((data) => this.send({ type: 'input', data }));
    this.term.onResize(({ cols, rows }) => this.send({ type: 'resize', cols, rows }));

    // Alternate-screen-buffer mouse wheel translation. TUI apps that take
    // over the screen (vim, less, htop, Claude Code, Copilot CLI) switch
    // xterm into the alternate buffer (`\x1b[?1049h`). The alt buffer has
    // no scrollback by design — the app draws its own content into the
    // visible viewport and handles its own history navigation. xterm.js
    // does not translate wheel events in this mode, so the user appears
    // unable to scroll. Windows Terminal solves this with its on-by-default
    // "alternateScroll" feature: wheel events get rewritten into arrow-key
    // (or PgUp/PgDn with Shift) escape sequences and forwarded to the app,
    // which interprets them as line-by-line (or page) navigation. Mirror
    // that here so Copilot CLI's history can be browsed with the mouse.
    this.term.attachCustomWheelEventHandler((e) => {
      if (this.term.buffer.active.type !== 'alternate') return true;
      if (e.ctrlKey || e.altKey || e.metaKey) return true; // leave room for zoom etc.
      if (e.deltaY === 0) return true; // horizontal scroll only — let xterm handle

      const fontSize = this.term.options.fontSize ?? 13;
      const lineHeight = this.term.options.lineHeight ?? 1.2;
      const lineHeightPx = fontSize * lineHeight;
      let lines: number;
      if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) {
        lines = e.deltaY;
      } else if (e.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
        lines = e.deltaY * this.term.rows;
      } else {
        lines = e.deltaY / lineHeightPx;
      }
      const count = Math.min(10, Math.max(1, Math.round(Math.abs(lines))));
      const down = lines > 0;
      const appCursor = this.term.modes.applicationCursorKeysMode;
      // Shift+wheel → PgUp/PgDn for faster scrolling, matching common terminals.
      let seq: string;
      if (e.shiftKey) {
        seq = down ? '\x1b[6~' : '\x1b[5~';
      } else if (appCursor) {
        seq = down ? '\x1bOB' : '\x1bOA';
      } else {
        seq = down ? '\x1b[B' : '\x1b[A';
      }
      this.send({ type: 'input', data: seq.repeat(count) });
      e.preventDefault();
      return false;
    });

    this.connect();
  }

  get status(): NodeStatus {
    return this._status;
  }

  get activity(): SessionActivity {
    return this._activity;
  }

  private setStatus(s: NodeStatus) {
    this._status = s;
    this.events.status?.(s);
  }

  private setActivity(a: SessionActivity) {
    if (this._activity === a) return;
    this._activity = a;
    this.events.activity?.(a);
  }

  private send(msg: ClientMessage) {
    if (this.ws && this.ws.readyState === this.ws.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private pasteText(text: string) {
    if (!text) return;
    const normalized = text.replace(/\r\n?/g, '\n');
    this.send({ type: 'input', data: `\x1b[200~${normalized}\x1b[201~` });
  }

  /** Mount into a host container (called when this node becomes active). */
  mount(host: HTMLElement) {
    if (this.el.parentElement !== host) host.appendChild(this.el);
    // Defer fit until layout has settled.
    requestAnimationFrame(() => this.relayout());
    if (!this.resizeObserver) {
      this.resizeObserver = new ResizeObserver(() => this.relayout());
      this.resizeObserver.observe(host);
    }
    this.term.focus();
  }

  /** Detach the DOM element; xterm + WS keep running. */
  unmount() {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.el.parentElement) this.el.parentElement.removeChild(this.el);
  }

  relayout() {
    if (!this.el.isConnected) return;
    try {
      this.fit.fit();
    } catch {}
  }

  /** Toggle the per-node find overlay. Called from the global ⌘/Ctrl+F handler. */
  toggleSearch() {
    if (this.searchOverlay.isOpen()) this.searchOverlay.close();
    else this.searchOverlay.open();
  }

  /** Serialize the current buffer (scrollback + viewport) to plain text.
   *  ANSI escape sequences are preserved so the file replays accurately in
   *  any terminal; strip with `data.replace(/\x1b\[[0-9;]*m/g, '')` if a
   *  plain dump is needed. */
  serialize(): string {
    return this.serializer.serialize();
  }

  /** Serialize the current buffer to a standalone HTML document with ANSI
   *  colors rendered as inline styles. The raw addon output is just
   *  `<html><body><pre>...</pre></body></html>` (no DOCTYPE, no charset, no
   *  page styles) — we wrap it with a proper document shell so the saved
   *  file opens in a browser with the same dark bg + brand font as the
   *  live terminal, while leaving the addon's inline-styled spans intact. */
  serializeAsHTML(title = 'maestro snapshot'): string {
    const inner = this.serializer.serializeAsHTML();
    // Extract just the <pre>…</pre> block. The addon wraps it in
    // <html><body><!--StartFragment--><pre>…</pre><!--EndFragment-->
    // </body></html>; we want the <pre> so we can put it inside our own
    // document shell. Fall back to the full inner string if the shape
    // ever changes upstream.
    const preMatch = inner.match(/<pre[\s\S]*<\/pre>/);
    const body = preMatch ? preMatch[0] : inner;
    const safeTitle = title.replace(/[<&]/g, (c) => (c === '<' ? '&lt;' : '&amp;'));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${safeTitle}</title>
<style>
  html, body { margin: 0; padding: 0; background: ${TERM_BG}; color: ${TERM_FG}; }
  body { padding: 16px; font-family: "JetBrains Mono", Consolas, "Cascadia Mono", Menlo, monospace; font-size: 13px; line-height: 1.2; }
  pre { margin: 0; white-space: pre; font: inherit; }
  ::selection { background: ${TERM_LIME}44; }
</style>
</head>
<body>
${body}
</body>
</html>
`;
  }

  destroy() {
    this.destroyed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.resizeObserver?.disconnect();
    this.indicator.stop();
    try {
      this.webgl?.dispose();
    } catch {}
    try {
      this.imageAddon.dispose();
    } catch {}
    try {
      this.ws?.close();
    } catch {}
    this.term.dispose();
    if (this.el.parentElement) this.el.parentElement.removeChild(this.el);
  }

  private connect() {
    if (this.destroyed) return;
    this.setStatus(this.session ? 'reconnecting' : 'connecting');

    let ws: WebSocket;
    try {
      ws = new WebSocket(this.api.wsUrl(this.sessionId));
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectDelay = 500;
      // Clear local view so replayed scrollback isn't doubled with what was
      // already on screen from before disconnect.
      this.term.reset();
      this.prevBaseY = 0;
      this.newLinesWhileAway = 0;
      this.updateJumpPill();
      this.send({ type: 'attach', cols: this.term.cols, rows: this.term.rows });
    };

    ws.onmessage = (e) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.type === 'attached') {
        this.session = msg.session;
        // Tag the host with the agent type so the cursor-hiding CSS rules
        // (which only fire for Claude — see styles.css) can disambiguate.
        // Copilot CLI relies on xterm's native cursor to show where input
        // lands; Claude draws its own inline reverse-video block.
        this.el.dataset.agent = msg.session.agentType ?? 'claude';
        if (msg.scrollback) {
          // Suppress the jump-pill new-line counter while we replay the
          // server's scrollback ring — otherwise every reconnect would
          // show "N new lines" for content the user has already seen.
          this.replayingScrollback = true;
          this.term.write(msg.scrollback, () => {
            this.replayingScrollback = false;
            this.prevBaseY = this.term.buffer.active.baseY;
            this.newLinesWhileAway = 0;
            this.updateJumpPill();
          });
        }
        this.setStatus(msg.session.alive ? 'live' : 'exited');
        this.setActivity(msg.session.activity ?? 'unknown');
        this.events.title?.(msg.session.title);
      } else if (msg.type === 'output') {
        this.term.write(msg.data);
      } else if (msg.type === 'activity') {
        this.setActivity(msg.activity);
      } else if (msg.type === 'exit') {
        this.term.write(`\r\n\x1b[2m[process exited: ${msg.code}]\x1b[0m\r\n`);
        this.setStatus('exited');
        this.setActivity('unknown');
      } else if (msg.type === 'error') {
        this.term.write(`\r\n\x1b[31m[error: ${msg.message}]\x1b[0m\r\n`);
        this.setStatus('error');
      }
    };

    ws.onclose = () => {
      this.ws = null;
      if (this.destroyed) return;
      if (this._status === 'exited') return; // session is gone, don't retry
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      try {
        ws.close();
      } catch {}
    };
  }

  private scheduleReconnect() {
    if (this.destroyed) return;
    this.setStatus('reconnecting');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 5000);
  }

  /** Recompute jump-pill visibility + delta count off the current buffer.
   *  Called from xterm's onScroll (which covers both user scroll and buffer
   *  growth) plus a few explicit reset points (reconnect, click). */
  private onScroll() {
    const buf = this.term.buffer.active;
    const baseY = buf.baseY;
    const viewportY = buf.viewportY;
    const atBottom = viewportY >= baseY;
    const grew = baseY - this.prevBaseY;
    this.prevBaseY = baseY;
    if (!this.replayingScrollback && !atBottom && grew > 0) {
      // Cap to avoid the counter ballooning if a massive paste comes in.
      this.newLinesWhileAway = Math.min(this.newLinesWhileAway + grew, 9999);
    }
    if (atBottom) this.newLinesWhileAway = 0;
    this.updateJumpPill();
  }

  private updateJumpPill() {
    const buf = this.term.buffer.active;
    const atBottom = buf.viewportY >= buf.baseY;
    if (atBottom) {
      this.jumpPill.hidden = true;
      this.jumpPillCount.textContent = '';
      return;
    }
    this.jumpPill.hidden = false;
    if (this.newLinesWhileAway > 0) {
      this.jumpPillCount.textContent =
        this.newLinesWhileAway >= 9999 ? '9999+' : String(this.newLinesWhileAway);
      this.jumpPill.dataset.fresh = 'true';
    } else {
      this.jumpPillCount.textContent = '';
      delete this.jumpPill.dataset.fresh;
    }
  }
}

