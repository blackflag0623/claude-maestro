import type { SearchAddon, ISearchOptions, ISearchDecorationOptions } from '@xterm/addon-search';

/** Brand colors used to highlight matches in the terminal buffer. The
 *  active match gets the lime accent (matches the rest of our "live state"
 *  vocabulary); other matches get a translucent yellow. */
const DECORATIONS: ISearchDecorationOptions = {
  matchBackground: '#f3f99d44',
  matchBorder: '#f3f99d99',
  matchOverviewRuler: '#f3f99d',
  activeMatchBackground: '#c6ff3d66',
  activeMatchBorder: '#c6ff3d',
  activeMatchColorOverviewRuler: '#c6ff3d',
};

export interface SearchOverlay {
  /** Root element to mount inside `node-host`. Already positioned. */
  el: HTMLDivElement;
  open(): void;
  close(): void;
  isOpen(): boolean;
  /** Re-run the current query (e.g. after the buffer grew). No-op if closed. */
  refresh(): void;
}

/** Floating search panel pinned to the top-right of a terminal pane.
 *  Wraps `@xterm/addon-search` with a tiny brutalist UI: input, prev/next,
 *  counter, close. Enter = next, Shift+Enter = prev, Esc = close. */
export function buildSearchOverlay(search: SearchAddon): SearchOverlay {
  const el = document.createElement('div');
  el.className = 'search-overlay';
  el.hidden = true;
  el.innerHTML = `
    <input
      type="text"
      class="search-overlay__input"
      placeholder="find in node"
      spellcheck="false"
      autocomplete="off"
      aria-label="search terminal"
    />
    <span class="search-overlay__count" aria-live="polite">—</span>
    <button type="button" class="search-overlay__btn" data-act="prev" title="previous (⇧⏎)" aria-label="previous match">↑</button>
    <button type="button" class="search-overlay__btn" data-act="next" title="next (⏎)" aria-label="next match">↓</button>
    <button type="button" class="search-overlay__btn" data-act="close" title="close (esc)" aria-label="close">×</button>
  `;

  const input = el.querySelector<HTMLInputElement>('.search-overlay__input')!;
  const count = el.querySelector<HTMLSpanElement>('.search-overlay__count')!;

  let open = false;

  const opts: ISearchOptions = {
    decorations: DECORATIONS,
    incremental: false,
  };

  search.onDidChangeResultsCount?.((e) => {
    if (!open) return;
    if (e.resultCount === 0) {
      count.textContent = input.value ? '0' : '—';
      return;
    }
    count.textContent = `${e.resultIndex + 1}/${e.resultCount}`;
  });

  function runNext() {
    const q = input.value;
    if (!q) {
      search.clearDecorations();
      count.textContent = '—';
      return;
    }
    search.findNext(q, opts);
  }

  function runPrev() {
    const q = input.value;
    if (!q) return;
    search.findPrevious(q, opts);
  }

  input.addEventListener('input', () => {
    // Incremental find on type. We restart from the current position rather
    // than from the top to keep the user oriented as they refine the query.
    runNext();
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) runPrev();
      else runNext();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      api.close();
    }
  });

  el.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-act]');
    if (!btn) return;
    if (btn.dataset.act === 'next') runNext();
    else if (btn.dataset.act === 'prev') runPrev();
    else if (btn.dataset.act === 'close') api.close();
  });

  const api: SearchOverlay = {
    el,
    open() {
      if (open) {
        input.focus();
        input.select();
        return;
      }
      open = true;
      el.hidden = false;
      // Defer focus to after the show transition.
      requestAnimationFrame(() => {
        input.focus();
        input.select();
      });
    },
    close() {
      if (!open) return;
      open = false;
      el.hidden = true;
      try {
        search.clearDecorations();
      } catch {}
      count.textContent = '—';
    },
    isOpen() {
      return open;
    },
    refresh() {
      if (!open) return;
      runNext();
    },
  };

  return api;
}
