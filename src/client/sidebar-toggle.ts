// Sidebar collapse/expand state + toggle. Uses the View Transitions API
// when available so the layout shift is composited as a snapshot crossfade
// instead of relayouting the grid (and repainting xterm) on every frame.

import { $app, $btnSidebar, getState, persist } from './app-context';
import { modGlyph } from './topbar';

export function applySidebarState(): void {
  const collapsed = getState().sidebarCollapsed;
  $app.dataset.sidebar = collapsed ? 'collapsed' : 'expanded';
  $btnSidebar.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  $btnSidebar.title = modGlyph(collapsed ? 'show sidebar (⌘B)' : 'hide sidebar (⌘B)');
}

export function toggleSidebar(): void {
  const state = getState();
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
