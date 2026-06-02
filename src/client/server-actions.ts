// Server-level CRUD: refresh (HTTP probe + session list), add (with health
// pre-check via the form submit), and remove (purges all per-server runtime
// state, including mounted TerminalNodes).

import {
  getState,
  persist,
  runtimeFor,
  scheduleRender,
  servers,
  setState,
} from './app-context';
import { destroyNodesForServer, renderPanes } from './pane-manager';
import { reconcileNodes, uuid, type ServerEntry } from './state';

export async function refreshServer(serverId: string): Promise<void> {
  const rt = runtimeFor(serverId);
  try {
    const sessions = await rt.api.list();
    rt.sessions = sessions;
    rt.health = 'online';
    setState(reconcileNodes(getState(), serverId, sessions));
    persist();
  } catch {
    rt.health = 'offline';
  }
  scheduleRender();
}

export async function refreshAll(): Promise<void> {
  await Promise.all(getState().servers.map((s) => refreshServer(s.id)));
}

export function addServer(name: string, baseUrl: string): void {
  const srv: ServerEntry = { id: uuid(), name: name.trim(), baseUrl: baseUrl.trim() };
  getState().servers.push(srv);
  persist();
  scheduleRender();
  refreshServer(srv.id);
}

export function removeServer(serverId: string): void {
  if (!confirm('Remove this server from the portal? Sessions on the server will keep running.'))
    return;
  destroyNodesForServer(serverId);
  const state = getState();
  state.servers = state.servers.filter((s) => s.id !== serverId);
  delete state.knownNodes[serverId];
  state.activeNodes = state.activeNodes.map((a) => (a && a.serverId === serverId ? null : a));
  servers.delete(serverId);
  persist();
  renderPanes();
  scheduleRender();
}
