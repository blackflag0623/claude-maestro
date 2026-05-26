import { MaestroApi } from '../client-shared/api';
import { escapeHtml } from '../client-shared/html';
import { TerminalNode, type NodeStatus } from './node';
import { attachPathPicker } from './path-picker';
import { FileExplorer } from './file-explorer';
import {
  exportBundle,
  importBundle,
  loadState,
  reconcileNodes,
  saveState,
  uuid,
  PANE_COUNT,
  MAX_PANES,
  type LayoutMode,
  type NodeRef,
  type PersistedState,
  type ServerEntry,
} from './state';
import type { AgentType, SessionInfo, SessionActivity } from '../shared/protocol';
import { AGENT_TYPES } from '../shared/protocol';

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
const explorers = new Map<string, FileExplorer>(); // key from `nodeKey`
const explorerOpen = new Set<string>(); // nodeKey set: explorer currently open

const nodeKey = (serverId: string, sessionId: string) => `${serverId}::${sessionId}`;

/** A NodeRef is "active" if it occupies any visible pane in the current layout. */
const isActive = (ref: NodeRef): boolean => {
  const count = PANE_COUNT[state.layoutMode];
  for (let i = 0; i < count; i++) {
    const a = state.activeNodes[i];
    if (a && a.serverId === ref.serverId && a.sessionId === ref.sessionId) return true;
  }
  return false;
};

/** Returns the slot index that currently hosts the given ref, or -1.
 *  Searches all MAX_PANES slots (including stashed slots beyond the visible
 *  range) so we can detect duplicates across layout changes. */
function findSlotOf(ref: NodeRef): number {
  for (let i = 0; i < MAX_PANES; i++) {
    const a = state.activeNodes[i];
    if (a && a.serverId === ref.serverId && a.sessionId === ref.sessionId) return i;
  }
  return -1;
}

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
const $panes = document.getElementById('panes') as HTMLDivElement;
const $empty = document.getElementById('empty') as HTMLDivElement;
const $layoutSwitch = document.getElementById('layout-switch') as HTMLDivElement;
const $nodeActions = document.getElementById('node-actions') as HTMLDivElement;
const $btnSidebar = document.getElementById('btn-sidebar') as HTMLButtonElement;
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
    renderPaneStates();
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
  const a = state.activeNodes[state.focusedPane];
  if (a) {
    $stageTag.textContent = `stage / ${a.title} · ${a.sessionId.slice(0, 8)}`;
  } else {
    $stageTag.textContent = `stage / ${state.layoutMode}`;
  }
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
  // If a popup is open (cursor inside a server card) OR a drag is in flight,
  // defer the re-render until the interaction ends — otherwise we'd rip the
  // user's hover target / drag source out of the DOM mid-interaction. The
  // drag case is especially nasty: tearing down the dragged LI strands the
  // browser's drag image while we rebuild fresh siblings, so the user sees
  // ghost duplicates and cancel-restore re-appends detached old children
  // alongside the new ones.
  if (activePopupHost || dragging) {
    sidebarRenderPending = true;
    return;
  }
  sidebarRenderPending = false;
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
let sidebarRenderPending = false;

function renderServer(srv: ServerEntry): HTMLLIElement {
  const rt = servers.get(srv.id);
  const li = document.createElement('li');
  li.className = 'server';
  li.dataset.state = rt?.health ?? 'unknown';
  li.dataset.serverId = srv.id;
  li.draggable = true;

  const known = state.knownNodes[srv.id] ?? [];

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

  li.querySelector('[data-act="new-node"]')!.addEventListener('click', () => { closeServerPopup(); openNodeModal(srv.id); });
  li.querySelector('[data-act="refresh"]')!.addEventListener('click', () => refreshServer(srv.id));
  li.querySelector('[data-act="remove"]')!.addEventListener('click', () => { closeServerPopup(); removeServer(srv.id); });

  wireServerPopup(li);
  attachDrag(li, { kind: 'server', serverId: srv.id });

  return li;
}

/* ── Hover-popup controller ───────────────────────────────────────────────
   A server row at rest shows only [●] NAME. On hover/focus, a fixed-position
   callout appears to the right of the row holding URL + actions. A small
   grace timer lets the cursor travel between row and popup without flicker.
   Closed automatically on scroll, resize, Escape, or pointer/focus leave. */
let activePopupHost: HTMLElement | null = null;
let popupCloseTimer: number | null = null;

function cancelPopupClose(): void {
  if (popupCloseTimer !== null) {
    window.clearTimeout(popupCloseTimer);
    popupCloseTimer = null;
  }
}

function closeServerPopup(): void {
  cancelPopupClose();
  if (!activePopupHost) return;
  const popup = activePopupHost.querySelector<HTMLElement>('.server__popup');
  if (popup) {
    popup.hidden = true;
    popup.classList.remove('is-open');
  }
  activePopupHost.classList.remove('is-popup-open');
  activePopupHost = null;
  // Flush any sidebar render that was deferred while the popup was open.
  if (sidebarRenderPending) {
    sidebarRenderPending = false;
    renderSidebar();
  }
}

function scheduleClose(delay = 180): void {
  cancelPopupClose();
  popupCloseTimer = window.setTimeout(() => {
    popupCloseTimer = null;
    closeServerPopup();
  }, delay);
}

