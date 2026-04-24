import { MaestroApi } from './api';
import { TerminalNode, type NodeStatus } from './node';
import { attachPathPicker } from './path-picker';
import {
  exportBundle,
  importBundle,
  loadState,
  reconcileNodes,
  saveState,
  uuid,
  type NodeRef,
  type PersistedState,
  type ServerEntry,
} from './state';
import type { SessionInfo } from '../shared/protocol';

type ServerHealth = 'online' | 'offline' | 'unknown';
type TopbarStatus = NodeStatus | 'idle';

interface ServerRuntime {
  api: MaestroApi;
  health: ServerHealth;
  sessions: SessionInfo[];
}

let state: PersistedState = loadState();
const servers = new Map<string, ServerRuntime>();
const nodes = new Map<string, TerminalNode>(); // key from `nodeKey`

const nodeKey = (serverId: string, sessionId: string) => `${serverId}::${sessionId}`;

const isActive = (ref: NodeRef): boolean =>
  state.activeNode?.serverId === ref.serverId && state.activeNode?.sessionId === ref.sessionId;

function runtimeFor(serverId: string): ServerRuntime {
  let rt = servers.get(serverId);
  if (rt) return rt;
  const srv = state.servers.find((s) => s.id === serverId);
  if (!srv) throw new Error(`unknown server ${serverId}`);
  rt = { api: new MaestroApi(srv.baseUrl), health: 'unknown', sessions: [] };
  servers.set(serverId, rt);
  return rt;
}

const $serverList = document.getElementById('server-list') as HTMLUListElement;
const $crumbs = document.getElementById('crumbs') as HTMLDivElement;
const $status = document.getElementById('status') as HTMLSpanElement;
const $stage = document.getElementById('stage') as HTMLDivElement;
const $empty = document.getElementById('empty') as HTMLDivElement;
const $btnAddServer = document.getElementById('btn-add-server') as HTMLButtonElement;
const $btnExport = document.getElementById('btn-export') as HTMLButtonElement;
const $btnImport = document.getElementById('btn-import') as HTMLButtonElement;
const $importFile = document.getElementById('import-file') as HTMLInputElement;
const $modalServer = document.getElementById('modal-server') as HTMLDialogElement;
const $modalNode = document.getElementById('modal-node') as HTMLDialogElement;
const $formNode = document.getElementById('form-node') as HTMLFormElement;
const $nodeServerLabel = document.getElementById('node-server-label') as HTMLParagraphElement;
const $nodeError = document.getElementById('node-error') as HTMLParagraphElement;
const $formServer = document.getElementById('form-server') as HTMLFormElement;
const $serverError = document.getElementById('server-error') as HTMLParagraphElement;
const $hudServers = document.getElementById('hud-servers') as HTMLElement;
const $hudNodes = document.getElementById('hud-nodes') as HTMLElement;
const $hudUptime = document.getElementById('hud-uptime') as HTMLElement;
const $stageTag = document.querySelector('.mark--tag') as HTMLElement | null;

const bootedAt = Date.now();

let renderScheduled = false;
function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    renderSidebar();
    renderTopbar();
    renderHud();
    renderStageTag();
  });
}

function renderHud() {
  $hudServers.textContent = String(state.servers.length).padStart(2, '0');
  let total = 0;
  for (const list of Object.values(state.knownNodes)) total += list.length;
  $hudNodes.textContent = String(total).padStart(2, '0');
}

function renderStageTag() {
  if (!$stageTag) return;
  const a = state.activeNode;
  $stageTag.textContent = a
    ? `stage / ${a.title} · ${a.sessionId.slice(0, 8)}`
    : 'stage / channel-01';
}

function pad2(n: number) {
  return n < 10 ? `0${n}` : String(n);
}
function tickUptime() {
  const s = Math.floor((Date.now() - bootedAt) / 1000);
  const hh = pad2(Math.floor(s / 3600));
  const mm = pad2(Math.floor((s % 3600) / 60));
  const ss = pad2(s % 60);
  $hudUptime.textContent = `${hh}:${mm}:${ss}`;
}
setInterval(tickUptime, 1000);
tickUptime();

function renderSidebar() {
  $serverList.innerHTML = '';
  if (state.servers.length === 0) {
    const li = document.createElement('li');
    li.className = 'server';
    li.innerHTML = `<div class="server__url">no servers — add one to begin.</div>`;
    $serverList.appendChild(li);
    return;
  }
  for (const srv of state.servers) {
    $serverList.appendChild(renderServer(srv));
  }
}

