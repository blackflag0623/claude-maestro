import type { AgentType, SessionInfo } from '../shared/protocol';
import { AGENT_TYPES } from '../shared/protocol';
import { MaestroApi } from '../client-shared/api';
import { escapeHtml as escape } from '../client-shared/html';
import type { MobileServerEntry } from './mobile-state';

export interface SessionPickerCallbacks {
  onPickSession: (sessionId: string) => void;
  onBack: () => void;
}

function agentLabel(a: AgentType): string {
  return a === 'copilot' ? 'GitHub Copilot CLI' : 'Claude Code';
}

function agentBadge(a: AgentType): string {
  return a === 'copilot' ? 'cop' : 'cla';
}

export function renderSessionPicker(
  root: HTMLElement,
  server: MobileServerEntry,
  cb: SessionPickerCallbacks,
) {
  const api = new MaestroApi(server.baseUrl);

  root.innerHTML = `
    <header class="topbar">
      <button class="topbar__back" id="back" aria-label="back">‹</button>
      <span class="topbar__title">${escape(server.name)}</span>
      <span class="topbar__hint">sessions</span>
    </header>
    <main class="screen">
      <section class="block">
        <h3 class="block__h">resume</h3>
        <ul class="list" id="session-list"><li class="list__empty">loading…</li></ul>
      </section>
      <section class="block">
        <h3 class="block__h">new session</h3>
        <div class="row">
          <select class="input input--select" id="new-agent" aria-label="agent">
            <option value="claude" selected>Claude Code</option>
            <option value="copilot">GitHub Copilot CLI</option>
          </select>
        </div>
        <div class="row">
          <input class="input" id="new-cwd" placeholder="/path/to/repo" spellcheck="false" autocomplete="off" />
          <button class="btn btn--primary" id="new-btn">spawn</button>
        </div>
        <p class="hint" id="err"></p>
      </section>
    </main>
  `;

  const list = root.querySelector<HTMLUListElement>('#session-list')!;
  const errEl = root.querySelector<HTMLParagraphElement>('#err')!;

  root.querySelector<HTMLButtonElement>('#back')!.addEventListener('click', () => cb.onBack());

  async function refresh() {
    try {
      const sessions = await api.list();
      paint(sessions);
    } catch (e) {
      list.innerHTML = `<li class="list__empty">error: ${escape((e as Error).message)}</li>`;
    }
  }

  function paint(sessions: SessionInfo[]) {
    list.innerHTML = '';
    if (!sessions.length) {
      list.innerHTML = '<li class="list__empty">no sessions yet</li>';
      return;
    }
    for (const s of sessions) {
      const li = document.createElement('li');
      li.className = 'list__row';
      const agent = s.agentType ?? 'claude';
      li.innerHTML = `
        <button class="list__main" data-id="${s.id}" data-agent="${agent}">
          <span class="list__title">
            <span class="agent-badge" title="${escape(agentLabel(agent))}">${escape(agentBadge(agent))}</span>
            ${escape(s.title)}
          </span>
          <span class="list__sub">${escape(s.cwd)}</span>
          <span class="list__meta">${s.attached ? 'live' : 'dormant'} · ${s.activity}</span>
        </button>
      `;
      list.appendChild(li);
    }
  }

  list.addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('[data-id]');
    if (!btn) return;
    cb.onPickSession(btn.dataset.id!);
  });

  root.querySelector<HTMLButtonElement>('#new-btn')!.addEventListener('click', async () => {
    const cwd = root.querySelector<HTMLInputElement>('#new-cwd')!.value.trim();
    const rawAgent = root.querySelector<HTMLSelectElement>('#new-agent')!.value;
    const agentType: AgentType = (AGENT_TYPES as readonly string[]).includes(rawAgent)
      ? (rawAgent as AgentType)
      : 'claude';
    if (!cwd) {
      errEl.textContent = 'cwd is required';
      return;
    }
    const btn = root.querySelector<HTMLButtonElement>('#new-btn')!;
    btn.disabled = true;
    errEl.textContent = '';
    try {
      const s = await api.create({ cwd, agentType });
      cb.onPickSession(s.id);
    } catch (e) {
      errEl.textContent = (e as Error).message;
      btn.disabled = false;
    }
  });

  refresh();
}