function openServerPopup(li: HTMLElement): void {
  cancelPopupClose();
  if (activePopupHost === li) {
    positionServerPopup(li);
    return;
  }
  if (activePopupHost && activePopupHost !== li) closeServerPopup();
  const popup = li.querySelector<HTMLElement>('.server__popup');
  if (!popup) return;
  popup.hidden = false;
  popup.classList.add('is-open');
  li.classList.add('is-popup-open');
  activePopupHost = li;
  positionServerPopup(li);
}

function positionServerPopup(li: HTMLElement): void {
  const popup = li.querySelector<HTMLElement>('.server__popup');
  const row = li.querySelector<HTMLElement>('.server__row');
  if (!popup || !row) return;
  const rect = row.getBoundingClientRect();
  const popupW = popup.offsetWidth || 260;
  const popupH = popup.offsetHeight || 120;
  const gap = 8;
  // Prefer right of the row; fall back to left if it would overflow viewport.
  let left = rect.right + gap;
  if (left + popupW + 8 > window.innerWidth) left = Math.max(8, rect.left - popupW - gap);
  let top = rect.top;
  if (top + popupH + 8 > window.innerHeight) top = Math.max(8, window.innerHeight - popupH - 8);
  popup.style.left = `${Math.round(left)}px`;
  popup.style.top = `${Math.round(top)}px`;
}

function wireServerPopup(li: HTMLElement): void {
  const row = li.querySelector<HTMLElement>('.server__row');
  const popup = li.querySelector<HTMLElement>('.server__popup');
  if (!row || !popup) return;
  // Bind to the whole .server li (row + node-list) so the popup stays open
  // while the cursor moves over any agent node beneath the row. The popup
  // is still anchored to .server__row's bounding box.
  li.addEventListener('mouseenter', () => openServerPopup(li));
  li.addEventListener('mouseleave', () => scheduleClose());
  li.addEventListener('focusin', () => openServerPopup(li));
  li.addEventListener('focusout', (e) => {
    const next = (e as FocusEvent).relatedTarget as Node | null;
    if (next && (li.contains(next) || popup.contains(next))) return;
    scheduleClose();
  });
  popup.addEventListener('mouseenter', () => cancelPopupClose());
  popup.addEventListener('mouseleave', () => scheduleClose());
  popup.addEventListener('focusout', (e) => {
    const next = (e as FocusEvent).relatedTarget as Node | null;
    if (next && (li.contains(next) || popup.contains(next))) return;
    scheduleClose();
  });
}

// Global listeners. We DO NOT use a capture-phase scroll listener — that would
// close the popup whenever the xterm terminal scrolls due to PTY output. The
// popup is anchored to a row inside the sidebar, so only sidebar scrolling
// affects its position; on sidebar scroll we reposition rather than close.
const $sidebarEl = document.querySelector<HTMLElement>('.sidebar');
$sidebarEl?.addEventListener('scroll', () => {
  if (!activePopupHost) return;
  const row = activePopupHost.querySelector<HTMLElement>('.server__row');
  if (!row) return;
  const r = row.getBoundingClientRect();
  // Close only if the anchor row has scrolled completely out of view.
  if (r.bottom < 0 || r.top > window.innerHeight) closeServerPopup();
  else positionServerPopup(activePopupHost);
}, { passive: true });
window.addEventListener('resize', () => {
  if (activePopupHost) positionServerPopup(activePopupHost);
});
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeServerPopup(); });

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

function agentLabel(a: AgentType): string {
  if (a === 'copilot') return 'GitHub Copilot CLI';
  return 'Claude Code';
}

function agentBadge(a: AgentType): string {
  // Single-character mark. Color carries the rest of the meaning (see
  // .node__agent in styles.css). Hover the chip to see the full label.
  if (a === 'copilot') return 'g';
  return 'c';
}

// ───────── drag-to-reorder ─────────

type DragRef =
  | { kind: 'server'; serverId: string }
  | { kind: 'node'; serverId: string; sessionId: string };

let dragging: DragRef | null = null;
// Snapshot used to restore the DOM order if a drag is cancelled (Esc, drop
// outside any valid target). We do NOT mutate state during dragover — only
// the DOM moves in real time. On drop, the existing reorder helpers commit
// state from the drag target reference; on cancel, we put children back.
let dragOriginalOrder: HTMLElement[] | null = null;
let dragOriginalParent: HTMLElement | null = null;
let dragDropCommitted = false;

/** FLIP-animate a reorder inside `parent`. Snapshot rects, run the mutation
 *  (which moves children around in DOM order), then for each sibling whose
 *  position changed, apply the inverted delta as a transform and animate it
 *  back to zero via the CSS transition on `transform`. The dragged element
 *  is excluded so its position doesn't fight the browser-rendered drag ghost. */