function renderServer(srv: ServerEntry): HTMLLIElement {
  const rt = servers.get(srv.id);
  const li = document.createElement('li');
  li.className = 'server';
  li.dataset.state = rt?.health ?? 'unknown';

  const known = state.knownNodes[srv.id] ?? [];

  li.innerHTML = `
    <div class="server__row">
      <span class="server__dot"></span>
      <span class="server__name">${escapeHtml(srv.name)}</span>
      <button class="icon-btn" data-act="refresh" title="refresh" aria-label="refresh">↻</button>
      <button class="icon-btn icon-btn--danger" data-act="remove" title="remove server" aria-label="remove">×</button>
    </div>
    <div class="server__url">${escapeHtml(srv.baseUrl)}</div>
    <ul class="node-list"></ul>
    <div class="server__actions">
      <button class="btn btn--block" data-act="new-node">+ node</button>
    </div>
  `;

  const $nodes = li.querySelector('.node-list') as HTMLUListElement;
  for (const ref of known) {
    const info = rt?.sessions.find((s) => s.id === ref.sessionId);
    $nodes.appendChild(renderNodeRow(ref, info));
  }

  li.querySelector('[data-act="new-node"]')!.addEventListener('click', () => openNodeModal(srv.id));
  li.querySelector('[data-act="refresh"]')!.addEventListener('click', () => refreshServer(srv.id));
  li.querySelector('[data-act="remove"]')!.addEventListener('click', () => removeServer(srv.id));

  return li;
}

function renderNodeRow(ref: NodeRef, info?: SessionInfo): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'node';
  if (isActive(ref)) li.setAttribute('aria-current', 'true');

  const localStatus = nodes.get(nodeKey(ref.serverId, ref.sessionId))?.status;
  const liveAlive = info?.alive ?? true;
  li.dataset.state = localStatus ?? (liveAlive ? 'connecting' : 'exited');

  li.innerHTML = `
    <span class="node__bar"></span>
    <span class="node__title">${escapeHtml(ref.title)}</span>
    <button class="node__kill" title="kill node" aria-label="kill">×</button>
  `;
  li.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).classList.contains('node__kill')) return;
    selectNode({ ...ref });
  });
  li.querySelector('.node__kill')!.addEventListener('click', (e) => {
    e.stopPropagation();
    killNode(ref.serverId, ref.sessionId);
  });
  return li;
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]!);
}

function renderTopbar() {
  const active = state.activeNode;
  if (!active) {
    $crumbs.innerHTML = `<span class="crumb crumb--muted">no node selected</span>`;
    setStatus('idle');
    return;
  }
  const srv = state.servers.find((s) => s.id === active.serverId);
  $crumbs.innerHTML = `
    <span class="crumb">${escapeHtml(srv?.name ?? '?')}</span>
    <span class="crumb crumb--sep">/</span>
    <span class="crumb crumb--active">${escapeHtml(active.title)}</span>
  `;
  setStatus(nodes.get(nodeKey(active.serverId, active.sessionId))?.status ?? 'connecting');
}

function setStatus(s: TopbarStatus) {
  $status.dataset.state = s;
  $status.querySelector('.status__label')!.textContent = s;
}

function persist() {
  saveState(state);
}

async function refreshServer(serverId: string) {
  const rt = runtimeFor(serverId);
  try {
    const sessions = await rt.api.list();
    rt.sessions = sessions;
    rt.health = 'online';
    state = reconcileNodes(state, serverId, sessions);
    persist();
  } catch {
    rt.health = 'offline';
  }
  scheduleRender();
}

async function refreshAll() {
  await Promise.all(state.servers.map((s) => refreshServer(s.id)));
}

function addServer(name: string, baseUrl: string) {
  const srv: ServerEntry = { id: uuid(), name: name.trim(), baseUrl: baseUrl.trim() };
  state.servers.push(srv);
  persist();
  scheduleRender();
  refreshServer(srv.id);
}

function removeServer(serverId: string) {
  if (!confirm('Remove this server from the portal? Sessions on the server will keep running.'))
    return;
  for (const [key, n] of nodes) {
    if (key.startsWith(`${serverId}::`)) {
      n.destroy();
      nodes.delete(key);
    }
  }
  state.servers = state.servers.filter((s) => s.id !== serverId);
  delete state.knownNodes[serverId];
  if (state.activeNode?.serverId === serverId) state.activeNode = null;
  servers.delete(serverId);
  persist();
  scheduleRender();
  showEmptyIfNeeded();
}

async function createNode(serverId: string, body: { title?: string; cwd: string }) {
  const rt = runtimeFor(serverId);
  let session: SessionInfo;
  try {
    session = await rt.api.create(body);
  } catch (err) {
    throw new Error((err as Error).message);
  }
  const ref: NodeRef = { serverId, sessionId: session.id, title: session.title };
  (state.knownNodes[serverId] ??= []).push(ref);
  rt.sessions = [...rt.sessions, session];
  state.lastCwd[serverId] = body.cwd;
  persist();
  selectNode(ref);
}

let nodeModalServerId: string | null = null;
const cwdInput = $formNode.elements.namedItem('cwd') as HTMLInputElement;
const pathPicker = attachPathPicker(cwdInput);

