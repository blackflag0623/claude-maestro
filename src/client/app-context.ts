// Shared runtime state + DOM refs + primitive helpers for the desktop client.
//
// Every UI module (sidebar, topbar, pane-manager, modals, hotkeys, …) reads
// and mutates state through this module. The split mirrors how the server
// keeps its session map + helpers at module scope in `src/server/index.ts`:
// a thin, well-known surface that every concern shares, with no business
// logic of its own.

import { MaestroApi } from '../client-shared/api';
import type { TerminalNode } from './node';
import type { FileExplorer } from './file-explorer';
import {
  loadState,
  saveState,
  PANE_COUNT,
  MAX_PANES,
  type NodeRef,
  type PersistedState,
} from './state';
import type { SessionInfo } from '../shared/protocol';

export type ServerHealth = 'online' | 'offline' | 'unknown';

export interface ServerRuntime {
  api: MaestroApi;
  health: ServerHealth;
  sessions: SessionInfo[];
}

// ───────── mutable shared state ─────────

// `state` is exported as a mutable binding via getter/setter so other modules
// always read the current value (TS `export let` would also work but a getter
// is more obvious at call sites). Mutation in place is permitted for hot paths
// (e.g. `state.layoutMode = …`); call `persist()` afterwards.
let _state: PersistedState = loadState();

export function getState(): PersistedState {
  return _state;
}

export function setState(next: PersistedState): void {
  _state = next;
}

export const servers = new Map<string, ServerRuntime>();
export const nodes = new Map<string, TerminalNode>(); // key from `nodeKey`
export const explorers = new Map<string, FileExplorer>(); // key from `nodeKey`
export const explorerOpen = new Set<string>(); // nodeKey set: explorer currently open

export const bootedAt = Date.now();

// ───────── DOM references ─────────
//
// Resolved once at module load; the layout HTML in `index.html` is guaranteed
// to be present before this module runs because it is loaded as a `<script
// type="module">` at the end of `<body>`. Casts are safe because we own the
// markup.

export const $serverList = document.getElementById('server-list') as HTMLUListElement;
export const $crumbs = document.getElementById('crumbs') as HTMLDivElement;
export const $status = document.getElementById('status') as HTMLSpanElement;
export const $stage = document.getElementById('stage') as HTMLDivElement;
export const $panes = document.getElementById('panes') as HTMLDivElement;
export const $empty = document.getElementById('empty') as HTMLDivElement;
export const $layoutSwitch = document.getElementById('layout-switch') as HTMLDivElement;
export const $nodeActions = document.getElementById('node-actions') as HTMLDivElement;
export const $btnSidebar = document.getElementById('btn-sidebar') as HTMLButtonElement;
export const $btnAddServer = document.getElementById('btn-add-server') as HTMLButtonElement;
export const $btnExport = document.getElementById('btn-export') as HTMLButtonElement;
export const $btnImport = document.getElementById('btn-import') as HTMLButtonElement;
export const $importFile = document.getElementById('import-file') as HTMLInputElement;
export const $modalServer = document.getElementById('modal-server') as HTMLDialogElement;
export const $modalNode = document.getElementById('modal-node') as HTMLDialogElement;
export const $formNode = document.getElementById('form-node') as HTMLFormElement;
export const $nodeServerLabel = document.getElementById('node-server-label') as HTMLParagraphElement;
export const $nodeError = document.getElementById('node-error') as HTMLParagraphElement;
export const $formServer = document.getElementById('form-server') as HTMLFormElement;
export const $serverError = document.getElementById('server-error') as HTMLParagraphElement;
export const $hudServers = document.getElementById('hud-servers') as HTMLElement;
export const $hudNodes = document.getElementById('hud-nodes') as HTMLElement;
export const $hudUptime = document.getElementById('hud-uptime') as HTMLElement;
export const $stageTag = document.querySelector('.mark--tag') as HTMLElement | null;
export const $app = document.querySelector('.app') as HTMLElement;
export const $sidebarEl = document.querySelector<HTMLElement>('.sidebar');

// ───────── primitive helpers ─────────

export const nodeKey = (serverId: string, sessionId: string) => `${serverId}::${sessionId}`;

/** A NodeRef is "active" if it occupies any visible pane in the current layout. */
export function isActive(ref: NodeRef): boolean {
  const count = PANE_COUNT[_state.layoutMode];
  for (let i = 0; i < count; i++) {
    const a = _state.activeNodes[i];
    if (a && a.serverId === ref.serverId && a.sessionId === ref.sessionId) return true;
  }
  return false;
}

/** Returns the slot index that currently hosts the given ref, or -1.
 *  Searches all MAX_PANES slots (including stashed slots beyond the visible
 *  range) so we can detect duplicates across layout changes. */
export function findSlotOf(ref: NodeRef): number {
  for (let i = 0; i < MAX_PANES; i++) {
    const a = _state.activeNodes[i];
    if (a && a.serverId === ref.serverId && a.sessionId === ref.sessionId) return i;
  }
  return -1;
}

export function runtimeFor(serverId: string): ServerRuntime {
  let rt = servers.get(serverId);
  if (rt) return rt;
  const srv = _state.servers.find((s) => s.id === serverId);
  if (!srv) throw new Error(`unknown server ${serverId}`);
  rt = { api: new MaestroApi(srv.baseUrl), health: 'unknown', sessions: [] };
  servers.set(serverId, rt);
  return rt;
}

export function persist(): void {
  saveState(_state);
}

// ───────── render scheduling ─────────
//
// `main.ts` registers the actual render callback at boot via
// `setRenderCallback`. Any UI module can call `scheduleRender()` and the
// next animation frame will run all registered renderers. Coalesces multiple
// calls in one tick into a single repaint.

let renderScheduled = false;
let renderCallback: () => void = () => {};

export function setRenderCallback(fn: () => void): void {
  renderCallback = fn;
}

export function scheduleRender(): void {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    renderCallback();
  });
}
