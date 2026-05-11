import type { SessionInfo } from '../shared/protocol';

export interface ServerEntry {
  id: string;          // local uuid
  name: string;        // user-supplied label
  baseUrl: string;     // e.g. http://localhost:4050
}

export interface NodeRef {
  serverId: string;
  sessionId: string;
  title: string;
}

export type LayoutMode = 'single' | 'split-2' | 'grid-4';

/** Number of visible panes per layout mode. The activeNodes array is
 *  always length MAX_PANES so switching modes preserves stashed assignments. */
export const PANE_COUNT: Record<LayoutMode, number> = {
  single: 1,
  'split-2': 2,
  'grid-4': 4,
};
export const MAX_PANES = 4;

export interface PersistedState {
  servers: ServerEntry[];
  /** Current screen layout. */
  layoutMode: LayoutMode;
  /** Fixed-length pane assignment (length === MAX_PANES). Each entry is the
   *  NodeRef mounted in that slot, or null for an empty slot. Only the first
   *  PANE_COUNT[layoutMode] slots are visible; the rest are stashed. */
  activeNodes: (NodeRef | null)[];
  /** Index of the pane that receives sidebar-click "mount here" and that the
   *  topbar crumb/status reflects. */
  focusedPane: number;
  /** Whether the left sidebar is collapsed (hidden) to give the stage more
   *  room. Toggled by the topbar button or ⌘/Ctrl+B. */
  sidebarCollapsed: boolean;
  // Persisted per-server node lists so a reload can re-attach. Server is the
  // source of truth for liveness; reconcileNodes merges the two.
  knownNodes: Record<string, NodeRef[]>;
  // Last working directory the user picked when spawning a node on a given
  // server, so the new-node dialog can pre-fill it next time.
  lastCwd: Record<string, string>;
}

const KEY = 'maestro:state:v1';

function emptyActiveNodes(): (NodeRef | null)[] {
  return Array.from({ length: MAX_PANES }, () => null);
}

const empty: PersistedState = {
  servers: [],
  layoutMode: 'single',
  activeNodes: emptyActiveNodes(),
  focusedPane: 0,
  sidebarCollapsed: false,
  knownNodes: {},
  lastCwd: {},
};

export function loadState(): PersistedState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(empty);
    const parsed = JSON.parse(raw) as Partial<PersistedState> & { activeNode?: NodeRef | null };
    const merged: PersistedState = { ...structuredClone(empty), ...parsed };

    // Migrate legacy single-pane activeNode → activeNodes[0].
    const legacy = parsed.activeNode;
    const incoming = Array.isArray(parsed.activeNodes) ? parsed.activeNodes : null;
    if (!incoming && legacy) {
      merged.activeNodes = emptyActiveNodes();
      merged.activeNodes[0] = legacy;
    } else {
      const arr = (incoming ?? []).slice(0, MAX_PANES) as (NodeRef | null)[];
      while (arr.length < MAX_PANES) arr.push(null);
      merged.activeNodes = arr;
    }

    if (!(merged.layoutMode in PANE_COUNT)) merged.layoutMode = 'single';
    if (
      typeof merged.focusedPane !== 'number' ||
      merged.focusedPane < 0 ||
      merged.focusedPane >= MAX_PANES
    ) {
      merged.focusedPane = 0;
    }
    // Clamp focusedPane to visible range for current layout.
    if (merged.focusedPane >= PANE_COUNT[merged.layoutMode]) merged.focusedPane = 0;
    if (typeof merged.sidebarCollapsed !== 'boolean') merged.sidebarCollapsed = false;

    // Strip the legacy key so it doesn't linger.
    delete (merged as { activeNode?: unknown }).activeNode;
    return merged;
  } catch {
    return structuredClone(empty);
  }
}

export function saveState(s: PersistedState) {
  localStorage.setItem(KEY, JSON.stringify(s));
}

export function uuid(): string {
  return crypto.randomUUID();
}

export interface ExportBundle {
  format: 'claude-maestro/servers';
  version: 1;
  exportedAt: string;
  servers: { name: string; baseUrl: string }[];
}

export function exportBundle(s: PersistedState): ExportBundle {
  return {
    format: 'claude-maestro/servers',
    version: 1,
    exportedAt: new Date().toISOString(),
    servers: s.servers.map(({ name, baseUrl }) => ({ name, baseUrl })),
  };
}

export interface ImportResult {
  added: number;
  skipped: number;
}

export function importBundle(
  state: PersistedState,
  raw: unknown,
): { state: PersistedState; result: ImportResult } {
  if (
    !raw ||
    typeof raw !== 'object' ||
    (raw as ExportBundle).format !== 'claude-maestro/servers' ||
    !Array.isArray((raw as ExportBundle).servers)
  ) {
    throw new Error('not a claude-maestro server bundle');
  }
  const incoming = (raw as ExportBundle).servers;
  const seen = new Set(state.servers.map((s) => s.baseUrl.replace(/\/+$/, '')));
  let added = 0;
  let skipped = 0;
  const next = { ...state, servers: [...state.servers] };
  for (const entry of incoming) {
    if (!entry || typeof entry.baseUrl !== 'string' || typeof entry.name !== 'string') {
      skipped++;
      continue;
    }
    const url = entry.baseUrl.trim().replace(/\/+$/, '');
    if (!url || seen.has(url)) {
      skipped++;
      continue;
    }
    next.servers.push({ id: uuid(), name: entry.name.trim() || 'imported', baseUrl: url });
    seen.add(url);
    added++;
  }
  return { state: next, result: { added, skipped } };
}

export function reconcileNodes(
  state: PersistedState,
  serverId: string,
  live: SessionInfo[],
): PersistedState {
  const liveIds = new Set(live.map((s) => s.id));
  const known = (state.knownNodes[serverId] ?? []).filter((n) => liveIds.has(n.sessionId));
  for (const s of live) {
    if (!known.some((k) => k.sessionId === s.id)) {
      known.push({ serverId, sessionId: s.id, title: s.title });
    }
  }
  const activeNodes = state.activeNodes.map((n) =>
    n && n.serverId === serverId && !liveIds.has(n.sessionId) ? null : n,
  );
  return {
    ...state,
    knownNodes: { ...state.knownNodes, [serverId]: known },
    activeNodes,
  };
}
