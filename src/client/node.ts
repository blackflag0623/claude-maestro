import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
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

/**
 * One Node = one xterm Terminal bound to one server-owned session by id.
 * The Terminal stays mounted (in a host element) for the node's lifetime so
 * scrollback survives switching. WS auto-reconnects with exponential backoff.
 */
export class TerminalNode {
  readonly el: HTMLDivElement;
  readonly term: Terminal;
  private readonly fit = new FitAddon();
  private ws: WebSocket | null = null;
  private reconnectDelay = 500;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private resizeObserver: ResizeObserver | null = null;
  private _status: NodeStatus = 'connecting';
  private _activity: SessionActivity = 'unknown';
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
      // Native cursor is hidden via CSS (see styles.css) so the Claude CLI's
      // in-stream cursor is the sole input indicator.
      cursorBlink: false,
      fontFamily: '"JetBrains Mono", Consolas, "Cascadia Mono", Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      letterSpacing: 0,
      allowProposedApi: true,
      theme: {
        background: '#0a0a0a',
        foreground: '#e8e8e3',
        selectionBackground: '#c6ff3d44',
        black: '#0a0a0a',
        brightBlack: '#3a3a3a',
        red: '#ff5c57',
        brightRed: '#ff6b66',
        green: '#c6ff3d',
        brightGreen: '#d4ff66',
        yellow: '#f3f99d',
        brightYellow: '#f8faa8',
        blue: '#57c7ff',
        brightBlue: '#6bd2ff',
        magenta: '#ff6ac1',
        brightMagenta: '#ff7fcf',
        cyan: '#9aedfe',
        brightCyan: '#b4f1ff',
        white: '#e8e8e3',
        brightWhite: '#ffffff',
      },
    });
    this.term.loadAddon(this.fit);
    this.term.open(this.el);
    this.indicator = buildCursorIndicator();
    this.el.appendChild(this.indicator.el);

    // Ctrl/Cmd+V → fetch from clipboard and send as input.
    // Ctrl/Cmd+C with selection → copy. (See KNOWN_ISSUES.md)
    this.term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key.toLowerCase() === 'v') {
        navigator.clipboard
          .readText()
          .then((text) => text && this.send({ type: 'input', data: text }))
          .catch(() => {});
        return false;
      }
      if (ctrl && e.key.toLowerCase() === 'c' && this.term.hasSelection()) {
        navigator.clipboard.writeText(this.term.getSelection()).catch(() => {});
        return false;
      }
      return true;
    });

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

