// Sidebar: server list + per-server node list rendering. Owns the
// "deferred re-render" flag that lets server-popup and drag-reorder pause
// re-renders during a user interaction without missing polling-driven
// updates that arrive in the meantime.

import { escapeHtml } from '../client-shared/html';
import { agentLabel } from '../client-shared/agent-labels';
import type { AgentType, SessionActivity, SessionInfo } from '../shared/protocol';
import {
  $serverList,
  getState,
  isActive,
  nodeKey,
  nodes,
  servers,
} from './app-context';
import type { NodeRef, ServerEntry } from './state';
import { attachDrag, isDragging } from './drag-reorder';
import { closeServerPopup, isPopupActive, wireServerPopup } from './server-popup';
import { openNodeModal } from './modals';
import { killNode } from './node-actions';
import { refreshServer, removeServer } from './server-actions';
import { selectNode } from './pane-manager';

// Internal: tracks "a render was requested while the sidebar was locked
// (popup open or drag in flight)". Server-popup and drag-reorder flush it
// when their interaction ends.
let sidebarRenderPending = false;

export function sidebarHasPendingRender(): boolean {
  return sidebarRenderPending;
}

export function flushSidebarIfPending(): void {
  if (!sidebarRenderPending) return;
  sidebarRenderPending = false;
  renderSidebar();
}

export function renderSidebar(): void {
  // If a popup is open (cursor inside a server card) OR a drag is in flight,
  // defer the re-render until the interaction ends — otherwise we'd rip the
  // user's hover target / drag source out of the DOM mid-interaction. The
  // drag case is especially nasty: tearing down the dragged LI strands the
  // browser's drag image while we rebuild fresh siblings, so the user sees
  // ghost duplicates and cancel-restore re-appends detached old children
  // alongside the new ones.
  if (isPopupActive() || isDragging()) {
    sidebarRenderPending = true;
    return;
  }
  sidebarRenderPending = false;
  const state = getState();
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
  li.dataset.serverId = srv.id;
  li.draggable = true;

  const known = getState().knownNodes[srv.id] ?? [];

  li.innerHTML = `
    <div class="server__row" tabindex="0">
      <span class="server__dot"></span>
      <span class="server__name">${escapeHtml(srv.name)}</span>
    </div>
    <div class="server__popup" role="group" aria-label="${escapeHtml(srv.name)} controls" hidden>
      <div class="server__popup-name">${escapeHtml(srv.name)}</div>
      <div class="server__popup-meta">
        <span class="server__popup-label">URL</span>
        <span class="server__popup-url" title="${escapeHtml(srv.baseUrl)}">${escapeHtml(srv.baseUrl)}</span>
      </div>
      <div class="server__popup-actions">
        <button class="popup-btn popup-btn--primary" data-act="new-node">+ new node</button>
        <button class="popup-btn" data-act="refresh" title="refresh" aria-label="refresh">↻ refresh</button>
        <button class="popup-btn popup-btn--danger" data-act="remove" title="remove server" aria-label="remove">× remove</button>
      </div>
    </div>
    <ul class="node-list"></ul>
  `;

  const $nodes = li.querySelector('.node-list') as HTMLUListElement;
  for (const ref of known) {
    const info = rt?.sessions.find((s) => s.id === ref.sessionId);
    $nodes.appendChild(renderNodeRow(ref, info));
  }

  li.querySelector('[data-act="new-node"]')!.addEventListener('click', () => {
    closeServerPopup();
    openNodeModal(srv.id);
  });
  li.querySelector('[data-act="refresh"]')!.addEventListener('click', () => refreshServer(srv.id));
  li.querySelector('[data-act="remove"]')!.addEventListener('click', () => {
    closeServerPopup();
    removeServer(srv.id);
  });

  wireServerPopup(li);
  attachDrag(li, { kind: 'server', serverId: srv.id });

  return li;
}

function renderNodeRow(ref: NodeRef, info?: SessionInfo): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'node';
  li.dataset.serverId = ref.serverId;
  li.dataset.sessionId = ref.sessionId;
  li.draggable = true;
  if (isActive(ref)) li.setAttribute('aria-current', 'true');

  const local = nodes.get(nodeKey(ref.serverId, ref.sessionId));
  const localStatus = local?.status;
  const liveAlive = info?.alive ?? true;
  const activity: SessionActivity = local?.activity ?? info?.activity ?? 'unknown';
  li.dataset.state = localStatus ?? (liveAlive ? 'connecting' : 'exited');
  li.dataset.activity = activity;

  const agentType: AgentType = info?.agentType ?? ref.agentType ?? 'claude';
  li.dataset.agent = agentType;
  li.innerHTML = `
    <span class="node__bar"></span>
    <span class="node__agent" title="${escapeHtml(agentLabel(agentType))}">${escapeHtml(agentBadge(agentType))}</span>
    <span class="node__title">${escapeHtml(ref.title)}</span>
    <span class="node__activity" title="${escapeHtml(activityLabel(activity, agentType))}"></span>
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
  attachDrag(li, { kind: 'node', serverId: ref.serverId, sessionId: ref.sessionId });
  return li;
}

function activityLabel(a: SessionActivity, agentType: AgentType = 'claude'): string {
  const who = agentLabel(agentType);
  if (a === 'working') return `${who} is working`;
  if (a === 'waiting') return 'waiting on you (permission/notify)';
  if (a === 'idle') return 'idle — awaiting prompt';
  return 'state unknown';
}

function agentBadge(a: AgentType): string {
  // Single-character mark. Color carries the rest of the meaning (see
  // .node__agent in styles.css). Hover the chip to see the full label.
  if (a === 'copilot') return 'g';
  return 'c';
}
