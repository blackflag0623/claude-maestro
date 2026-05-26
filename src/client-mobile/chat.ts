import type {
  AgentType,
  ChatMessage,
  ChatMode,
  ClientMessage,
  ServerMessage,
  SessionInfo,
} from '../shared/protocol';
import { ASK_UQ_ANSWER_PREFIX } from '../shared/protocol';
import { MaestroApi } from '../client-shared/api';
import { debug } from '../client-shared/debug';
import { escapeHtml } from '../client-shared/html';
import { agentShort } from '../client-shared/agent-labels';
import type { MobileServerEntry } from './mobile-state';

// SECURITY: marked's output is HTML that may contain script tags or `on*`
// attributes if a transcript ever contained crafted text (e.g. a prompt-
// injection from a file Claude was asked to summarize). Always pipe marked
// output through DOMPurify before assigning to innerHTML.
declare const marked: {
  parse: (s: string) => string;
  setOptions: (o: { gfm?: boolean; breaks?: boolean }) => void;
};
declare const DOMPurify: {
  sanitize: (dirty: string, cfg?: Record<string, unknown>) => string;
};

if (typeof marked !== 'undefined') {
  marked.setOptions({ gfm: true, breaks: true });
} else {
  debug('[chat] marked global missing — bubbles will fall back to plain text');
}
if (typeof DOMPurify === 'undefined') {
  debug('[chat] DOMPurify global missing — markdown will be rendered as escaped plain text for safety');
}

function renderMarkdown(text: string): string {
  // Always-safe fallback when either CDN script failed to load.
  const plain = () => escapeHtml(text).replace(/\n/g, '<br>');

  if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') {
    return plain();
  }
  const dirty = marked.parse(text);
  return DOMPurify.sanitize(dirty);
}

interface ChatBubble {
  role: 'user' | 'assistant';
  text: string;
  ts: number;
}

export interface ChatCallbacks {
  onBack: () => void;
}