function flipReorder(parent: HTMLElement, doMove: () => void, exclude: HTMLElement | null): void {
  const siblings = (Array.from(parent.children) as HTMLElement[]).filter((el) => el !== exclude);
  const firstRects = new Map<HTMLElement, DOMRect>();
  for (const el of siblings) firstRects.set(el, el.getBoundingClientRect());
  // Clear any in-flight transforms so the post-move measurement reflects the
  // natural new layout, not a transform-offset position from a prior FLIP.
  for (const el of siblings) {
    el.style.transition = 'none';
    el.style.transform = '';
  }
  doMove();
  // Force layout so the next getBoundingClientRect reads the moved positions.
  void parent.offsetHeight;
  for (const el of siblings) {
    const first = firstRects.get(el)!;
    const last = el.getBoundingClientRect();
    const dy = first.top - last.top;
    if (Math.abs(dy) < 0.5) continue;
    el.style.transform = `translateY(${dy}px)`;
  }
  // Commit the transforms before re-enabling transitions; otherwise the
  // browser will collapse the two style writes and skip the animation.
  void parent.offsetHeight;
  for (const el of siblings) {
    el.style.transition = '';
    el.style.transform = '';
  }
}

function attachDrag(el: HTMLElement, ref: DragRef) {
  el.addEventListener('dragstart', (e) => {
    dragging = ref;
    dragDropCommitted = false;
    dragOriginalParent = el.parentElement;
    dragOriginalOrder = dragOriginalParent ? (Array.from(dragOriginalParent.children) as HTMLElement[]) : null;
    // The hover popup would be in the way of a server drag.
    closeServerPopup();
    el.classList.add('is-dragging');
    e.dataTransfer?.setData('text/plain', JSON.stringify(ref));
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  });
  el.addEventListener('dragend', () => {
    el.classList.remove('is-dragging');
    document.querySelectorAll('.is-drop-target').forEach((n) => n.classList.remove('is-drop-target'));
    // Cancelled drag (no successful drop fired — e.g. Esc, drop outside any
    // valid target): restore the original DOM order so the visual position
    // matches the unchanged state.
    if (!dragDropCommitted && dragOriginalOrder && dragOriginalParent) {
      const parent = dragOriginalParent;
      const order = dragOriginalOrder;
      flipReorder(parent, () => { for (const child of order) parent.appendChild(child); }, el);
    }
    dragging = null;
    dragOriginalOrder = null;
    dragOriginalParent = null;
    dragDropCommitted = false;
    // Catch up any polling-driven sidebar re-renders that were deferred while
    // the drag was active. The state is now in sync with the DOM so this is
    // a no-op visually, but it re-binds handlers cleanly.
    if (sidebarRenderPending) scheduleRender();
  });
  el.addEventListener('dragover', (e) => {
    if (!dragging || dragging.kind !== ref.kind) return;
    if (ref.kind === 'node' && dragging.kind === 'node' && dragging.serverId !== ref.serverId) return;
    // preventDefault unconditionally so the dragged element itself remains a
    // valid drop target. Otherwise, releasing the mouse over the dragged LI
    // (the most natural release point — the cursor follows the drag image)
    // fires no drop event, the dragend cancel-restore kicks in, and all the
    // user's FLIP-driven reordering snaps back to the original order.
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    // Live DOM-only reorder with a FLIP animation so siblings slide smoothly
    // instead of snapping. State is left untouched until drop; on cancel we
    // revert via the snapshot above (also FLIP-animated).
    const parent = el.parentElement;
    if (!parent) return;
    const dragged = parent.querySelector<HTMLElement>('.is-dragging');
    if (!dragged || dragged === el) return;
    const before = isAbove(e, el);
    const anchor = before ? el : el.nextElementSibling;
    if (dragged !== anchor && dragged.nextElementSibling !== anchor) {
      flipReorder(parent, () => parent.insertBefore(dragged, anchor), dragged);
    }
  });
  el.addEventListener('dragleave', () => el.classList.remove('is-drop-target'));
  el.addEventListener('drop', (e) => {
    el.classList.remove('is-drop-target');
    if (!dragging || dragging.kind !== ref.kind) return;
    e.preventDefault();
    e.stopPropagation();
    dragDropCommitted = true;
    // Commit ordering from the LIVE DOM rather than recomputing from the
    // drop target's index in state. The DOM was reordered in real time by
    // dragover-FLIP and is the source of truth for what the user saw at the
    // moment of release. Using state-relative indices here would drift
    // because: (a) the state array is still in its original order, (b)
    // `isAbove(drop target)` is measured against the post-FLIP layout, and
    // (c) the user may have released over the dragged element itself, which
    // would otherwise mean "no target found".
    commitDragOrderFromDom(ref);
  });
}

/** Reconcile state ordering with the current DOM ordering of the sidebar
 *  list that owns this drag. Persists and schedules a re-render. */
