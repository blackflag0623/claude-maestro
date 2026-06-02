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
import { debug } from '../client-shared/debug';
import { buildCursorIndicator, type CursorIndicator } from './cursor-indicator';
import { buildSearchOverlay, type SearchOverlay } from './search-overlay';

/** Scan a chunk of terminal output for alt-screen-buffer toggle escape
 *  sequences. Returns an array describing each toggle found, suitable for
 *  logging via `debug()`. Used to diagnose "why doesn't my wheel scroll
 *  work?" reports: Copilot CLI and Claude TUIs flip between the normal and
 *  alternate buffers at non-obvious moments (e.g. during resume replay),
 *  and the wheel-translation handler only fires for the alternate buffer. */
function scanForAltToggles(s: string): string[] {
  const out: string[] = [];
  // CSI ? <n> h|l where n is one of 47, 1047, 1049.
  const re = /\x1b\[\?(47|1047|1049)([hl])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    out.push(`?${m[1]}${m[2]} (${m[2] === 'h' ? 'enter-alt' : 'leave-alt'})`);
  }
  return out;
}

export type NodeStatus = 'connecting' | 'live' | 'reconnecting' | 'exited' | 'error';

export interface NodeEvents {
  status?: (s: NodeStatus) => void;
  title?: (t: string) => void;
  activity?: (a: SessionActivity) => void;
}

const TERM_BG = '#0a0a0a';
const TERM_FG = '#e8e8e3';
const TERM_LIME = '#c6ff3d';

/** Wheel-handler tuning constants (alt-screen-buffer TUI scroll translation).
 *  See attachCustomWheelEventHandler for the algorithm. Tweaked together —
 *  changing one usually requires re-tuning the others. */