function openNodeModal(serverId: string) {
  nodeModalServerId = serverId;
  const srv = state.servers.find((s) => s.id === serverId);
  $nodeServerLabel.innerHTML = `on server <strong>${escapeHtml(srv?.name ?? '?')}</strong>`;
  $nodeError.textContent = '';
  $formNode.reset();
  cwdInput.value = state.lastCwd[serverId] ?? '';
  pathPicker.setApi(runtimeFor(serverId).api);
  $modalNode.showModal();
  setTimeout(() => cwdInput.focus(), 0);
}

async function killNode(serverId: string, sessionId: string) {
  if (!confirm('Kill this node? The PTY and Claude process will terminate.')) return;
  try {
    await runtimeFor(serverId).api.kill(sessionId);
  } catch {}
  const key = nodeKey(serverId, sessionId);
  nodes.get(key)?.destroy();
  nodes.delete(key);
  state.knownNodes[serverId] = (state.knownNodes[serverId] ?? []).filter(
    (n) => n.sessionId !== sessionId,
  );
  if (state.activeNode?.serverId === serverId && state.activeNode.sessionId === sessionId) {
    state.activeNode = null;
  }
  persist();
  await refreshServer(serverId);
  showEmptyIfNeeded();
}

function selectNode(ref: NodeRef) {
  if (state.activeNode) {
    nodes.get(nodeKey(state.activeNode.serverId, state.activeNode.sessionId))?.unmount();
  }
  state.activeNode = ref;
  persist();

  const key = nodeKey(ref.serverId, ref.sessionId);
  let node = nodes.get(key);
  if (!node) {
    node = new TerminalNode(runtimeFor(ref.serverId).api, ref.sessionId, {
      status: (s) => {
        if (isActive(ref)) setStatus(s);
        scheduleRender();
      },
      title: (t) => {
        ref.title = t;
        const list = state.knownNodes[ref.serverId];
        const found = list?.find((n) => n.sessionId === ref.sessionId);
        if (found) found.title = t;
        persist();
        scheduleRender();
      },
    });
    nodes.set(key, node);
  }
  $empty.classList.add('is-hidden');
  node.mount($stage);
  scheduleRender();
}

function showEmptyIfNeeded() {
  if (!state.activeNode) $empty.classList.remove('is-hidden');
}

$btnAddServer.addEventListener('click', () => {
  $serverError.textContent = '';
  $formServer.reset();
  $modalServer.showModal();
});

$btnExport.addEventListener('click', () => {
  const bundle = exportBundle(state);
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `maestro-servers-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
});

$btnImport.addEventListener('click', () => $importFile.click());
$importFile.addEventListener('change', async () => {
  const file = $importFile.files?.[0];
  $importFile.value = '';
  if (!file) return;
  let bundle: unknown;
  try {
    bundle = JSON.parse(await file.text());
  } catch {
    alert('import failed: file is not valid JSON');
    return;
  }
  let result;
  try {
    ({ state, result } = importBundle(state, bundle));
  } catch (err) {
    alert(`import failed: ${(err as Error).message}`);
    return;
  }
  persist();
  scheduleRender();
  refreshAll();
  alert(`imported ${result.added} server(s); skipped ${result.skipped} duplicate(s)`);
});
$modalServer.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  if (t.dataset.close !== undefined) $modalServer.close();
});
$modalNode.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  if (t.dataset.close !== undefined) $modalNode.close();
});
$formNode.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!nodeModalServerId) return;
  const fd = new FormData($formNode);
  const title = String(fd.get('title') ?? '').trim();
  const cwd = String(fd.get('cwd') ?? '').trim();
  if (!cwd) {
    $nodeError.textContent = 'working directory is required';
    return;
  }
  $nodeError.textContent = 'spawning…';
  try {
    await createNode(nodeModalServerId, { title: title || undefined, cwd });
  } catch (err) {
    $nodeError.textContent = `failed: ${(err as Error).message}`;
    return;
  }
  $nodeError.textContent = '';
  $modalNode.close();
});
$formServer.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData($formServer);
  const name = String(fd.get('name') ?? '').trim();
  const baseUrl = String(fd.get('baseUrl') ?? '').trim();
  if (!name || !baseUrl) return;
  $serverError.textContent = 'probing…';
  try {
    await new MaestroApi(baseUrl).health();
  } catch (err) {
    $serverError.textContent = `cannot reach ${baseUrl} (${(err as Error).message})`;
    return;
  }
  $serverError.textContent = '';
  $modalServer.close();
  addServer(name, baseUrl);
});

if (state.servers.length === 0) {
  state.servers.push({ id: uuid(), name: 'local', baseUrl: location.origin });
  persist();
}

// Reattach the previously-active node so reload restores the working session.
if (state.activeNode) {
  const ref = state.activeNode;
  state.activeNode = null;
  selectNode(ref);
}

scheduleRender();
showEmptyIfNeeded();
refreshAll();

setTimeout(() => document.querySelector('.app')?.removeAttribute('data-boot'), 1500);

setInterval(() => {
  if (document.hidden) return;
  for (const s of state.servers) refreshServer(s.id);
}, 10_000);
