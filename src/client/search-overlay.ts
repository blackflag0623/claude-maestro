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
 *  counter, close. Enter = next, Shift+Enter = prev, Esc = close.
 *
 *  Three modifier toggles let the user narrow matches:
 *    Aa  — case sensitive
 *    \W  — whole-word boundary
 *    .*  — interpret the query as a JS regex (whole-word becomes mutually
 *          exclusive — it would change the meaning of the regex)
 *
 *  Invalid regex (e.g. an unterminated group while typing) is reported in
 *  the counter slot as `err` and decorations are cleared; the overlay never
 *  throws or leaves the underlying SearchAddon in a stuck state. */
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
    <button type="button" class="search-overlay__toggle" data-toggle="case" title="case sensitive" aria-label="case sensitive" aria-pressed="false">Aa</button>
    <button type="button" class="search-overlay__toggle" data-toggle="word" title="whole word" aria-label="whole word" aria-pressed="false">\\W</button>
    <button type="button" class="search-overlay__toggle" data-toggle="regex" title="regular expression" aria-label="regular expression" aria-pressed="false">.*</button>
    <button type="button" class="search-overlay__btn" data-act="prev" title="previous (⇧⏎)" aria-label="previous match">↑</button>
    <button type="button" class="search-overlay__btn" data-act="next" title="next (⏎)" aria-label="next match">↓</button>
    <button type="button" class="search-overlay__btn" data-act="close" title="close (esc)" aria-label="close">×</button>
  `;

  const input = el.querySelector<HTMLInputElement>('.search-overlay__input')!;
  const count = el.querySelector<HTMLSpanElement>('.search-overlay__count')!;
  const toggles = {
    case: el.querySelector<HTMLButtonElement>('button[data-toggle="case"]')!,
    word: el.querySelector<HTMLButtonElement>('button[data-toggle="word"]')!,
    regex: el.querySelector<HTMLButtonElement>('button[data-toggle="regex"]')!,
  };

  let open = false;
  const state = {
    caseSensitive: false,
    wholeWord: false,
    regex: false,
  };

  function applyToggles() {
    toggles.case.setAttribute('aria-pressed', state.caseSensitive ? 'true' : 'false');
    toggles.word.setAttribute('aria-pressed', state.wholeWord ? 'true' : 'false');
    toggles.regex.setAttribute('aria-pressed', state.regex ? 'true' : 'false');
    // whole-word doesn't compose meaningfully with a user-authored regex —
    // it would silently wrap the pattern in \b…\b, surprising the user. Make
    // it visibly inert while regex mode is on.
    toggles.word.disabled = state.regex;
  }
  applyToggles();

  function currentOpts(): ISearchOptions {
    return {
      decorations: DECORATIONS,
      incremental: false,
      caseSensitive: state.caseSensitive,
      wholeWord: !state.regex && state.wholeWord,
      regex: state.regex,
    };
  }

  function setCountErr() {
    count.textContent = 'err';
    count.dataset.state = 'err';
  }
  function setCountText(text: string) {
    count.textContent = text;
    delete count.dataset.state;
  }

  search.onDidChangeResultsCount?.((e) => {
    if (!open) return;
    if (e.resultCount === 0) {
      setCountText(input.value ? '0' : '—');
      return;
    }
    setCountText(`${e.resultIndex + 1}/${e.resultCount}`);
  });

  function safeFind(kind: 'next' | 'prev'): void {
    const q = input.value;
    if (!q) {
      try { search.clearDecorations(); } catch {}
      setCountText('—');
      return;
    }
    // Validate regex BEFORE handing to xterm's SearchAddon — addon-search
    // accepts the option, but its internal behavior on a malformed pattern
    // varies by version and can leave decorations in a stuck state.
    if (state.regex) {
      try {
        new RegExp(q);
      } catch {
        try { search.clearDecorations(); } catch {}
        setCountErr();
        return;
      }
    }
    try {
      const opts = currentOpts();
      if (kind === 'next') search.findNext(q, opts);
      else search.findPrevious(q, opts);
    } catch {
      try { search.clearDecorations(); } catch {}
      setCountErr();
    }
  }

  input.addEventListener('input', () => {
    // Incremental find on type. We restart from the current position rather
    // than from the top to keep the user oriented as they refine the query.
    safeFind('next');
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      safeFind(e.shiftKey ? 'prev' : 'next');
    } else if (e.key === 'Escape') {
      e.preventDefault();
      api.close();
    }
  });

  // Toggles: flip state, re-apply, re-run query. Clicking a toggle does not
  // steal focus from the input so the user can keep typing.
  for (const [key, btn] of Object.entries(toggles)) {
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      const k = key as keyof typeof state;
      state[k] = !state[k];
      applyToggles();
      safeFind('next');
      input.focus();
    });
  }

  el.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-act]');
    if (!btn) return;
    if (btn.dataset.act === 'next') safeFind('next');
    else if (btn.dataset.act === 'prev') safeFind('prev');
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
      setCountText('—');
    },
    isOpen() {
      return open;
    },
    refresh() {
      if (!open) return;
      safeFind('next');
    },
  };

  return api;
}
