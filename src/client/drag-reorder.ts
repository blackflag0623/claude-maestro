// Drag-to-reorder for sidebar servers and per-server nodes, plus accepting
// node drops onto panes. Real-time DOM reordering with FLIP animations so
// siblings slide smoothly; state is only committed on drop. On cancel (Esc /
// drop outside any valid target) the original DOM order is restored.
//
// Pane drop acceptance is wired by pane-manager.ts (it imports `isDragging`
// and the `DragRef` type from here).

import { $serverList, getState, persist, scheduleRender } from './app-context';
import type { NodeRef, ServerEntry } from './state';
import { closeServerPopup } from './server-popup';
import { flushSidebarIfPending, sidebarHasPendingRender } from './sidebar';

export type DragRef =
  | { kind: 'server'; serverId: string }
  | { kind: 'node'; serverId: string; sessionId: string };

let dragging: DragRef | null = null;
// Snapshot used to restore the DOM order if a drag is cancelled (Esc, drop
// outside any valid target). We do NOT mutate state during dragover — only
// the DOM moves in real time. On drop, the existing reorder helpers commit
// state from the drag target reference; on cancel, we put children back.
let dragOriginalOrder: HTMLElement[] | null = null;
let dragOriginalParent: HTMLElement | null = null;
let dragDropCommitted = false;

export function isDragging(): boolean {
  return dragging !== null;
}

export function currentDrag(): DragRef | null {
  return dragging;
}

/** FLIP-animate a reorder inside `parent`. Snapshot rects, run the mutation
 *  (which moves children around in DOM order), then for each sibling whose
 *  position changed, apply the inverted delta as a transform and animate it
 *  back to zero via the CSS transition on `transform`. The dragged element
 *  is excluded so its position doesn't fight the browser-rendered drag ghost. */
function flipReorder(parent: HTMLElement, doMove: () => void, exclude: HTMLElement | null): void {
  const siblings = (Array.from(parent.children) as HTMLElement[]).filter((el) => el !== exclude);
  const firstRects = new Map<HTMLElement, DOMRect>();
  for (const el of siblings) firstRects.set(el, el.getBoundingClientRect());
  // Clear any in-flight transforms so the post-move measurement reflects the
  // natural new layout, not a transform-offset position from a prior FLIP.
  for (const el of siblings) {
    el.style.transition = 'none';
    el.style.transform = '';
  }
  doMove();
  // Force layout so the next getBoundingClientRect reads the moved positions.
  void parent.offsetHeight;
  for (const el of siblings) {
    const first = firstRects.get(el)!;
    const last = el.getBoundingClientRect();
    const dy = first.top - last.top;
    if (Math.abs(dy) < 0.5) continue;
    el.style.transform = `translateY(${dy}px)`;
  }
  // Commit the transforms before re-enabling transitions; otherwise the
  // browser will collapse the two style writes and skip the animation.
  void parent.offsetHeight;
  for (const el of siblings) {
    el.style.transition = '';
    el.style.transform = '';
  }
}

