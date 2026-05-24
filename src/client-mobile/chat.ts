import type {
  ChatMessage,
  ClientMessage,
  ServerMessage,
  SessionInfo,
} from '../shared/protocol';
import { MaestroApi } from '../client/api';
import type { MobileServerEntry } from './mobile-state';

// `marked` is loaded from CDN in index.html as a UMD global. Pulling it via
// `import 'marked'` triggers Vite's optimize-deps pipeline, which has been
// racing against itself on this setup and serving stale 504s. Using the CDN
// global removes Vite from that path entirely.
declare const marked: {
  parse: (s: string) => string;
  setOptions: (o: { gfm?: boolean; breaks?: boolean }) => void;
};

if (typeof marked !== 'undefined') {
  marked.setOptions({ gfm: true, breaks: true });
} else {
  console.warn('[chat] marked global missing — bubbles will fall back to plain text');
}

function renderMarkdown(text: string): string {
  if (typeof marked === 'undefined') {
    // Plain-text fallback: escape and preserve newlines.
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>');
  }
  return marked.parse(text);
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

  root.querySelector<HTMLButtonElement>('#back')!.addEventListener('click', () => {
    try { ws?.close(); } catch {}
    cb.onBack();
  });

  let ws: WebSocket | null = null;
  let inputLocked = true;
  let attached = false;

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
    console.log(`[chat] bubble added (role=${b.role}, len=${b.text.length}); bubblesEl now has ${bubblesEl.children.length} children, scrollHeight=${bubblesEl.scrollHeight}, clientHeight=${bubblesEl.clientHeight}`);
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
    }
  }

  /** Live chatMessage frames may echo a user_text we just sent (transcript
   *  flush picks up both user and assistant entries from the same Stop event).
   *  We render the user bubble locally on send for instant feedback, so drop
   *  live user_text frames that match a recent local send to avoid dupes. */
  const recentSent: string[] = [];
  function onLiveChatMessage(m: ChatMessage) {
    console.log('[chat] live msg', m.type, JSON.stringify(m).slice(0, 200));
    if (m.type === 'user_text') {
      const idx = recentSent.indexOf(m.text);
      if (idx >= 0) {
        console.log('[chat] suppressed echo of locally-sent text');
        recentSent.splice(idx, 1);
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
    console.log('[chat] connecting to', url);
    ws = new WebSocket(url);
    ws.addEventListener('open', () => {
      console.log('[chat] ws open, sending attachChat');
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
        console.warn('[chat] bad frame', ev.data);
        return;
      }
      console.log('[chat] <-', msg.type, msg);
      onServerMessage(msg);
    });
    ws.addEventListener('close', (ev) => {
      console.log('[chat] ws close', ev.code, ev.reason);
      if (!attached) {
        setStatus(`closed before attach (code ${ev.code})`);
        lockInput('connection closed — reload to retry');
        return;
      }
      setStatus('disconnected');
      lockInput('disconnected — reload to retry');
    });
    ws.addEventListener('error', (ev) => {
      console.error('[chat] ws error', ev);
      setStatus('error');
    });
  }

  function onServerMessage(msg: ServerMessage) {
    if (msg.type === 'error') {
      attached = false;
      if (msg.code === 'chatLocked') {
        renderLocked();
      } else {
        setStatus('error');
        addSystem(`error: ${msg.message}`);
      }
      return;
    }
    if (msg.type === 'chatAttached') {
      attached = true;
      titleEl.textContent = msg.session.title;
      setStatus(sessionStatusLabel(msg.session));
      for (const m of msg.history) applyAssistantMessage(m);
      // Treat any prior history as a signal that input is ok. If there is no
      // history, also unlock — Claude is initializing but we accept queued input.
      unlockInput();
      return;
    }
    if (msg.type === 'chatMessage') {
      onLiveChatMessage(msg.message);
      unlockInput();
      return;
    }
    if (msg.type === 'activity') {
      setStatus(msg.activity);
      if (msg.activity === 'working') {
        lockInput('Claude is working…');
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
    recentSent.push(text);
    if (recentSent.length > 16) recentSent.shift();
    const msg: ClientMessage = { type: 'input', data: text + '\r' };
    try {
      ws?.send(JSON.stringify(msg));
    } catch {
      setStatus('send failed');
      return;
    }
    inputEl.value = '';
    autosize();
    // Lock until Claude responds. Activity 'working' will keep it locked;
    // a chatMessage will unlock.
    lockInput('Claude is working…');
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
