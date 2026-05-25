import { MaestroApi } from '../client-shared/api';
import { escapeHtml as escape } from '../client-shared/html';
import {
  loadState,
  saveState,
  uuid,
  THIS_DEVICE,
  type MobileServerEntry,
} from './mobile-state';

export interface ServerPickerCallbacks {
  onPick: (server: MobileServerEntry) => void;
}

export function renderServerPicker(root: HTMLElement, cb: ServerPickerCallbacks) {
  const state = loadState();
  const servers: MobileServerEntry[] = [THIS_DEVICE, ...state.servers];

  root.innerHTML = `
    <header class="topbar">
      <span class="topbar__title">maestro</span>
      <span class="topbar__hint">pick a server</span>
    </header>
    <main class="screen">
      <ul class="list" id="server-list"></ul>
      <div class="row">
        <input class="input" id="add-name" placeholder="label (e.g. lab)" autocomplete="off" />
        <input class="input" id="add-url" placeholder="http://10.0.1.20:4050" inputmode="url" autocomplete="off" />
        <button class="btn btn--primary" id="add-btn">+ add</button>
      </div>
      <p class="hint" id="err"></p>
    </main>
  `;

  const list = root.querySelector<HTMLUListElement>('#server-list')!;
  const errEl = root.querySelector<HTMLParagraphElement>('#err')!;

  function paint() {
    list.innerHTML = '';
    for (const s of servers) {
      const li = document.createElement('li');
      li.className = 'list__row';
      const baseLabel = s.baseUrl || location.origin;
      li.innerHTML = `
        <button class="list__main" data-id="${s.id}">
          <span class="list__title">${escape(s.name)}</span>
          <span class="list__sub">${escape(baseLabel)}</span>
        </button>
        ${s.id === THIS_DEVICE.id ? '' : `<button class="list__x" data-rm="${s.id}" aria-label="remove">×</button>`}
      `;
      list.appendChild(li);
    }
  }

  list.addEventListener('click', async (ev) => {
    const target = ev.target as HTMLElement;
    const rm = target.closest<HTMLButtonElement>('[data-rm]');
    if (rm) {
      const id = rm.dataset.rm!;
      const next = loadState();
      next.servers = next.servers.filter((s) => s.id !== id);
      saveState(next);
      servers.splice(0, servers.length, THIS_DEVICE, ...next.servers);
      paint();
      return;
    }
    const main = target.closest<HTMLButtonElement>('.list__main');
    if (!main) return;
    const id = main.dataset.id!;
    const picked = servers.find((s) => s.id === id);
    if (!picked) return;
    main.disabled = true;
    main.classList.add('is-loading');
    try {
      // Quick reachability probe — surface bad URLs before we navigate.
      const api = new MaestroApi(picked.baseUrl);
      await api.health();
      cb.onPick(picked);
    } catch (e) {
      errEl.textContent = `cannot reach: ${(e as Error).message}`;
      main.disabled = false;
      main.classList.remove('is-loading');
    }
  });

  root.querySelector<HTMLButtonElement>('#add-btn')!.addEventListener('click', () => {
    const name = root.querySelector<HTMLInputElement>('#add-name')!.value.trim();
    const baseUrl = root.querySelector<HTMLInputElement>('#add-url')!.value.trim();
    if (!name || !baseUrl) {
      errEl.textContent = 'name and url are both required';
      return;
    }
    if (!/^https?:\/\//.test(baseUrl)) {
      errEl.textContent = 'url must start with http:// or https://';
      return;
    }
    const entry: MobileServerEntry = { id: uuid(), name, baseUrl: baseUrl.replace(/\/+$/, '') };
    const next = loadState();
    next.servers.push(entry);
    saveState(next);
    servers.push(entry);
    paint();
    errEl.textContent = '';
    (root.querySelector<HTMLInputElement>('#add-name')!).value = '';
    (root.querySelector<HTMLInputElement>('#add-url')!).value = '';
  });

  paint();
}
