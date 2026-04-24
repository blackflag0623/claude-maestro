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
}

const KEY = 'maestro:state:v1';

const empty: PersistedState = {
  servers: [],
  activeNode: null,
  knownNodes: {},
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
