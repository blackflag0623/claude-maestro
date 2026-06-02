// Global hotkeys + the layout-switch / node-actions topbar button bindings.
// Every keyboard shortcut has an equivalent button so the features are
// discoverable without keyboard knowledge.
//
// Captured at the document level (capture phase) so xterm doesn't swallow
// them, and gated on `dialog[open]` so they can't fire from inside a modal
// form.

import { $layoutSwitch, $nodeActions } from './app-context';
import { PANE_COUNT, type LayoutMode } from './state';
import { focusedNode, focusedRef, setLayoutMode } from './pane-manager';
import { toggleSidebar } from './sidebar-toggle';

function downloadBlob(content: string, filename: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
}

function snapshotFocusedNode(format: 'txt' | 'html'): void {
  const node = focusedNode();
  const ref = focusedRef();
  if (!node || !ref) return;
  const safeTitle = (ref.title || 'node').replace(/[^a-z0-9._-]+/gi, '-').slice(0, 60);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  if (format === 'html') {
    const docTitle = `${ref.title || 'maestro node'} · ${stamp}`;
    downloadBlob(
      node.serializeAsHTML(docTitle),
      `${safeTitle}-${stamp}.html`,
      'text/html;charset=utf-8',
    );
  } else {
    downloadBlob(
      node.serialize(),
      `${safeTitle}-${stamp}.txt`,
      'text/plain;charset=utf-8',
    );
  }
}

/** Install document-level hotkeys + topbar button listeners. Called once at
 *  boot. */
export function installHotkeys(): void {
  // Global hotkeys.
  //
  // Modifier convention: we accept either `ctrlKey` (Windows/Linux) or
  // `metaKey` (macOS Cmd) and require Alt to be unpressed. `e.key.toLowerCase()`
  // normalizes the letter — on every platform, e.g. Ctrl+Shift+S sets `e.key`
  // to "S" (uppercase, because Shift is held) and we lowercase to compare.
  // This keeps the same handler working on macOS, Windows, and Linux.
  //
  // Conflicts with browser defaults (all blocked here via preventDefault +
  // stopPropagation in capture phase):
  //   - Ctrl/Cmd+F  — browser "Find in page" (we override; xterm's buffer is
  //                   not text-selectable by the browser anyway, so the
  //                   addon-search overlay is the meaningful equivalent).
  //   - Ctrl/Cmd+Shift+S — Firefox's screenshot tool on Windows/Linux.
  //   - Ctrl/Cmd+Shift+H — Firefox's History library window on Windows/Linux.
  // None of these are OS-reserved (unlike Ctrl+N / Ctrl+T / Ctrl+W which the
  // browser keeps for itself), so preventDefault is sufficient.
  document.addEventListener(
    'keydown',
    (e) => {
      if (document.querySelector('dialog[open]')) return;
      const mod = e.ctrlKey || e.metaKey;
      if (!mod || e.altKey) return;
      const key = e.key.toLowerCase();

      // ⌘/Ctrl+B — toggle sidebar
      if (!e.shiftKey && key === 'b') {
        e.preventDefault();
        e.stopPropagation();
        toggleSidebar();
        return;
      }

      // ⌘/Ctrl+F — open find-in-node on focused pane.
      if (!e.shiftKey && key === 'f') {
        const node = focusedNode();
        if (!node) return;
        e.preventDefault();
        e.stopPropagation();
        node.toggleSearch();
        return;
      }

      // ⌘/Ctrl+Shift+S — snapshot focused node as .txt (ANSI preserved).
      if (e.shiftKey && key === 's') {
        if (!focusedNode()) return;
        e.preventDefault();
        e.stopPropagation();
        snapshotFocusedNode('txt');
        return;
      }

      // ⌘/Ctrl+Shift+H — snapshot focused node as .html (styled).
      if (e.shiftKey && key === 'h') {
        if (!focusedNode()) return;
        e.preventDefault();
        e.stopPropagation();
        snapshotFocusedNode('html');
        return;
      }
    },
    true,
  );

  $layoutSwitch.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('button[data-mode]') as HTMLButtonElement | null;
    if (!btn) return;
    const mode = btn.dataset.mode as LayoutMode | undefined;
    if (mode && mode in PANE_COUNT) setLayoutMode(mode);
  });

  // Node action buttons: same code path as the global hotkeys. Buttons are
  // gated by [disabled] when no node is focused, but we also defensively
  // check focusedNode() before acting (matches the keyboard path).
  $nodeActions.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('button[data-act]') as HTMLButtonElement | null;
    if (!btn || btn.disabled) return;
    const node = focusedNode();
    if (!node) return;
    switch (btn.dataset.act) {
      case 'find':
        node.toggleSearch();
        break;
      case 'save-txt':
        snapshotFocusedNode('txt');
        break;
      case 'save-html':
        snapshotFocusedNode('html');
        break;
    }
  });
}