function commitDragOrderFromDom(ref: DragRef) {
  if (ref.kind === 'server') {
    const ids = Array.from($serverList.children)
      .map((c) => (c as HTMLElement).dataset.serverId)
      .filter((x): x is string => !!x);
    const byId = new Map(state.servers.map((s) => [s.id, s]));
    const next: ServerEntry[] = [];
    for (const id of ids) {
      const s = byId.get(id);
      if (s) {
        next.push(s);
        byId.delete(id);
      }
    }
    // Append any servers the DOM didn't list (defensive — shouldn't happen
    // since renders are paused during the drag).
    for (const s of byId.values()) next.push(s);
    if (next.length !== state.servers.length) return;
    state.servers = next;
    persist();
    scheduleRender();
    return;
  }
  // node drag: find the .node-list containing the dragged LI
  const draggedLi = $serverList.querySelector<HTMLElement>(
    `.node[data-server-id="${ref.serverId}"][data-session-id="${ref.sessionId}"]`,
  );
  const list = draggedLi?.parentElement;
  if (!list) return;
  const sids = Array.from(list.children)
    .map((c) => (c as HTMLElement).dataset.sessionId)
    .filter((x): x is string => !!x);
  const known = state.knownNodes[ref.serverId] ?? [];
  const bySid = new Map(known.map((n) => [n.sessionId, n]));
  const next: NodeRef[] = [];
  for (const sid of sids) {
    const n = bySid.get(sid);
    if (n) {
      next.push(n);
      bySid.delete(sid);
    }
  }
  for (const n of bySid.values()) next.push(n);
  if (next.length !== known.length) return;
  state.knownNodes = { ...state.knownNodes, [ref.serverId]: next };
  persist();
  scheduleRender();
}

function isAbove(e: DragEvent, el: HTMLElement): boolean {
  // Use the LAYOUT midline, not the visual midline. `getBoundingClientRect`
  // reflects any active CSS transform — including the FLIP slide animation
  // we apply during dragover-driven reorders. During that 180 ms slide a
  // sibling is visually still in its old slot while its DOM position has
  // already moved to the new one, so a visual-midline threshold oscillates
  // and bumps the dragged element back and forth between adjacent slots.
  // The most visible symptom: dragging to position #1 (top of list) is
  // impossible because the moment the dragged element lands at slot 0, the
  // sibling animating out of slot 0 is hit-tested in the lower half of its
  // visual rect and immediately bumps the dragged element back to slot 1.
  // Subtract the current translateY to get the untransformed top.
  const r = el.getBoundingClientRect();
  let topY = r.top;
  const t = getComputedStyle(el).transform;
  if (t && t !== 'none') {
    if (t.startsWith('matrix3d(')) {
      const parts = t.slice(9, -1).split(',').map((s) => parseFloat(s));
      topY -= parts[13] ?? 0;
    } else if (t.startsWith('matrix(')) {
      const parts = t.slice(7, -1).split(',').map((s) => parseFloat(s));
      topY -= parts[5] ?? 0;
    }
  }
  return e.clientY < topY + r.height / 2;
}

