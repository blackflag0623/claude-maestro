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

export interface PersistedState {
  servers: ServerEntry[];
  activeNode: NodeRef | null;
  // Persisted per-server node lists so a reload can re-attach. Server is the
  // source of truth for liveness; reconcileNodes merges the two.
  knownNodes: Record<string, NodeRef[]>;
  // Last working directory the user picked when spawning a node on a given
  // server, so the new-node dialog can pre-fill it next time.
  lastCwd: Record<string, string>;
}

const KEY = 'maestro:state:v1';

const empty: PersistedState = {
  servers: [],
  activeNode: null,
  knownNodes: {},
  lastCwd: {},
};

export function loadState(): PersistedState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(empty);
    const parsed = JSON.parse(raw) as PersistedState;
    return {
      servers: parsed.servers ?? [],
      activeNode: parsed.activeNode ?? null,
      knownNodes: parsed.knownNodes ?? {},
      lastCwd: parsed.lastCwd ?? {},
    };
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
  const next: PersistedState = {
    ...state,
    knownNodes: { ...state.knownNodes, [serverId]: known },
  };
  if (
    next.activeNode &&
    next.activeNode.serverId === serverId &&
    !liveIds.has(next.activeNode.sessionId)
  ) {
    next.activeNode = null;
  }
  return next;
}
