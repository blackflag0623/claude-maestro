// Topbar render (breadcrumb + status pulse + layout-switch + node-actions
// disabled state) plus the small auxiliary chrome: HUD counters, stage tag,
// uptime ticker, and platform-aware shortcut label localization.

import { escapeHtml } from '../client-shared/html';
import {
  $crumbs,
  $hudNodes,
  $hudServers,
  $hudUptime,
  $layoutSwitch,
  $nodeActions,
  $stageTag,
  $status,
  bootedAt,
  getState,
  nodeKey,
  nodes,
} from './app-context';
import { PANE_COUNT } from './state';
import type { NodeStatus } from './node';

type TopbarStatus = NodeStatus | 'idle';

// ───────── platform-aware shortcut glyphs ─────────
//
// Mac shows `⌘`, all other platforms show `Ctrl`. We rewrite the legend in
// the empty hero and the topbar button titles at boot so the displayed
// shortcuts match what actually works. The keyboard handler itself accepts
// both `ctrlKey` and `metaKey` on every platform — only the *display* is
// platform-conditional.

export const IS_MAC = /Mac|iPhone|iPad|iPod/i.test(
  (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform ??
    '',
);

/** Replace `⌘⇧` → `Ctrl+Shift+` and `⌘` → `Ctrl+` on non-Mac. No-op on Mac. */
export function modGlyph(s: string): string {
  if (IS_MAC) return s;
  return s.replace(/⌘⇧/g, 'Ctrl+Shift+').replace(/⌘/g, 'Ctrl+');
}

export function localizeShortcuts(): void {
  // Rewrite legend text in the empty hero (and any other element marked with
  // [data-shortcut]) so non-Mac users see Ctrl-prefixed labels.
  for (const el of document.querySelectorAll<HTMLElement>('.empty__legend span')) {
    el.textContent = modGlyph(el.textContent ?? '');
  }
  for (const el of document.querySelectorAll<HTMLElement>('[title*="⌘"]')) {
    const t = el.getAttribute('title');
    if (t) el.setAttribute('title', modGlyph(t));
  }
}

// ───────── topbar render ─────────

export function renderTopbar(): void {
  const state = getState();
  const active = state.activeNodes[state.focusedPane];
  for (const btn of $layoutSwitch.querySelectorAll<HTMLButtonElement>('button[data-mode]')) {
    const isCurrent = btn.dataset.mode === state.layoutMode;
    if (isCurrent) btn.setAttribute('aria-current', 'true');
    else btn.removeAttribute('aria-current');
  }
  // Enable node-action buttons only when there's a focused node to act on.
  // Disabling is purely visual/click guard — the keyboard shortcuts share
  // the same focusedNode() gate so the two surfaces stay in sync.
  const hasActive = !!active;
  for (const btn of $nodeActions.querySelectorAll<HTMLButtonElement>('button[data-act]')) {
    btn.disabled = !hasActive;
  }
  if (!active) {
    const count = PANE_COUNT[state.layoutMode];
    const label =
      count === 1 ? 'no node selected' : `slot ${state.focusedPane + 1} · empty`;
    $crumbs.innerHTML = `<span class="crumb crumb--muted">${escapeHtml(label)}</span>`;
    setStatus('idle');
    return;
  }
  const srv = state.servers.find((s) => s.id === active.serverId);
  // Identity block reads as one cohesive phrase:
  //   [● SERVER]  →  node-title
  // The dot is the same lime indicator used in the sidebar, so identity
  // continuity across surfaces is preserved. The arrow is an italic serif
  // glyph — same brand voice as the empty-state hero.
  $crumbs.innerHTML = `
    <span class="crumb crumb--server">
      <span class="crumb__dot" aria-hidden="true"></span>
      <span class="crumb__name">${escapeHtml(srv?.name ?? '?')}</span>
    </span>
    <span class="crumb crumb--sep" aria-hidden="true">→</span>
    <span class="crumb crumb--active">${escapeHtml(active.title)}</span>
  `;
  setStatus(nodes.get(nodeKey(active.serverId, active.sessionId))?.status ?? 'connecting');
}

export function setStatus(s: TopbarStatus): void {
  $status.dataset.state = s;
  $status.querySelector('.status__label')!.textContent = s;
}

// ───────── HUD + stage tag ─────────

export function renderHud(): void {
  const state = getState();
  $hudServers.textContent = String(state.servers.length).padStart(2, '0');
  let total = 0;
  for (const list of Object.values(state.knownNodes)) total += list.length;
  $hudNodes.textContent = String(total).padStart(2, '0');
}

export function renderStageTag(): void {
  if (!$stageTag) return;
  const state = getState();
  const a = state.activeNodes[state.focusedPane];
  if (a) {
    $stageTag.textContent = `stage / ${a.title} · ${a.sessionId.slice(0, 8)}`;
  } else {
    $stageTag.textContent = `stage / ${state.layoutMode}`;
  }
}

// ───────── uptime ticker ─────────

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function tickUptime(): void {
  const s = Math.floor((Date.now() - bootedAt) / 1000);
  const hh = pad2(Math.floor(s / 3600));
  const mm = pad2(Math.floor((s % 3600) / 60));
  const ss = pad2(s % 60);
  $hudUptime.textContent = `${hh}:${mm}:${ss}`;
}
