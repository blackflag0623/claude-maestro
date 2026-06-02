// Server hover-popup controller.
//
// A server row at rest shows only [●] NAME. On hover/focus, a fixed-position
// callout appears to the right of the row holding URL + actions. A small
// grace timer lets the cursor travel between row and popup without flicker.
// Closed automatically on scroll, resize, Escape, or pointer/focus leave.
//
// Two cross-module hooks: the sidebar is asked to flush any deferred
// re-renders (`flushSidebarIfPending`) when the popup closes, because the
// sidebar deliberately defers renders while a popup is open to avoid
// ripping the user's hover target out of the DOM.

import { $sidebarEl } from './app-context';
import { flushSidebarIfPending } from './sidebar';

let activePopupHost: HTMLElement | null = null;
let popupCloseTimer: number | null = null;

export function isPopupActive(): boolean {
  return activePopupHost !== null;
}

function cancelPopupClose(): void {
  if (popupCloseTimer !== null) {
    window.clearTimeout(popupCloseTimer);
    popupCloseTimer = null;
  }
}

export function closeServerPopup(): void {
  cancelPopupClose();
  if (!activePopupHost) return;
  const popup = activePopupHost.querySelector<HTMLElement>('.server__popup');
  if (popup) {
    popup.hidden = true;
    popup.classList.remove('is-open');
  }
  activePopupHost.classList.remove('is-popup-open');
  activePopupHost = null;
  // Flush any sidebar render that was deferred while the popup was open.
  flushSidebarIfPending();
}

function scheduleClose(delay = 180): void {
  cancelPopupClose();
  popupCloseTimer = window.setTimeout(() => {
    popupCloseTimer = null;
    closeServerPopup();
  }, delay);
}

function openServerPopup(li: HTMLElement): void {
  cancelPopupClose();
  if (activePopupHost === li) {
    positionServerPopup(li);
    return;
  }
  if (activePopupHost && activePopupHost !== li) closeServerPopup();
  const popup = li.querySelector<HTMLElement>('.server__popup');
  if (!popup) return;
  popup.hidden = false;
  popup.classList.add('is-open');
  li.classList.add('is-popup-open');
  activePopupHost = li;
  positionServerPopup(li);
}

function positionServerPopup(li: HTMLElement): void {
  const popup = li.querySelector<HTMLElement>('.server__popup');
  const row = li.querySelector<HTMLElement>('.server__row');
  if (!popup || !row) return;
  const rect = row.getBoundingClientRect();
  const popupW = popup.offsetWidth || 260;
  const popupH = popup.offsetHeight || 120;
  const gap = 8;
  // Prefer right of the row; fall back to left if it would overflow viewport.
  let left = rect.right + gap;
  if (left + popupW + 8 > window.innerWidth) left = Math.max(8, rect.left - popupW - gap);
  let top = rect.top;
  if (top + popupH + 8 > window.innerHeight) top = Math.max(8, window.innerHeight - popupH - 8);
  popup.style.left = `${Math.round(left)}px`;
  popup.style.top = `${Math.round(top)}px`;
}

export function wireServerPopup(li: HTMLElement): void {
  const row = li.querySelector<HTMLElement>('.server__row');
  const popup = li.querySelector<HTMLElement>('.server__popup');
  if (!row || !popup) return;
  // Bind to the whole .server li (row + node-list) so the popup stays open
  // while the cursor moves over any agent node beneath the row. The popup
  // is still anchored to .server__row's bounding box.
  li.addEventListener('mouseenter', () => openServerPopup(li));
  li.addEventListener('mouseleave', () => scheduleClose());
  li.addEventListener('focusin', () => openServerPopup(li));
  li.addEventListener('focusout', (e) => {
    const next = (e as FocusEvent).relatedTarget as Node | null;
    if (next && (li.contains(next) || popup.contains(next))) return;
    scheduleClose();
  });
  popup.addEventListener('mouseenter', () => cancelPopupClose());
  popup.addEventListener('mouseleave', () => scheduleClose());
  popup.addEventListener('focusout', (e) => {
    const next = (e as FocusEvent).relatedTarget as Node | null;
    if (next && (li.contains(next) || popup.contains(next))) return;
    scheduleClose();
  });
}

/** Install the once-per-app global listeners (sidebar scroll, window resize,
 *  Escape). Idempotent; main.ts calls this once at boot. */
export function installServerPopupGlobalListeners(): void {
  // We DO NOT use a capture-phase scroll listener — that would close the
  // popup whenever the xterm terminal scrolls due to PTY output. The popup
  // is anchored to a row inside the sidebar, so only sidebar scrolling
  // affects its position; on sidebar scroll we reposition rather than close.
  $sidebarEl?.addEventListener(
    'scroll',
    () => {
      if (!activePopupHost) return;
      const row = activePopupHost.querySelector<HTMLElement>('.server__row');
      if (!row) return;
      const r = row.getBoundingClientRect();
      // Close only if the anchor row has scrolled completely out of view.
      if (r.bottom < 0 || r.top > window.innerHeight) closeServerPopup();
      else positionServerPopup(activePopupHost);
    },
    { passive: true },
  );
  window.addEventListener('resize', () => {
    if (activePopupHost) positionServerPopup(activePopupHost);
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeServerPopup();
  });
}
