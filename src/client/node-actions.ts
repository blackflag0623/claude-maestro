// Per-node CRUD operations triggered from sidebar / modals.
//
// `createNode` is invoked by the node-modal form submit; `killNode` by the
// sidebar's per-node × button (with a confirm prompt). Both end by calling
// pane-manager helpers to update mounted DOM.

import type { AgentType } from '../shared/protocol';
import {
  getState,
  persist,
  runtimeFor,
  scheduleRender,
} from './app-context';
import {
  destroyNode,
  renderPanes,
  selectNode,
} from './pane-manager';
import { refreshServer } from './server-actions';
import type { NodeRef } from './state';

export async function createNode(
  serverId: string,
  body: { title?: string; cwd: string; agentType?: AgentType },
): Promise<void> {
  const rt = runtimeFor(serverId);
  const session = await rt.api.create(body);
  const state = getState();
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

export async function killNode(serverId: string, sessionId: string): Promise<void> {
  if (!confirm('Kill this node? The PTY and the agent process will terminate.')) return;
  try {
    await runtimeFor(serverId).api.kill(sessionId);
  } catch (err) {
    alert(`failed to kill node: ${(err as Error).message}`);
    return;
  }
  destroyNode(serverId, sessionId);
  const state = getState();
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
