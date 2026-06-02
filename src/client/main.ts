// Boot orchestrator for the desktop portal.
//
// Wires the render callback (so any module can call `scheduleRender()` from
// app-context), installs once-per-app event listeners owned by the various
// submodules, seeds a `local` server on first run, mounts previously-active
// nodes, and starts the 10 s polling interval.
//
// All business logic lives in the submodules listed below — this file
// should stay small and obviously-correct.

import {
  $app,
  $btnSidebar,
  getState,
  persist,
  scheduleRender,
  setRenderCallback,
} from './app-context';
import { uuid } from './state';
import { renderSidebar } from './sidebar';
import { renderHud, renderStageTag, renderTopbar, localizeShortcuts, tickUptime } from './topbar';
import { getOrCreateNode, renderPaneStates, renderPanes } from './pane-manager';
import { applySidebarState, toggleSidebar } from './sidebar-toggle';
import { installServerPopupGlobalListeners } from './server-popup';
import { installModals } from './modals';
import { installHotkeys } from './hotkeys';
import { refreshAll, refreshServer } from './server-actions';

// ───────── render wiring ─────────

setRenderCallback(() => {
  renderSidebar();
  renderTopbar();
  renderHud();
  renderStageTag();
  renderPaneStates();
});

// ───────── boot ─────────

// Shortcut labels need to be platform-aware before any topbar render reads
// the button titles, and before the sidebar-toggle button gets its initial
// title text.
localizeShortcuts();

// Topbar uptime counter (started before render so the first paint shows
// 00:00:00 rather than blank).
setInterval(tickUptime, 1000);
tickUptime();

installServerPopupGlobalListeners();
installModals();
installHotkeys();

$btnSidebar.addEventListener('click', toggleSidebar);

// First-run seed: a `local` server pointing at the current origin. The user
// can rename it or remove it later.
const state = getState();
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

// Lift the `data-boot` flag from `.app` once the first render settled. The
// flag is used by CSS to suppress entry animations during boot.
setTimeout(() => $app.removeAttribute('data-boot'), 1500);

// Periodic server health probe. Pauses while the tab is in the background
// so we don't burn battery polling N servers every 10 s on a hidden tab.
setInterval(() => {
  if (document.hidden) return;
  for (const s of getState().servers) refreshServer(s.id);
}, 10_000);