export function attachDrag(el: HTMLElement, ref: DragRef): void {
  el.addEventListener('dragstart', (e) => {
    dragging = ref;
    dragDropCommitted = false;
    dragOriginalParent = el.parentElement;
    dragOriginalOrder = dragOriginalParent
      ? (Array.from(dragOriginalParent.children) as HTMLElement[])
      : null;
    // The hover popup would be in the way of a server drag.
    closeServerPopup();
    el.classList.add('is-dragging');
    e.dataTransfer?.setData('text/plain', JSON.stringify(ref));
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  });
  el.addEventListener('dragend', () => {
    el.classList.remove('is-dragging');
    document.querySelectorAll('.is-drop-target').forEach((n) => n.classList.remove('is-drop-target'));
    // Cancelled drag (no successful drop fired — e.g. Esc, drop outside any
    // valid target): restore the original DOM order so the visual position
    // matches the unchanged state.
    if (!dragDropCommitted && dragOriginalOrder && dragOriginalParent) {
      const parent = dragOriginalParent;
      const order = dragOriginalOrder;
      flipReorder(parent, () => {
        for (const child of order) parent.appendChild(child);
      }, el);
    }
    dragging = null;
    dragOriginalOrder = null;
    dragOriginalParent = null;
    dragDropCommitted = false;
    // Catch up any polling-driven sidebar re-renders that were deferred while
    // the drag was active. The state is now in sync with the DOM so this is
    // a no-op visually, but it re-binds handlers cleanly.
    if (sidebarHasPendingRender()) {
      flushSidebarIfPending();
      scheduleRender();
    }
  });
  el.addEventListener('dragover', (e) => {
    if (!dragging || dragging.kind !== ref.kind) return;
    if (ref.kind === 'node' && dragging.kind === 'node' && dragging.serverId !== ref.serverId) return;
    // preventDefault unconditionally so the dragged element itself remains a
    // valid drop target. Otherwise, releasing the mouse over the dragged LI
    // (the most natural release point — the cursor follows the drag image)
    // fires no drop event, the dragend cancel-restore kicks in, and all the
    // user's FLIP-driven reordering snaps back to the original order.
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    // Live DOM-only reorder with a FLIP animation so siblings slide smoothly
    // instead of snapping. State is left untouched until drop; on cancel we
    // revert via the snapshot above (also FLIP-animated).
    const parent = el.parentElement;
    if (!parent) return;
    const dragged = parent.querySelector<HTMLElement>('.is-dragging');
    if (!dragged || dragged === el) return;
    const before = isAbove(e, el);
    const anchor = before ? el : el.nextElementSibling;
    if (dragged !== anchor && dragged.nextElementSibling !== anchor) {
      flipReorder(parent, () => parent.insertBefore(dragged, anchor), dragged);
    }
  });
  el.addEventListener('dragleave', () => el.classList.remove('is-drop-target'));
  el.addEventListener('drop', (e) => {
    el.classList.remove('is-drop-target');
    if (!dragging || dragging.kind !== ref.kind) return;
    e.preventDefault();
    e.stopPropagation();
    dragDropCommitted = true;
    // Commit ordering from the LIVE DOM rather than recomputing from the
    // drop target's index in state. The DOM was reordered in real time by
    // dragover-FLIP and is the source of truth for what the user saw at the
    // moment of release. Using state-relative indices here would drift
    // because: (a) the state array is still in its original order, (b)
    // `isAbove(drop target)` is measured against the post-FLIP layout, and
    // (c) the user may have released over the dragged element itself, which
    // would otherwise mean "no target found".
    commitDragOrderFromDom(ref);
  });
}

/** Reconcile state ordering with the current DOM ordering of the sidebar
 *  list that owns this drag. Persists and schedules a re-render. */
function commitDragOrderFromDom(ref: DragRef): void {
  const state = getState();
  if (ref.kind === 'server') {
    const ids = Array.from($serverList.children)
      .map((c) => (c as HTMLElement).dataset.serverId)
      .filter((x): x is string => !!x);
    const byId = new Map(state.servers.map((s) => [s.id, s]));
    const next: ServerEntry[] = [];
    for (const id of ids) {
      const s = byId.get(id);
      if (s) {
        next.push(s);
        byId.delete(id);
      }
    }
    // Append any servers the DOM didn't list (defensive — shouldn't happen
    // since renders are paused during the drag).
    for (const s of byId.values()) next.push(s);
    if (next.length !== state.servers.length) return;
    state.servers = next;
    persist();
    scheduleRender();
    return;
  }
  // node drag: find the .node-list containing the dragged LI
  const draggedLi = $serverList.querySelector<HTMLElement>(
    `.node[data-server-id="${ref.serverId}"][data-session-id="${ref.sessionId}"]`,
  );
  const list = draggedLi?.parentElement;
  if (!list) return;
  const sids = Array.from(list.children)
    .map((c) => (c as HTMLElement).dataset.sessionId)
    .filter((x): x is string => !!x);
  const known = state.knownNodes[ref.serverId] ?? [];
  const bySid = new Map(known.map((n) => [n.sessionId, n]));
  const next: NodeRef[] = [];
  for (const sid of sids) {
    const n = bySid.get(sid);
    if (n) {
      next.push(n);
      bySid.delete(sid);
    }
  }
  for (const n of bySid.values()) next.push(n);
  if (next.length !== known.length) return;
  state.knownNodes = { ...state.knownNodes, [ref.serverId]: next };
  persist();
  scheduleRender();
}

function isAbove(e: DragEvent, el: HTMLElement): boolean {
  // Use the LAYOUT midline, not the visual midline. `getBoundingClientRect`
  // reflects the FLIP slide transform during a reorder; without subtracting
  // it the threshold oscillates and the dragged element ping-pongs between
  // adjacent slots (most visibly: can't drop into slot 0).
  const r = el.getBoundingClientRect();
  let topY = r.top;
  const t = getComputedStyle(el).transform;
  if (t && t !== 'none') {
    if (t.startsWith('matrix3d(')) {
      const parts = t.slice(9, -1).split(',').map((s) => parseFloat(s));
      topY -= parts[13] ?? 0;
    } else if (t.startsWith('matrix(')) {
      const parts = t.slice(7, -1).split(',').map((s) => parseFloat(s));
      topY -= parts[5] ?? 0;
    }
  }
  return e.clientY < topY + r.height / 2;
}