export function renderChat(
  root: HTMLElement,
  server: MobileServerEntry,
  sessionId: string,
  cb: ChatCallbacks,
) {
  const api = new MaestroApi(server.baseUrl);

  root.innerHTML = `
    <header class="topbar">
      <button class="topbar__back" id="back" aria-label="back">‹</button>
      <span class="topbar__title" id="t-title">…</span>
      <button class="mode-toggle" id="mode-toggle" data-mode="auto" aria-label="pause mode">
        <span class="mode-toggle__icon">→</span>
        <span class="mode-toggle__label">auto</span>
      </button>
      <span class="topbar__hint" id="t-status">connecting…</span>
    </header>
    <main class="chat">
      <ul class="bubbles" id="bubbles"></ul>
    </main>
    <footer class="composer">
      <textarea
        class="composer__input"
        id="composer"
        rows="1"
        placeholder="connecting…"
        disabled
        autocomplete="off"
        autocorrect="on"
        autocapitalize="sentences"
        spellcheck="true"
      ></textarea>
      <button class="btn btn--send" id="send" disabled>send</button>
    </footer>
  `;

  const bubblesEl = root.querySelector<HTMLUListElement>('#bubbles')!;
  const statusEl = root.querySelector<HTMLSpanElement>('#t-status')!;
  const titleEl = root.querySelector<HTMLSpanElement>('#t-title')!;
  const inputEl = root.querySelector<HTMLTextAreaElement>('#composer')!;
  const sendBtn = root.querySelector<HTMLButtonElement>('#send')!;
  const modeBtn = root.querySelector<HTMLButtonElement>('#mode-toggle')!;

  root.querySelector<HTMLButtonElement>('#back')!.addEventListener('click', () => {
    try { ws?.close(); } catch {}
    cb.onBack();
  });

  let ws: WebSocket | null = null;
  let inputLocked = true;
  let attached = false;
  let agentType: AgentType = 'claude';

  const workingMsg = () => `${agentShort(agentType)} is working…`;

  function setStatus(text: string) {
    statusEl.textContent = text;
  }
  function lockInput(reason: string) {
    inputLocked = true;
    inputEl.disabled = true;
    sendBtn.disabled = true;
    inputEl.placeholder = reason;
  }
  function unlockInput() {
    inputLocked = false;
    inputEl.disabled = false;
    sendBtn.disabled = inputEl.value.trim().length === 0;
    inputEl.placeholder = 'message…';
  }

  function addBubble(b: ChatBubble) {
    const li = document.createElement('li');
    li.className = `bubble bubble--${b.role}`;
    const body = document.createElement('div');
    body.className = 'bubble__body';
    if (b.role === 'assistant') {
      body.innerHTML = renderMarkdown(b.text);
    } else {
      body.textContent = b.text;
    }
    li.appendChild(body);
    bubblesEl.appendChild(li);
    debug(`[chat] bubble added (role=${b.role}, len=${b.text.length}); bubblesEl now has ${bubblesEl.children.length} children, scrollHeight=${bubblesEl.scrollHeight}, clientHeight=${bubblesEl.clientHeight}`);
    // Keep latest in view after layout.
    requestAnimationFrame(() => {
      bubblesEl.scrollTop = bubblesEl.scrollHeight;
    });
  }

  function applyAssistantMessage(m: ChatMessage) {
    if (m.type === 'assistant_text') {
      addBubble({ role: 'assistant', text: m.text, ts: m.ts });
    } else if (m.type === 'user_text') {
      // History replay: render user's prior message bubbles.
      addBubble({ role: 'user', text: m.text, ts: m.ts });
    } else if (m.type === 'tool_call') {
      applyToolCall(m);
    }
  }

  // ───────── chat mode toggle ─────────

  let currentMode: ChatMode = 'auto';
  const MODE_ORDER: ChatMode[] = ['auto', 'pause-next', 'always-pause'];
  const MODE_LABEL: Record<ChatMode, { icon: string; text: string }> = {
    auto: { icon: '→', text: 'auto' },
    'pause-next': { icon: '⏸', text: 'pause 1' },
    'always-pause': { icon: '⏸⏸', text: 'pause all' },
  };
  function applyMode(m: ChatMode) {
    currentMode = m;
    modeBtn.dataset.mode = m;
    const iconEl = modeBtn.querySelector('.mode-toggle__icon');
    const labelEl = modeBtn.querySelector('.mode-toggle__label');
    if (iconEl) iconEl.textContent = MODE_LABEL[m].icon;
    if (labelEl) labelEl.textContent = MODE_LABEL[m].text;
  }
  modeBtn.addEventListener('click', () => {
    const next = MODE_ORDER[(MODE_ORDER.indexOf(currentMode) + 1) % MODE_ORDER.length]!;
    applyMode(next);
    const msg: ClientMessage = { type: 'setChatMode', mode: next };
    try { ws?.send(JSON.stringify(msg)); } catch {}
  });

  // ───────── tool_call bubbles ─────────
  //
  // Keyed by toolCallId so a status-update message replaces the existing
  // bubble in-place instead of stacking another.
  const toolBubbles = new Map<string, HTMLElement>();

  function formatToolInput(input: unknown): string {
    if (input === null || input === undefined) return '';
    if (typeof input === 'string') return input;
    try { return JSON.stringify(input, null, 2); } catch { return String(input); }
  }

  /** Per-tool summary body. Falls back to JSON for unknown tools. */
  function renderToolSummary(toolName: string, input: unknown): string {
    const inp = (input ?? {}) as Record<string, unknown>;
    const code = (s: string) => `<code>${escapeHtml(s)}</code>`;
    const pre = (s: string) => `<pre class="bubble__tool-params">${escapeHtml(s)}</pre>`;
    const trunc = (s: string, n = 600) => (s.length > n ? s.slice(0, n) + '…' : s);

    switch (toolName) {
      case 'Bash': {
        const cmd = String(inp.command ?? '');
        const desc = inp.description ? String(inp.description) : '';
        return `${desc ? `<p class="bubble__tool-desc">${escapeHtml(desc)}</p>` : ''}${pre(trunc(cmd, 1200))}`;
      }
      case 'Read': {
        const p = String(inp.file_path ?? '');
        const offset = inp.offset != null ? `, offset=${inp.offset}` : '';
        const limit = inp.limit != null ? `, limit=${inp.limit}` : '';
        return `<p class="bubble__tool-path">${code(p)}${escapeHtml(offset + limit)}</p>`;
      }
      case 'Write': {
        const p = String(inp.file_path ?? '');
        const content = String(inp.content ?? '');
        const sizeKb = (content.length / 1024).toFixed(1);
        return `<p class="bubble__tool-path">${code(p)} <small>(${sizeKb} KB)</small></p>${pre(trunc(content))}`;
      }
      case 'Edit': {
        const p = String(inp.file_path ?? '');
        const oldS = String(inp.old_string ?? '');
        const newS = String(inp.new_string ?? '');
        return `<p class="bubble__tool-path">${code(p)}</p>
          <p class="bubble__tool-diff-label">- old:</p>${pre(trunc(oldS, 400))}
          <p class="bubble__tool-diff-label">+ new:</p>${pre(trunc(newS, 400))}`;
      }
      case 'Glob': {
        const pattern = String(inp.pattern ?? '');
        const path = inp.path ? ` in ${code(String(inp.path))}` : '';
        return `<p>${code(pattern)}${path}</p>`;
      }
      case 'Grep': {
        const pattern = String(inp.pattern ?? '');
        const path = inp.path ? ` in ${code(String(inp.path))}` : '';
        const glob = inp.glob ? ` (glob ${code(String(inp.glob))})` : '';
        return `<p>${code(pattern)}${path}${glob}</p>`;
      }
      case 'TodoWrite': {
        const todos = Array.isArray(inp.todos) ? (inp.todos as Array<Record<string, unknown>>) : [];
        if (todos.length === 0) return '<p><em>empty todo list</em></p>';
        const items = todos.map((t) => {
          const status = String(t.status ?? '');
          const icon = status === 'completed' ? '✓' : status === 'in_progress' ? '→' : '·';
          return `<li>${escapeHtml(icon)} ${escapeHtml(String(t.content ?? ''))}</li>`;
        }).join('');
        return `<ul class="bubble__tool-todos">${items}</ul>`;
      }
      case 'AskUserQuestion': {
        const questions = Array.isArray(inp.questions) ? (inp.questions as Array<Record<string, unknown>>) : [];
        if (questions.length === 0) return '<p><em>(no questions)</em></p>';
        return questions.map((q) => {
          const text = escapeHtml(String(q.question ?? ''));
          const header = q.header ? `<span class="bubble__tool-qheader">${escapeHtml(String(q.header))}</span>` : '';
          return `<p class="bubble__tool-question">${header}${text}</p>`;
        }).join('');
      }
      default:
        return pre(formatToolInput(input));
    }
  }

  function renderToolBubble(li: HTMLElement, m: Extract<ChatMessage, { type: 'tool_call' }>) {
    li.className = `bubble bubble--tool bubble--tool-${m.status}`;
    const summary = renderToolSummary(m.toolName, m.toolInput);
    li.innerHTML = `
      <div class="bubble__tool-head">
        <span class="bubble__tool-name">${escapeHtml(m.toolName)}</span>
        <span class="bubble__tool-status">${m.status}</span>
      </div>
      <div class="bubble__tool-summary">${summary}</div>
    `;
    if (m.toolName === 'AskUserQuestion' && m.status === 'pending') {
      attachAskUserQuestionUI(li, m);
      return;
    }
    if (m.status === 'pending') {
      const actions = document.createElement('div');
      actions.className = 'bubble__tool-actions';
      const allowBtn = document.createElement('button');
      allowBtn.className = 'btn btn--allow';
      allowBtn.textContent = 'allow';
      const denyBtn = document.createElement('button');
      denyBtn.className = 'btn btn--deny';
      denyBtn.textContent = 'deny';
      const reasonEl = document.createElement('input');
      reasonEl.className = 'bubble__tool-deny-reason';
      reasonEl.placeholder = 'reason (optional)';
      reasonEl.type = 'text';
      actions.append(allowBtn, denyBtn, reasonEl);
      li.appendChild(actions);
      const decide = (decision: 'allow' | 'deny') => {
        const reason = decision === 'deny' ? reasonEl.value.trim() || undefined : undefined;
        const msg: ClientMessage = { type: 'toolDecision', toolCallId: m.toolCallId, decision, reason };
        try { ws?.send(JSON.stringify(msg)); } catch {}
        allowBtn.disabled = true;
        denyBtn.disabled = true;
        reasonEl.disabled = true;
      };
      allowBtn.addEventListener('click', () => decide('allow'));
      denyBtn.addEventListener('click', () => decide('deny'));
    }
    if (m.status === 'denied' && m.denyReason) {
      const reasonNote = document.createElement('p');
      reasonNote.className = 'bubble__tool-reason';
      reasonNote.textContent = m.denyReason;
      li.appendChild(reasonNote);
    }
    if (m.status === 'answered' && m.denyReason) {
      const ans = document.createElement('p');
      ans.className = 'bubble__askuq-answer';
      ans.textContent = m.denyReason;
      li.appendChild(ans);
    }
  }

  /** AskUserQuestion option picker. Sends a `toolDecision` with deny+reason
   *  prefixed by ASK_UQ_ANSWER_PREFIX — the server uses that as the signal to
   *  translate it back to Claude as user feedback. */
  function attachAskUserQuestionUI(li: HTMLElement, m: Extract<ChatMessage, { type: 'tool_call' }>) {
    const inp = (m.toolInput ?? {}) as Record<string, unknown>;
    const questions = Array.isArray(inp.questions) ? (inp.questions as Array<Record<string, unknown>>) : [];
    const wrap = document.createElement('div');
    wrap.className = 'bubble__askuq';

    const answers: Array<string | null> = questions.map(() => null);
    const customInputs: HTMLInputElement[] = [];

    const finish = () => {
      const parts: string[] = [];
      for (let i = 0; i < questions.length; i++) {
        const q = questions[i] as Record<string, unknown>;
        const qHeader = q.header ? String(q.header) : `Q${i + 1}`;
        const ans = answers[i];
        const custom = customInputs[i]?.value.trim();
        if (custom) parts.push(`${qHeader}: ${custom}`);
        else if (ans) parts.push(`${qHeader}: ${ans}`);
        else parts.push(`${qHeader}: (no answer)`);
      }
      const reason = `${ASK_UQ_ANSWER_PREFIX}${parts.join(' | ')}`;
      const msg: ClientMessage = { type: 'toolDecision', toolCallId: m.toolCallId, decision: 'deny', reason };
      try { ws?.send(JSON.stringify(msg)); } catch {}
      wrap.querySelectorAll<HTMLButtonElement>('button').forEach((b) => (b.disabled = true));
      wrap.querySelectorAll<HTMLInputElement>('input').forEach((i) => (i.disabled = true));
    };

    questions.forEach((q, qi) => {
      const opts = Array.isArray(q.options) ? (q.options as Array<Record<string, unknown>>) : [];
      const optWrap = document.createElement('div');
      optWrap.className = 'bubble__askuq-options';
      opts.forEach((opt) => {
        const label = String(opt.label ?? '');
        const desc = opt.description ? String(opt.description) : '';
        const btn = document.createElement('button');
        btn.className = 'btn bubble__askuq-option';
        btn.innerHTML = `<span class="bubble__askuq-label">${escapeHtml(label)}</span>${desc ? `<span class="bubble__askuq-desc">${escapeHtml(desc)}</span>` : ''}`;
        btn.addEventListener('click', () => {
          answers[qi] = label;
          optWrap.querySelectorAll('.bubble__askuq-option').forEach((b) => b.classList.remove('is-chosen'));
          btn.classList.add('is-chosen');
        });
        optWrap.appendChild(btn);
      });
      const custom = document.createElement('input');
      custom.className = 'bubble__askuq-custom';
      custom.type = 'text';
      custom.placeholder = 'or type your own answer…';
      customInputs.push(custom);
      optWrap.appendChild(custom);
      wrap.appendChild(optWrap);
    });

    const submit = document.createElement('button');
    submit.className = 'btn btn--allow bubble__askuq-submit';
    submit.textContent = 'send answer';
    submit.addEventListener('click', finish);
    wrap.appendChild(submit);

    li.appendChild(wrap);
  }

  function applyToolCall(m: Extract<ChatMessage, { type: 'tool_call' }>) {
    let li = toolBubbles.get(m.toolCallId);
    if (!li) {
      li = document.createElement('li');
      toolBubbles.set(m.toolCallId, li);
      bubblesEl.appendChild(li);
    }
    renderToolBubble(li, m);
    requestAnimationFrame(() => {
      bubblesEl.scrollTop = bubblesEl.scrollHeight;
    });
  }

  /** Live chatMessage frames may echo a user_text we just sent (transcript
   *  flush picks up both user and assistant entries from the same Stop event).
   *  We render the user bubble locally on send for instant feedback, so drop
   *  live user_text frames that match a recent local send to avoid dupes.
   *
   *  Matching is whitespace-normalized: Claude's transcript writer occasionally
   *  trims trailing newlines or normalizes line endings, which would make a
   *  strict-equality compare miss the echo.
   *
   *  Each entry expires after RECENT_SENT_TTL_MS. Without expiry, a user who
   *  sends the same word twice (e.g. "yes") would have the second send's echo
   *  swallowed by the first send's leftover. */
  const RECENT_SENT_TTL_MS = 30_000;
  const RECENT_SENT_MAX = 32;
  interface RecentSend { norm: string; ts: number }
  const recentSent: RecentSend[] = [];
  const normalizeForEcho = (s: string) => s.replace(/\s+$/g, '').replace(/\r\n/g, '\n');
  function trackSent(text: string) {
    recentSent.push({ norm: normalizeForEcho(text), ts: Date.now() });
    if (recentSent.length > RECENT_SENT_MAX) recentSent.shift();
  }
  function consumeEcho(text: string): boolean {
    const cutoff = Date.now() - RECENT_SENT_TTL_MS;
    // Drop expired entries from the head.
    while (recentSent.length > 0 && recentSent[0]!.ts < cutoff) recentSent.shift();
    const norm = normalizeForEcho(text);
    const idx = recentSent.findIndex((r) => r.norm === norm);
    if (idx < 0) return false;
    recentSent.splice(idx, 1);
    return true;
  }

  function onLiveChatMessage(m: ChatMessage) {
    debug('[chat] live msg', m.type, JSON.stringify(m).slice(0, 200));
    if (m.type === 'user_text') {
      if (consumeEcho(m.text)) {
        debug('[chat] suppressed echo of locally-sent text');
        return;
      }
      addBubble({ role: 'user', text: m.text, ts: m.ts });
      return;
    }
    applyAssistantMessage(m);
  }

  function connect() {
    setStatus('connecting…');
    lockInput('connecting…');
    const url = api.wsUrl(sessionId);
    debug('[chat] connecting to', url);
    ws = new WebSocket(url);
    ws.addEventListener('open', () => {
      debug('[chat] ws open, sending attachChat');
      setStatus('attaching…');
      const attachMsg: ClientMessage = {
        type: 'attachChat',
        cols: 120,
        rows: 30,
      };
      ws!.send(JSON.stringify(attachMsg));
    });
    ws.addEventListener('message', (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(ev.data as string);
      } catch {
        debug('[chat] bad frame', ev.data);
        return;
      }
      debug('[chat] <-', msg.type, msg);
      onServerMessage(msg);
    });
    ws.addEventListener('close', (ev) => {
      debug('[chat] ws close', ev.code, ev.reason);
      if (!attached) {
        setStatus(`closed before attach (code ${ev.code})`);
        lockInput('connection closed — reload to retry');
        return;
      }
      setStatus('disconnected');
      lockInput('disconnected — reload to retry');
    });
    ws.addEventListener('error', (ev) => {
      debug('[chat] ws error', ev);
      setStatus('error');
    });
  }

  function onServerMessage(msg: ServerMessage) {
    if (msg.type === 'error') {
      attached = false;
      if (msg.code === 'chatLocked') {
        renderLocked();
      } else if (msg.code === 'chatNotSupported') {
        renderUnsupported(msg.message);
      } else {
        setStatus('error');
        addSystem(`error: ${msg.message}`);
      }
      return;
    }
    if (msg.type === 'chatAttached') {
      attached = true;
      agentType = msg.session.agentType ?? 'claude';
      titleEl.textContent = msg.session.title;
      setStatus(sessionStatusLabel(msg.session));
      applyMode(msg.mode);
      for (const m of msg.history) applyAssistantMessage(m);
      // Treat any prior history as a signal that input is ok. If there is no
      // history, also unlock — the agent is initializing but we accept queued
      // input.
      unlockInput();
      return;
    }
    if (msg.type === 'chatMode') {
      applyMode(msg.mode);
      return;
    }
    if (msg.type === 'chatMessage') {
      onLiveChatMessage(msg.message);
      // Tool_call status updates shouldn't toggle the lock — Claude isn't
      // necessarily done thinking. Only text replies unlock.
      if (msg.message.type === 'assistant_text' || msg.message.type === 'user_text') {
        unlockInput();
      }
      return;
    }
    if (msg.type === 'activity') {
      setStatus(msg.activity);
      if (msg.activity === 'working') {
        lockInput(workingMsg());
      } else {
        // Idle, waiting, or unknown — let the user type.
        unlockInput();
      }
      return;
    }
    if (msg.type === 'exit') {
      setStatus(`exited (code ${msg.code ?? '?'})`);
      lockInput('session ended');
      attached = false;
    }
  }

  function renderLocked() {
    root.innerHTML = `
      <header class="topbar">
        <button class="topbar__back" id="back" aria-label="back">‹</button>
        <span class="topbar__title">locked</span>
      </header>
      <main class="screen">
        <p class="hint hint--err">
          another client is connected to this session.<br/>
          close it (e.g. the desktop tab) and try again.
        </p>
        <button class="btn btn--primary" id="retry">retry</button>
      </main>
    `;
    root.querySelector<HTMLButtonElement>('#back')!.addEventListener('click', () => cb.onBack());
    root.querySelector<HTMLButtonElement>('#retry')!.addEventListener('click', () => {
      // Re-render this view; cheapest way is a navigation event back through the router.
      renderChat(root, server, sessionId, cb);
    });
  }

  function renderUnsupported(msg: string) {
    try { ws?.close(); } catch {}
    root.innerHTML = `
      <header class="topbar">
        <button class="topbar__back" id="back" aria-label="back">‹</button>
        <span class="topbar__title">chat unavailable</span>
      </header>
      <main class="screen">
        <p class="hint hint--err">
          this agent does not expose a structured chat transcript yet, so the
          mobile chat view cannot render its conversation.<br/><br/>
          open this session from the desktop terminal portal to interact with
          it directly.
        </p>
        <p class="hint">server said: ${escapeHtml(msg)}</p>
      </main>
    `;
    root.querySelector<HTMLButtonElement>('#back')!.addEventListener('click', () => cb.onBack());
  }

  function addSystem(text: string) {
    const li = document.createElement('li');
    li.className = 'bubble bubble--system';
    li.textContent = text;
    bubblesEl.appendChild(li);
  }

  function sessionStatusLabel(s: SessionInfo): string {
    return s.alive ? s.activity : 'dormant';
  }

  function send() {
    if (inputLocked) return;
    const text = inputEl.value;
    if (!text.trim()) return;
    addBubble({ role: 'user', text, ts: Date.now() });
    // Remember the exact text so the transcript flush echo doesn't duplicate it.
    trackSent(text);
    // Multi-line input must be wrapped in bracketed-paste markers (CSI ?2004h)
    // so claude doesn't treat each embedded LF as a turn-submit. Single-line
    // input keeps the plain `text + \r` path because brackets would leak as
    // literal characters if claude has temporarily disabled paste mode (rare
    // but possible during certain tool runs).
    const data = text.includes('\n')
      ? `\x1b[200~${text}\x1b[201~\r`
      : `${text}\r`;
    const msg: ClientMessage = { type: 'input', data };
    try {
      ws?.send(JSON.stringify(msg));
    } catch {
      setStatus('send failed');
      return;
    }
    inputEl.value = '';
    autosize();
    // Lock until the agent responds. Activity 'working' will keep it locked;
    // a chatMessage will unlock.
    lockInput(workingMsg());
  }

  function autosize() {
    inputEl.style.height = 'auto';
    const cap = Math.min(window.innerHeight * 0.4, 240);
    inputEl.style.height = Math.min(inputEl.scrollHeight, cap) + 'px';
    sendBtn.disabled = inputLocked || inputEl.value.trim().length === 0;
  }

  inputEl.addEventListener('input', autosize);
  inputEl.addEventListener('keydown', (ev) => {
    // On iOS, Enter without modifier inserts a newline (good for dictation).
    // Cmd/Ctrl+Enter sends.
    if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
      ev.preventDefault();
      send();
    }
  });
  sendBtn.addEventListener('click', send);

  connect();
}