function renderTopbar() {
  const active = state.activeNodes[state.focusedPane];
  for (const btn of $layoutSwitch.querySelectorAll<HTMLButtonElement>('button[data-mode]')) {
    const isCurrent = btn.dataset.mode === state.layoutMode;
    if (isCurrent) btn.setAttribute('aria-current', 'true');
    else btn.removeAttribute('aria-current');
  }
  // Enable node-action buttons only when there's a focused node to act on.
  // Disabling is purely visual/click guard — the keyboard shortcuts share
  // the same focusedNode() gate so the two surfaces stay in sync.
  const hasActive = !!active;
  for (const btn of $nodeActions.querySelectorAll<HTMLButtonElement>('button[data-act]')) {
    btn.disabled = !hasActive;
  }
  if (!active) {
    const count = PANE_COUNT[state.layoutMode];
    const label =
      count === 1 ? 'no node selected' : `slot ${state.focusedPane + 1} · empty`;
    $crumbs.innerHTML = `<span class="crumb crumb--muted">${escapeHtml(label)}</span>`;
    setStatus('idle');
    return;
  }
  const srv = state.servers.find((s) => s.id === active.serverId);
  // Identity block reads as one cohesive phrase:
  //   [● SERVER]  →  node-title
  // The dot is the same lime indicator used in the sidebar, so identity
  // continuity across surfaces is preserved. The arrow is an italic serif
  // glyph — same brand voice as the empty-state hero.
  $crumbs.innerHTML = `
    <span class="crumb crumb--server">
      <span class="crumb__dot" aria-hidden="true"></span>
      <span class="crumb__name">${escapeHtml(srv?.name ?? '?')}</span>
    </span>
    <span class="crumb crumb--sep" aria-hidden="true">→</span>
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
      explorers.get(key)?.destroy();
      explorers.delete(key);
      explorerOpen.delete(key);
    }
  }
  state.servers = state.servers.filter((s) => s.id !== serverId);
  delete state.knownNodes[serverId];
  state.activeNodes = state.activeNodes.map((a) => (a && a.serverId === serverId ? null : a));
  servers.delete(serverId);
  persist();
  renderPanes();
  scheduleRender();
}

async function createNode(serverId: string, body: { title?: string; cwd: string; agentType?: AgentType }) {
  const rt = runtimeFor(serverId);
  const session = await rt.api.create(body);
  const ref: NodeRef = {
    serverId,
    sessionId: session.id,
    title: session.title,
    agentType: session.agentType,
  };
  (state.knownNodes[serverId] ??= []).push(ref);
  rt.sessions = [...rt.sessions, session];
  state.lastCwd[serverId] = body.cwd;
  persist();
  selectNode(ref);
}

let nodeModalServerId: string | null = null;
const cwdInput = $formNode.elements.namedItem('cwd') as HTMLInputElement;
const agentSelect = $formNode.elements.namedItem('agentType') as HTMLSelectElement;
const pathPicker = attachPathPicker(cwdInput);

function openNodeModal(serverId: string) {
  nodeModalServerId = serverId;
  const srv = state.servers.find((s) => s.id === serverId);
  $nodeServerLabel.innerHTML = `on server <strong>${escapeHtml(srv?.name ?? '?')}</strong>`;
  $nodeError.textContent = '';
  $formNode.reset();
  cwdInput.value = state.lastCwd[serverId] ?? '';
  agentSelect.value = state.lastAgentType?.[serverId] ?? 'claude';
  pathPicker.setApi(runtimeFor(serverId).api);
  $modalNode.showModal();
  setTimeout(() => cwdInput.focus(), 0);
}

async function killNode(serverId: string, sessionId: string) {
  if (!confirm('Kill this node? The PTY and the agent process will terminate.')) return;
  try {
    await runtimeFor(serverId).api.kill(sessionId);
  } catch (err) {
    alert(`failed to kill node: ${(err as Error).message}`);
    return;
  }
  const key = nodeKey(serverId, sessionId);
  nodes.get(key)?.destroy();
  nodes.delete(key);
  explorers.get(key)?.destroy();
  explorers.delete(key);
  explorerOpen.delete(key);
  state.knownNodes[serverId] = (state.knownNodes[serverId] ?? []).filter(
    (n) => n.sessionId !== sessionId,
  );
  state.activeNodes = state.activeNodes.map((a) =>
    a && a.serverId === serverId && a.sessionId === sessionId ? null : a,
  );
  await refreshServer(serverId);
  renderPanes();
  scheduleRender();
}

// ───── pane / layout management ─────

function getOrCreateNode(ref: NodeRef): TerminalNode {
  const key = nodeKey(ref.serverId, ref.sessionId);
  let node = nodes.get(key);
  if (node) return node;
  node = new TerminalNode(runtimeFor(ref.serverId).api, ref.sessionId, {
    status: () => {
      // Status changes may affect topbar (focused pane) and pane head bars.
      scheduleRender();
    },
    activity: () => {
      scheduleRender();
    },
    title: (t) => {
      ref.title = t;
      const list = state.knownNodes[ref.serverId];
      const found = list?.find((n) => n.sessionId === ref.sessionId);
      if (found) found.title = t;
      for (const a of state.activeNodes) {
        if (a && a.serverId === ref.serverId && a.sessionId === ref.sessionId) a.title = t;
      }
      persist();
      scheduleRender();
    },
  });
  nodes.set(key, node);
  return node;
}

function getOrCreateExplorer(ref: NodeRef): FileExplorer {
  const key = nodeKey(ref.serverId, ref.sessionId);
  let exp = explorers.get(key);
  if (exp) return exp;
  exp = new FileExplorer(runtimeFor(ref.serverId).api, ref.sessionId);
  explorers.set(key, exp);
  return exp;
}

function toggleExplorer(ref: NodeRef) {
  const key = nodeKey(ref.serverId, ref.sessionId);
  if (explorerOpen.has(key)) {
    explorerOpen.delete(key);
  } else {
    explorerOpen.add(key);
  }
  renderPanes();
  scheduleRender();
}

/** Returns the element that hosts the xterm for the given slot, or null. */
function paneTermHost(slot: number): HTMLElement | null {
  const pane = $panes.children[slot] as HTMLElement | undefined;
  return (pane?.querySelector('[data-role="term"]') as HTMLElement | null) ?? null;
}

function paneExplorerHost(slot: number): HTMLElement | null {
  const pane = $panes.children[slot] as HTMLElement | undefined;
  return (pane?.querySelector('[data-role="explorer"]') as HTMLElement | null) ?? null;
}

/** Build all panes for the current layout from scratch. Idempotent w.r.t.
 *  TerminalNode lifetimes — nodes are unmounted from their current parent then
 *  mounted into the new pane body. xterm + WS keep running across this. */
function renderPanes() {
  $stage.dataset.layout = state.layoutMode;
  const count = PANE_COUNT[state.layoutMode];

  // Unmount every currently-mounted node, then rebuild pane DOM. xterm + WS
  // keep running across unmount/mount, so this is cheap from the user's POV.
  for (const node of nodes.values()) {
    if (node.el.parentElement) node.unmount();
  }

  $panes.innerHTML = '';
  for (let i = 0; i < count; i++) {
    $panes.appendChild(buildPane(i));
  }

  // Mount desired nodes into their pane bodies.
  for (let i = 0; i < count; i++) {
    const ref = state.activeNodes[i];
    if (!ref) continue;
    const body = paneTermHost(i);
    if (!body) continue;
    body.classList.remove('is-empty');
    body.innerHTML = '';
    const node = getOrCreateNode(ref);
    node.mount(body);
    // If the explorer is open for this node, mount it too.
    const key = nodeKey(ref.serverId, ref.sessionId);
    if (explorerOpen.has(key)) {
      const host = paneExplorerHost(i);
      if (host) {
        const exp = getOrCreateExplorer(ref);
        host.innerHTML = '';
        host.appendChild(exp.el);
      }
    }
  }

  refreshFocusedPaneFocus();
  updateEmptyHero();
}

function buildPane(slot: number): HTMLElement {
  const ref = state.activeNodes[slot];
  const pane = document.createElement('div');
  pane.className = 'pane';
  pane.dataset.slot = String(slot);
  if (slot === state.focusedPane) pane.setAttribute('aria-current', 'true');

  const node = ref ? nodes.get(nodeKey(ref.serverId, ref.sessionId)) : null;
  pane.dataset.state = node?.status ?? (ref ? 'connecting' : 'empty');
  pane.dataset.activity = node?.activity ?? 'unknown';

  const title = ref ? ref.title : 'empty slot';
  const openExp = ref ? explorerOpen.has(nodeKey(ref.serverId, ref.sessionId)) : false;
  pane.innerHTML = `
    <header class="pane__head">
      <span class="pane__bar"></span>
      <span class="pane__slot-num">${slot + 1}</span>
      <span class="pane__label">${escapeHtml(title)}</span>
      <span class="pane__activity"></span>
      ${ref ? `<button class="pane__files" type="button" title="toggle file explorer" aria-label="files"${openExp ? ' aria-pressed="true"' : ''}>files</button>` : ''}
      ${ref ? `<button class="pane__close" type="button" title="detach (keeps session alive)" aria-label="detach">\u00d7</button>` : ''}
    </header>
    <div class="pane__body${ref ? '' : ' is-empty'}${openExp ? ' is-split' : ''}">${
      ref
        ? '<div class="pane__term" data-role="term"></div>' +
          (openExp ? '<div class="pane__explorer" data-role="explorer"></div>' : '')
        : '<span class="pane__hint">empty — pick a node from the sidebar, or drop one here</span>'
    }</div>
  `;

  pane.addEventListener('mousedown', (e) => {
    if ((e.target as HTMLElement).closest('.pane__close')) return;
    if ((e.target as HTMLElement).closest('.pane__files')) return;
    if (slot !== state.focusedPane) focusPane(slot);
  });
  if (ref) {
    pane.querySelector('.pane__close')!.addEventListener('click', (e) => {
      e.stopPropagation();
      detachSlot(slot);
    });
    pane.querySelector('.pane__files')!.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleExplorer(ref);
    });
  }

  // Accept drag-drop of a sidebar node onto this pane.
  pane.addEventListener('dragover', (e) => {
    if (!dragging || dragging.kind !== 'node') return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    pane.classList.add('is-drop-target');
  });
  pane.addEventListener('dragleave', (e) => {
    const next = e.relatedTarget as Node | null;
    if (next && pane.contains(next)) return;
    pane.classList.remove('is-drop-target');
  });
  pane.addEventListener('drop', (e) => {
    pane.classList.remove('is-drop-target');
    if (!dragging || dragging.kind !== 'node') return;
    e.preventDefault();
    e.stopPropagation();
    const drag = dragging;
    const list = state.knownNodes[drag.serverId];
    const dropped = list?.find((n) => n.sessionId === drag.sessionId);
    if (!dropped) return;
    placeInSlot(slot, dropped);
  });

  return pane;
}

/** Lightweight refresh of pane head data attributes + labels without rebuilding
 *  the pane DOM (which would tear down mounted terminals). */
function renderPaneStates() {
  const count = PANE_COUNT[state.layoutMode];
  for (let i = 0; i < count; i++) {
    const paneEl = $panes.children[i] as HTMLElement | undefined;
    if (!paneEl) continue;
    const ref = state.activeNodes[i];
    const node = ref ? nodes.get(nodeKey(ref.serverId, ref.sessionId)) : null;
    paneEl.dataset.state = node?.status ?? (ref ? 'connecting' : 'empty');
    paneEl.dataset.activity = node?.activity ?? 'unknown';
    if (i === state.focusedPane) paneEl.setAttribute('aria-current', 'true');
    else paneEl.removeAttribute('aria-current');
    const label = paneEl.querySelector('.pane__label');
    if (label) label.textContent = ref ? ref.title : 'empty slot';
  }
}

function updateEmptyHero() {
  const anyFilled = state.activeNodes.some((n) => !!n);
  const showHero = state.layoutMode === 'single' && !anyFilled;
  $empty.classList.toggle('is-hidden', !showHero);
}

function refreshFocusedPaneFocus() {
  const ref = state.activeNodes[state.focusedPane];
  if (!ref) return;
  const node = nodes.get(nodeKey(ref.serverId, ref.sessionId));
  if (node) requestAnimationFrame(() => node.term.focus());
}

function setLayoutMode(mode: LayoutMode) {
  if (state.layoutMode === mode) return;
  state.layoutMode = mode;
  if (state.focusedPane >= PANE_COUNT[mode]) state.focusedPane = 0;
  persist();
  renderPanes();
  scheduleRender();
}

/** Place `ref` into pane `slot`. If `ref` already occupies a different slot,
 *  swap the contents (avoids ever having the same TerminalNode in two slots).
 *  Always focuses `slot` after the move. */
function placeInSlot(slot: number, ref: NodeRef) {
  if (slot < 0 || slot >= PANE_COUNT[state.layoutMode]) return;
  const existing = findSlotOf(ref);
  if (existing === slot) {
    focusPane(slot);
    return;
  }
  const next = state.activeNodes.slice();
  const displaced = next[slot] ?? null;
  next[slot] = ref;
  if (existing >= 0) {
    next[existing] = displaced; // swap
  }
  state.activeNodes = next;
  state.focusedPane = slot;
  persist();
  renderPanes();
  scheduleRender();
}

function detachSlot(slot: number) {
  if (!state.activeNodes[slot]) return;
  const next = state.activeNodes.slice();
  next[slot] = null;
  state.activeNodes = next;
  persist();
  renderPanes();
  scheduleRender();
}

function focusPane(slot: number) {
  if (slot < 0 || slot >= PANE_COUNT[state.layoutMode]) return;
  if (slot === state.focusedPane) {
    refreshFocusedPaneFocus();
    return;
  }
  state.focusedPane = slot;
  persist();
  for (let i = 0; i < $panes.children.length; i++) {
    const p = $panes.children[i] as HTMLElement;
    if (i === slot) p.setAttribute('aria-current', 'true');
    else p.removeAttribute('aria-current');
  }
  refreshFocusedPaneFocus();
  scheduleRender();
}

function selectNode(ref: NodeRef) {
  // Clicking a sidebar node: if it's already mounted, focus that slot;
  // otherwise mount it into the focused pane (replacing whatever was there).
  const existing = findSlotOf(ref);
  const visible = PANE_COUNT[state.layoutMode];
  if (existing >= 0 && existing < visible) {
    focusPane(existing);
    return;
  }
  placeInSlot(state.focusedPane, ref);
}

$btnAddServer.addEventListener('click', () => {
  $serverError.textContent = '';
  $formServer.reset();
  $modalServer.showModal();
});

const $app = document.querySelector('.app') as HTMLElement;

// Platform-aware modifier glyphs for shortcut labels. Mac shows `⌘`, all other
// platforms show `Ctrl`. We rewrite the legend in the empty hero and the topbar
// button titles at boot so the displayed shortcuts match what actually works.
// The keyboard handler itself accepts both ctrlKey and metaKey on every
// platform — only the *display* is platform-conditional.
const IS_MAC = /Mac|iPhone|iPad|iPod/i.test(
  (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform ??
    '',
);

/** Replace `⌘⇧` → `Ctrl+Shift+` and `⌘` → `Ctrl+` on non-Mac. No-op on Mac. */
function modGlyph(s: string): string {
  if (IS_MAC) return s;
  return s.replace(/⌘⇧/g, 'Ctrl+Shift+').replace(/⌘/g, 'Ctrl+');
}

function localizeShortcuts() {
  // Rewrite legend text in the empty hero (and any other element marked with
  // [data-shortcut]) so non-Mac users see Ctrl-prefixed labels.
  for (const el of document.querySelectorAll<HTMLElement>('.empty__legend span')) {
    el.textContent = modGlyph(el.textContent ?? '');
  }
  for (const el of document.querySelectorAll<HTMLElement>('[title*="⌘"]')) {
    const t = el.getAttribute('title');
    if (t) el.setAttribute('title', modGlyph(t));
  }
}
localizeShortcuts();

function applySidebarState() {
  const collapsed = state.sidebarCollapsed;
  $app.dataset.sidebar = collapsed ? 'collapsed' : 'expanded';
  $btnSidebar.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  $btnSidebar.title = modGlyph(collapsed ? 'show sidebar (⌘B)' : 'hide sidebar (⌘B)');
}

function toggleSidebar() {
  state.sidebarCollapsed = !state.sidebarCollapsed;
  persist();
  // Use the View Transitions API when available so the layout shift is
  // composited as a snapshot crossfade/slide instead of relayouting the
  // grid (and repainting xterm) on every frame. Falls back to an instant
  // snap on browsers without the API.
  const startVT = (document as Document & {
    startViewTransition?: (cb: () => void) => unknown;
  }).startViewTransition;
  if (typeof startVT === 'function') {
    startVT.call(document, () => applySidebarState());
  } else {
    applySidebarState();
  }
}

$btnSidebar.addEventListener('click', toggleSidebar);

function focusedNode(): TerminalNode | null {
  const ref = state.activeNodes[state.focusedPane];
  if (!ref) return null;
  return nodes.get(nodeKey(ref.serverId, ref.sessionId)) ?? null;
}

function focusedRef(): NodeRef | null {
  return state.activeNodes[state.focusedPane] ?? null;
}

function downloadBlob(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
}

function snapshotFocusedNode(format: 'txt' | 'html') {
  const node = focusedNode();
  const ref = focusedRef();
  if (!node || !ref) return;
  const safeTitle = (ref.title || 'node').replace(/[^a-z0-9._-]+/gi, '-').slice(0, 60);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  if (format === 'html') {
    const docTitle = `${ref.title || 'maestro node'} · ${stamp}`;
    downloadBlob(
      node.serializeAsHTML(docTitle),
      `${safeTitle}-${stamp}.html`,
      'text/html;charset=utf-8',
    );
  } else {
    downloadBlob(
      node.serialize(),
      `${safeTitle}-${stamp}.txt`,
      'text/plain;charset=utf-8',
    );
  }
}

// Global hotkeys. Captured at the document level (capture phase) so xterm
// doesn't swallow them, and gated on `dialog[open]` so they can't fire from
// inside a modal form.
//
// Modifier convention: we accept either `ctrlKey` (Windows/Linux) or `metaKey`
// (macOS Cmd) and require Alt to be unpressed. `e.key.toLowerCase()` normalizes
// the letter — on every platform, e.g. Ctrl+Shift+S sets `e.key` to "S"
// (uppercase, because Shift is held) and we lowercase to compare. This keeps
// the same handler working on macOS, Windows, and Linux.
//
// Conflicts with browser defaults (all blocked here via preventDefault +
// stopPropagation in capture phase):
//   - Ctrl/Cmd+F  — browser "Find in page" (we override; xterm's buffer is
//                   not text-selectable by the browser anyway, so the addon-
//                   search overlay is the meaningful equivalent).
//   - Ctrl/Cmd+Shift+S — Firefox's screenshot tool on Windows/Linux.
//   - Ctrl/Cmd+Shift+H — Firefox's History library window on Windows/Linux.
// None of these are OS-reserved (unlike Ctrl+N / Ctrl+T / Ctrl+W which the
// browser keeps for itself), so preventDefault is sufficient.
document.addEventListener(
  'keydown',
  (e) => {
    if (document.querySelector('dialog[open]')) return;
    const mod = e.ctrlKey || e.metaKey;
    if (!mod || e.altKey) return;
    const key = e.key.toLowerCase();

    // ⌘/Ctrl+B — toggle sidebar
    if (!e.shiftKey && key === 'b') {
      e.preventDefault();
      e.stopPropagation();
      toggleSidebar();
      return;
    }

    // ⌘/Ctrl+F — open find-in-node on focused pane.
    if (!e.shiftKey && key === 'f') {
      const node = focusedNode();
      if (!node) return;
      e.preventDefault();
      e.stopPropagation();
      node.toggleSearch();
      return;
    }

    // ⌘/Ctrl+Shift+S — snapshot focused node as .txt (ANSI preserved).
    if (e.shiftKey && key === 's') {
      if (!focusedNode()) return;
      e.preventDefault();
      e.stopPropagation();
      snapshotFocusedNode('txt');
      return;
    }

    // ⌘/Ctrl+Shift+H — snapshot focused node as .html (styled).
    if (e.shiftKey && key === 'h') {
      if (!focusedNode()) return;
      e.preventDefault();
      e.stopPropagation();
      snapshotFocusedNode('html');
      return;
    }
  },
  true,
);

$layoutSwitch.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('button[data-mode]') as HTMLButtonElement | null;
  if (!btn) return;
  const mode = btn.dataset.mode as LayoutMode | undefined;
  if (mode && mode in PANE_COUNT) setLayoutMode(mode);
});

// Node action buttons: same code path as the global hotkeys. Buttons are
// gated by [disabled] when no node is focused, but we also defensively check
// focusedNode() before acting (matches the keyboard path).
$nodeActions.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('button[data-act]') as HTMLButtonElement | null;
  if (!btn || btn.disabled) return;
  const node = focusedNode();
  if (!node) return;
  switch (btn.dataset.act) {
    case 'find':
      node.toggleSearch();
      break;
    case 'save-txt':
      snapshotFocusedNode('txt');
      break;
    case 'save-html':
      snapshotFocusedNode('html');
      break;
  }
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
$modalServer.addEventListener('click', closeOnBackdrop($modalServer));
$modalNode.addEventListener('click', closeOnBackdrop($modalNode));

function closeOnBackdrop(modal: HTMLDialogElement) {
  return (e: MouseEvent) => {
    if ((e.target as HTMLElement).dataset.close !== undefined) modal.close();
  };
}
$formNode.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!nodeModalServerId) return;
  const fd = new FormData($formNode);
  const title = String(fd.get('title') ?? '').trim();
  const cwd = String(fd.get('cwd') ?? '').trim();
  const rawAgent = String(fd.get('agentType') ?? 'claude');
  const agentType: AgentType = (AGENT_TYPES as readonly string[]).includes(rawAgent)
    ? (rawAgent as AgentType)
    : 'claude';
  if (!cwd) {
    $nodeError.textContent = 'working directory is required';
    return;
  }
  $nodeError.textContent = 'spawning…';
  try {
    await createNode(nodeModalServerId, { title: title || undefined, cwd, agentType });
  } catch (err) {
    $nodeError.textContent = `failed: ${(err as Error).message}`;
    return;
  }
  $nodeError.textContent = '';
  state.lastAgentType = { ...state.lastAgentType, [nodeModalServerId]: agentType };
  persist();
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

applySidebarState();

// Reattach previously-active nodes so reload restores the working layout.
// Eagerly construct TerminalNodes for assigned slots so their WS kicks in.
for (const ref of state.activeNodes) {
  if (ref) getOrCreateNode(ref);
}
renderPanes();

scheduleRender();
refreshAll();

setTimeout(() => document.querySelector('.app')?.removeAttribute('data-boot'), 1500);

setInterval(() => {
  if (document.hidden) return;
  for (const s of state.servers) refreshServer(s.id);
}, 10_000);