const WHEEL_IDLE_RESET_MS = 10_000; // window before residual accumulator is cleared
const WHEEL_RATE_GATE_MS = 120;     // min ms between successive PgUp/PgDn emissions

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
  // Alt-buffer wheel-translation state (see attachCustomWheelEventHandler):
  // accumulator + rate gate + idle reset together fix the "one wheel notch
  // jumps N pages" problem for Copilot CLI and other paginated TUIs.
  private wheelAccum = 0;
  private wheelLastEmit = 0;
  private wheelLastSeen = 0;
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

    // Diagnostic: log when xterm flips between normal and alternate
    // buffers. The wheel-translation handler in this file only intercepts
    // wheel events when the active buffer is the alternate one — so
    // knowing exactly when a Copilot/Claude TUI enters or leaves alt mode
    // is essential when debugging "scroll wheel doesn't work" reports.
    this.term.buffer.onBufferChange((b) => {
      debug('[node]', this.sessionId, 'buffer-change ->', b.type, {
        baseY: b.baseY,
        viewportY: b.viewportY,
        length: b.length,
        cursorX: b.cursorX,
        cursorY: b.cursorY,
      });
    });

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
    // Alt-screen-buffer wheel translation.
    //
    // Apps that take over the alt screen (Copilot CLI, Claude Code's TUI in
    // some modes, vim, less, htop) own their own scrollback — xterm's
    // viewport buffer has no history to scroll. Without translation, the
    // mouse wheel is a complete no-op in these apps, which is jarring.
    //
    // We send PgUp / PgDn (NOT arrow keys) because:
    //   - Copilot CLI reserves ↑/↓ for input-history navigation and uses
    //     PgUp/PgDn for timeline scroll. Arrow keys here mis-trigger
    //     prompt-history editing instead of scrolling.
    //   - vim / less / man / htop all accept PgUp/PgDn for "scroll a page".
    //
    // Granularity is the hard part. Copilot has *no* line-by-line scroll —
    // PgUp/PgDn is the only timeline-scroll affordance, and one keypress
    // moves a full screen. A naive "1 wheel event = 1 PgUp" implementation
    // is unusable on trackpads: a single inertial fling fires 20-50 wheel
    // events in a few hundred ms and shoots the user past the top of the
    // buffer.
    //
    // The handler combines three guards:
    //   1. **Accumulator**: small wheel deltas are summed until they reach
    //      a per-page threshold, then one PgUp/PgDn is emitted. A tiny
    //      single click doesn't immediately jump a page — the user has to
    //      scroll roughly one screen's worth before anything moves.
    //   2. **Rate gate**: at most one emission per ~120ms, regardless of
    //      how many events fire in that window. Caps trackpad flings at
    //      ~8 pages/sec.
    //   3. **Idle reset + bound**: the accumulator resets on direction
    //      change or after 800ms of no scroll, and is clamped to ±2 pages
    //      so an overshooting fling can't queue a long tail of page jumps
    //      that fire after the user's hand has left the trackpad.
    this.term.attachCustomWheelEventHandler((e) => {
      const bufType = this.term.buffer.active.type;
      if (bufType !== 'alternate') {
        // Native xterm scroll handles this. Log so users can see *why* a
        // wheel event wasn't translated (common cause of "I'm in Copilot
        // CLI but the wheel does nothing useful" reports — Copilot may
        // still be writing into the normal buffer during resume replay,
        // before it ever issues `CSI ?1049h`).
        debug('[node]', this.sessionId, 'wheel: pass-through (normal buffer)', {
          deltaY: e.deltaY,
          deltaMode: e.deltaMode,
          baseY: this.term.buffer.active.baseY,
          viewportY: this.term.buffer.active.viewportY,
          length: this.term.buffer.active.length,
        });
        return true;
      }
      if (e.ctrlKey || e.altKey || e.metaKey) {
        debug('[node]', this.sessionId, 'wheel: modifier held, skip translation', {
          ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey,
        });
        return true; // leave room for zoom etc.
      }
      if (e.deltaY === 0) {
        debug('[node]', this.sessionId, 'wheel: deltaY=0 (horizontal), pass-through');
        return true;
      }

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

      const now = Date.now();
      const accumBefore = this.wheelAccum;
      let resetReason: 'idle' | 'direction' | null = null;
      // Idle reset: if the user paused for a very long time, residual
      // accumulation from a previous fling shouldn't carry over and cause a
      // surprise page jump on the next wheel touch. The window must be long
      // enough that a *deliberate* clicky-mouse-wheel user (one notch every
      // ~few seconds) still accumulates progress — earlier tunings at 800 ms
      // and 2500 ms were both too aggressive and made slow scrolling almost
      // silent (each notch reset to 0 before the next arrived, so the
      // accumulator never crossed threshold). The direction-change reset
      // below is the real safety net against stale carry-over.
      if (now - this.wheelLastSeen > WHEEL_IDLE_RESET_MS) {
        if (this.wheelAccum !== 0) resetReason = 'idle';
        this.wheelAccum = 0;
      }
      // Direction change clears accumulator so reversal feels responsive.
      if (this.wheelAccum !== 0 && Math.sign(lines) !== Math.sign(this.wheelAccum)) {
        resetReason = 'direction';
        this.wheelAccum = 0;
      }
      this.wheelAccum += lines;
      this.wheelLastSeen = now;

      // Threshold = how many "lines" of accumulated wheel delta correspond
      // to one PgUp/PgDn emission. Lower = more responsive single-burst (you
      // see Copilot move after fewer notches) AND more emissions per long
      // burst (so a 20-notch fling produces multiple progressive page jumps
      // instead of one delayed teleport, which makes "where am I?"
      // disorientation much less likely). Each emission still moves a full
      // Copilot page — we can't change that — but progressive feedback is
      // dramatically better UX than no-movement-then-sudden-page-jump.
      const threshold = Math.max(Math.floor(this.term.rows / 2), 6);
      // Bound the accumulator at ±2 pages so a single fling can never
      // queue more than 1 follow-up page after the initial emission.
      const maxAccum = threshold * 2;
      let clamped = false;
      if (Math.abs(this.wheelAccum) > maxAccum) {
        this.wheelAccum = Math.sign(this.wheelAccum) * maxAccum;
        clamped = true;
      }

      // Not enough accumulated to be worth a page jump — swallow the event
      // but don't emit anything.
      if (Math.abs(this.wheelAccum) < threshold) {
        debug(
          '[node]', this.sessionId,
          `wheel: accumulate ${this.wheelAccum.toFixed(1)}/${threshold}` +
            (resetReason ? ` (reset:${resetReason})` : '') +
            (clamped ? ' (clamped)' : ''),
          {
            deltaY: e.deltaY,
            deltaMode: e.deltaMode,
            lines: +lines.toFixed(2),
            accumBefore: +accumBefore.toFixed(2),
            accumAfter: +this.wheelAccum.toFixed(2),
            threshold,
            clamped,
            resetReason,
            msSinceLastWheel: now - this.wheelLastSeen,
          },
        );
        e.preventDefault();
        return false;
      }
      // Rate gate to keep fling-rate sane.
      if (now - this.wheelLastEmit < WHEEL_RATE_GATE_MS) {
        debug(
          '[node]', this.sessionId,
          `wheel: rate-gated (${now - this.wheelLastEmit}ms < ${WHEEL_RATE_GATE_MS}ms)`,
          {
            accum: +this.wheelAccum.toFixed(2),
            threshold,
          },
        );
        e.preventDefault();
        return false;
      }

      const down = this.wheelAccum > 0;
      this.wheelAccum -= (down ? 1 : -1) * threshold;
      this.wheelLastEmit = now;
      this.send({ type: 'input', data: down ? '\x1b[6~' : '\x1b[5~' });
      debug(
        '[node]', this.sessionId,
        `wheel: EMIT ${down ? 'PgDn' : 'PgUp'}` +
          (resetReason ? ` (reset:${resetReason})` : '') +
          (clamped ? ' (clamped)' : ''),
        {
          deltaY: e.deltaY,
          lines: +lines.toFixed(2),
          accumAfter: +this.wheelAccum.toFixed(2),
          threshold,
          clamped,
          resetReason,
        },
      );
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
      debug('[node]', this.sessionId, 'ws open -> attach', {
        cols: this.term.cols,
        rows: this.term.rows,
      });
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
        const sbLen = msg.scrollback?.length ?? 0;
        const sbToggles = msg.scrollback ? scanForAltToggles(msg.scrollback) : [];
        debug('[node]', this.sessionId, 'attached', {
          agent: msg.session.agentType,
          alive: msg.session.alive,
          activity: msg.session.activity,
          scrollbackBytes: sbLen,
          altToggles: sbToggles,
          bufTypeBeforeReplay: this.term.buffer.active.type,
        });
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
            debug('[node]', this.sessionId, 'scrollback replay done', {
              bufType: this.term.buffer.active.type,
              baseY: this.term.buffer.active.baseY,
              viewportY: this.term.buffer.active.viewportY,
              length: this.term.buffer.active.length,
            });
          });
        }
        this.setStatus(msg.session.alive ? 'live' : 'exited');
        this.setActivity(msg.session.activity ?? 'unknown');
        this.events.title?.(msg.session.title);
      } else if (msg.type === 'output') {
        const toggles = scanForAltToggles(msg.data);
        if (toggles.length > 0) {
          debug('[node]', this.sessionId, 'output: alt-screen toggle', toggles, {
            bytes: msg.data.length,
            bufTypeBefore: this.term.buffer.active.type,
          });
        }
        this.term.write(msg.data);
      } else if (msg.type === 'activity') {
        this.setActivity(msg.activity);
      } else if (msg.type === 'exit') {
        debug('[node]', this.sessionId, 'exit', { code: msg.code });
        this.term.write(`\r\n\x1b[2m[process exited: ${msg.code}]\x1b[0m\r\n`);
        this.setStatus('exited');
        this.setActivity('unknown');
      } else if (msg.type === 'error') {
        debug('[node]', this.sessionId, 'error frame', msg);
        this.term.write(`\r\n\x1b[31m[error: ${msg.message}]\x1b[0m\r\n`);
        this.setStatus('error');
      }
    };

    ws.onclose = () => {
      this.ws = null;
      debug('[node]', this.sessionId, 'ws close', { destroyed: this.destroyed, status: this._status });
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
    debug('[node]', this.sessionId, 'scroll', {
      bufType: buf.type,
      baseY,
      viewportY,
      length: buf.length,
      grew,
      atBottom,
      newLinesWhileAway: this.newLinesWhileAway,
      replayingScrollback: this.replayingScrollback,
    });
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

