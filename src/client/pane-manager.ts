// Pane / layout management. Owns:
//   - the panes container DOM (build, rebuild, lightweight refresh)
//   - per-session TerminalNode and FileExplorer factories (lazy create, reuse
//     across pane re-renders so xterm/WS stay alive)
//   - layout mode switching + slot placement (place/detach/focus/select)
//
// Cross-module note: pane drop handlers need to know whether a node drag is
// in flight, so we import `isDragging`/`currentDrag` from drag-reorder.

import { escapeHtml } from '../client-shared/html';
import {
  $empty,
  $panes,
  $stage,
  explorerOpen,
  explorers,
  findSlotOf,
  getState,
  nodeKey,
  nodes,
  persist,
  runtimeFor,
  scheduleRender,
} from './app-context';
import { TerminalNode } from './node';
import { FileExplorer } from './file-explorer';
import { currentDrag } from './drag-reorder';
import { PANE_COUNT, type LayoutMode, type NodeRef } from './state';

export function getOrCreateNode(ref: NodeRef): TerminalNode {
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
      const state = getState();
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

// ──────── explorer column width (persisted, shared across panes) ────────
const EXPLORER_WIDTH_KEY = 'maestro:explorerWidth';
const EXPLORER_MIN = 220;
const EXPLORER_MAX_FRAC = 0.85; // never let term shrink below 15% of pane
function loadExplorerWidth(): number {
  const raw = Number(localStorage.getItem(EXPLORER_WIDTH_KEY));
  return Number.isFinite(raw) && raw >= EXPLORER_MIN ? raw : 320;
}
let explorerWidth = loadExplorerWidth();
function applyExplorerWidth(pane: HTMLElement): void {
  pane.style.setProperty('--explorer-w', `${explorerWidth}px`);
}
function attachExplorerResize(pane: HTMLElement, resizer: HTMLElement): void {
  applyExplorerWidth(pane);
  resizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const body = pane.querySelector<HTMLElement>('.pane__body.is-split');
    if (!body) return;
    const bodyRect = body.getBoundingClientRect();
    const maxW = Math.floor(bodyRect.width * EXPLORER_MAX_FRAC);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const move = (ev: MouseEvent) => {
      const next = Math.max(EXPLORER_MIN, Math.min(maxW, bodyRect.right - ev.clientX));
      explorerWidth = next;
      // Apply to every pane that currently has an explorer open.
      for (const p of document.querySelectorAll<HTMLElement>('.pane')) applyExplorerWidth(p);
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      localStorage.setItem(EXPLORER_WIDTH_KEY, String(explorerWidth));
      // Let the terminal refit its grid to the new width.
      window.dispatchEvent(new Event('resize'));
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
}

export function toggleExplorer(ref: NodeRef): void {
  const key = nodeKey(ref.serverId, ref.sessionId);
  const opening = !explorerOpen.has(key);
  if (opening) {
    explorerOpen.add(key);
    // The explorer is hard to read in split/grid layouts (narrow column,
    // tiny viewer). Force single-pane and promote this ref into slot 0 so
    // the user sees the explorer for the pane they actually clicked.
    const state = getState();
    if (state.layoutMode !== 'single') {
      state.layoutMode = 'single';
      const next = state.activeNodes.slice();
      const existing = next.findIndex(
        (r) => r && r.serverId === ref.serverId && r.sessionId === ref.sessionId,
      );
      if (existing > 0) {
        next[existing] = next[0] ?? null;
      }
      next[0] = ref;
      state.activeNodes = next;
      state.focusedPane = 0;
      persist();
    }
  } else {
    explorerOpen.delete(key);
  }
  renderPanes();
  scheduleRender();
}

/** Tear down every TerminalNode + FileExplorer associated with a server.
 *  Used by `removeServer` before purging the server from state. */
export function destroyNodesForServer(serverId: string): void {
  for (const [key, n] of nodes) {
    if (key.startsWith(`${serverId}::`)) {
      n.destroy();
      nodes.delete(key);
      explorers.get(key)?.destroy();
      explorers.delete(key);
      explorerOpen.delete(key);
    }
  }
}

/** Tear down a single TerminalNode + FileExplorer by ids. Used by killNode. */
export function destroyNode(serverId: string, sessionId: string): void {
  const key = nodeKey(serverId, sessionId);
  nodes.get(key)?.destroy();
  nodes.delete(key);
  explorers.get(key)?.destroy();
  explorers.delete(key);
  explorerOpen.delete(key);
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
export function renderPanes(): void {
  const state = getState();
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
  const state = getState();
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
          (openExp
            ? '<div class="pane__resizer" data-role="resizer" title="drag to resize"></div>' +
              '<div class="pane__explorer" data-role="explorer"></div>'
            : '')
        : '<span class="pane__hint">empty — pick a node from the sidebar, or drop one here</span>'
    }</div>
  `;

  pane.addEventListener('mousedown', (e) => {
    if ((e.target as HTMLElement).closest('.pane__close')) return;
    if ((e.target as HTMLElement).closest('.pane__files')) return;
    if (slot !== getState().focusedPane) focusPane(slot);
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
    const resizer = pane.querySelector<HTMLElement>('.pane__resizer');
    if (resizer) attachExplorerResize(pane, resizer);
  }

  // Accept drag-drop of a sidebar node onto this pane.
  pane.addEventListener('dragover', (e) => {
    const drag = currentDrag();
    if (!drag || drag.kind !== 'node') return;
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
    const drag = currentDrag();
    if (!drag || drag.kind !== 'node') return;
    e.preventDefault();
    e.stopPropagation();
    const list = getState().knownNodes[drag.serverId];
    const dropped = list?.find((n) => n.sessionId === drag.sessionId);
    if (!dropped) return;
    placeInSlot(slot, dropped);
  });

  return pane;
}

/** Lightweight refresh of pane head data attributes + labels without rebuilding
 *  the pane DOM (which would tear down mounted terminals). */
export function renderPaneStates(): void {
  const state = getState();
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

function updateEmptyHero(): void {
  const state = getState();
  const anyFilled = state.activeNodes.some((n) => !!n);
  const showHero = state.layoutMode === 'single' && !anyFilled;
  $empty.classList.toggle('is-hidden', !showHero);
}

function refreshFocusedPaneFocus(): void {
  const state = getState();
  const ref = state.activeNodes[state.focusedPane];
  if (!ref) return;
  const node = nodes.get(nodeKey(ref.serverId, ref.sessionId));
  if (node) requestAnimationFrame(() => node.term.focus());
}

export function setLayoutMode(mode: LayoutMode): void {
  const state = getState();
  if (state.layoutMode === mode) return;
  state.layoutMode = mode;
  if (state.focusedPane >= PANE_COUNT[mode]) state.focusedPane = 0;
  // Switching to a multi-pane layout closes any open file explorers — the
  // explorer is only useful in single-pane mode (see `toggleExplorer`).
  if (mode !== 'single') explorerOpen.clear();
  persist();
  renderPanes();
  scheduleRender();
}

/** Place `ref` into pane `slot`. If `ref` already occupies a different slot,
 *  swap the contents (avoids ever having the same TerminalNode in two slots).
 *  Always focuses `slot` after the move. */
export function placeInSlot(slot: number, ref: NodeRef): void {
  const state = getState();
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

export function detachSlot(slot: number): void {
  const state = getState();
  if (!state.activeNodes[slot]) return;
  const next = state.activeNodes.slice();
  next[slot] = null;
  state.activeNodes = next;
  persist();
  renderPanes();
  scheduleRender();
}

export function focusPane(slot: number): void {
  const state = getState();
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

export function focusedNode(): TerminalNode | null {
  const state = getState();
  const ref = state.activeNodes[state.focusedPane];
  if (!ref) return null;
  return nodes.get(nodeKey(ref.serverId, ref.sessionId)) ?? null;
}

export function focusedRef(): NodeRef | null {
  const state = getState();
  return state.activeNodes[state.focusedPane] ?? null;
}

export function selectNode(ref: NodeRef): void {
  // Clicking a sidebar node: if it's already mounted, focus that slot;
  // otherwise mount it into the focused pane (replacing whatever was there).
  const state = getState();
  const existing = findSlotOf(ref);
  const visible = PANE_COUNT[state.layoutMode];
  if (existing >= 0 && existing < visible) {
    focusPane(existing);
    return;
  }
  placeInSlot(state.focusedPane, ref);
}
