import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import { SerializeAddon } from '@xterm/addon-serialize';
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
        cursor: TERM_BG,
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
        if (msg.scrollback) this.term.write(msg.scrollback);
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
}

