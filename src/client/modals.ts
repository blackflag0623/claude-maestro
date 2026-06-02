// Modal dialogs (server + node) + their form submit wiring, plus the
// export/import bundle handlers (which also live in the topbar but produce
// modal-like file pickers).

import { escapeHtml } from '../client-shared/html';
import {
  $btnAddServer,
  $btnExport,
  $btnImport,
  $formNode,
  $formServer,
  $importFile,
  $modalNode,
  $modalServer,
  $nodeError,
  $nodeServerLabel,
  $serverError,
  getState,
  persist,
  runtimeFor,
  scheduleRender,
  setState,
} from './app-context';
import { MaestroApi } from '../client-shared/api';
import { AGENT_TYPES, type AgentType } from '../shared/protocol';
import { attachPathPicker } from './path-picker';
import { exportBundle, importBundle } from './state';
import { addServer, refreshAll } from './server-actions';
import { createNode } from './node-actions';

let nodeModalServerId: string | null = null;
const cwdInput = $formNode.elements.namedItem('cwd') as HTMLInputElement;
const agentSelect = $formNode.elements.namedItem('agentType') as HTMLSelectElement;
const pathPicker = attachPathPicker(cwdInput);

export function openNodeModal(serverId: string): void {
  nodeModalServerId = serverId;
  const state = getState();
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

function closeOnBackdrop(modal: HTMLDialogElement) {
  return (e: MouseEvent) => {
    if ((e.target as HTMLElement).dataset.close !== undefined) modal.close();
  };
}

/** Install all modal-related event listeners. Idempotent; main.ts calls once
 *  at boot. */
export function installModals(): void {
  $btnAddServer.addEventListener('click', () => {
    $serverError.textContent = '';
    $formServer.reset();
    $modalServer.showModal();
  });

  $modalServer.addEventListener('click', closeOnBackdrop($modalServer));
  $modalNode.addEventListener('click', closeOnBackdrop($modalNode));

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
    const state = getState();
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

  $btnExport.addEventListener('click', () => {
    const bundle = exportBundle(getState());
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
      const next = importBundle(getState(), bundle);
      setState(next.state);
      result = next.result;
    } catch (err) {
      alert(`import failed: ${(err as Error).message}`);
      return;
    }
    persist();
    scheduleRender();
    refreshAll();
    alert(`imported ${result.added} server(s); skipped ${result.skipped} duplicate(s)`);
  });
}

