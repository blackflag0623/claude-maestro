import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import type { ClientMessage, ServerMessage, SessionInfo, SessionActivity } from '../shared/protocol';
import type { MaestroApi } from './api';
import { buildCursorIndicator, type CursorIndicator } from './cursor-indicator';

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
    this.term.open(this.el);
    // WebGL renderer: faster + correct for fast-output / wide-char edge cases
    // that the DOM renderer botches (half-line wraps, missing glyphs). On
    // context loss (GPU sleep, tab restore) we dispose and fall back to DOM.
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

    // Paste path — single funnel. Both Ctrl/Cmd+V (keyboard) and the DOM
    // `paste` event (right-click, middle-click on Linux, IME paste) call
    // `pasteText`, which wraps the content in bracketed-paste markers so
    // Claude's TUI treats it as one atomic input. Without the markers, every
    // embedded \n is read as Enter and the prompt submits partway. The two
    // entry points coordinate via `lastPasteAt` to avoid double-firing when
    // the browser delivers a `paste` event in response to Ctrl+V.
    this.term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key.toLowerCase() === 'v') {
        // Read explicitly — relying on the synthesized `paste` event alone is
        // unreliable across browsers/focus states. The DOM paste listener
        // below will see this timestamp and skip its own read.
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

    // Catch right-click paste / middle-click paste / IME paste. xterm's
    // built-in paste handler is bypassed entirely so there's exactly one
    // bracketed-paste wrapper in the system.
    this.el.addEventListener(
      'paste',
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        // If Ctrl+V fired within the last 250 ms, the keyboard path is
        // already handling this paste — don't double-send.
        if (Date.now() - this.lastPasteAt < 250) return;
        const text = e.clipboardData?.getData('text') ?? '';
        this.pasteText(text);
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
    // Normalize \r\n and bare \r to \n so the TUI sees consistent newlines
    // inside the bracketed-paste span. The TUI will turn the markers back
    // into a single multi-line input.
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

