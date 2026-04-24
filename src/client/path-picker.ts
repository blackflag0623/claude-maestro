import type { MaestroApi } from './api';

/**
 * Attaches an autocomplete dropdown to a text input. Each keystroke debounces
 * a call to `api.completePath(input.value)` and renders the directory entries
 * directly under the field. Arrow keys navigate, Enter / Tab accept, Esc
 * dismisses. Tab on a directory ending in `/` lets the user keep drilling.
 */
export interface PathPicker {
  setApi(api: MaestroApi | null): void;
  destroy(): void;
}

export function attachPathPicker(input: HTMLInputElement): PathPicker {
  let api: MaestroApi | null = null;
  let entries: string[] = [];
  let cursor = -1;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let lastQuery = '\0'; // sentinel — never matches a real value
  let suppressUntilTyping = false;

  const list = document.createElement('ul');
  list.className = 'path-picker';
  list.setAttribute('role', 'listbox');
  list.hidden = true;

  // Position relative to the input's parent (which is .field — already
  // position: relative-friendly via flex-column).
  const wrap = input.parentElement;
  if (wrap) {
    if (getComputedStyle(wrap).position === 'static') wrap.style.position = 'relative';
    wrap.appendChild(list);
  }

  function hide() {
    list.hidden = true;
    cursor = -1;
  }

  function render() {
    if (entries.length === 0) {
      hide();
      return;
    }
    list.innerHTML = '';
    entries.forEach((entry, i) => {
      const li = document.createElement('li');
      li.className = 'path-picker__item';
      if (i === cursor) li.setAttribute('aria-selected', 'true');
      li.textContent = entry;
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        accept(i);
      });
      list.appendChild(li);
    });
    list.hidden = false;
  }

  function accept(index: number) {
    const value = entries[index];
    if (!value) return;
    input.value = value;
    suppressUntilTyping = true;
    hide();
    // Move caret to end so the next keystroke continues drilling.
    input.setSelectionRange(value.length, value.length);
    input.focus();
  }

  async function fetchEntries() {
    if (!api) return;
    const value = input.value;
    if (value === lastQuery) return;
    lastQuery = value;
    try {
      const { entries: results } = await api.completePath(value);
      // Drop responses whose value no longer matches what's in the box.
      if (input.value !== value) return;
      entries = results;
      cursor = entries.length > 0 ? 0 : -1;
      render();
    } catch {
      hide();
    }
  }

  function onInput() {
    suppressUntilTyping = false;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(fetchEntries, 120);
  }

  function onKeydown(e: KeyboardEvent) {
    if (list.hidden || entries.length === 0) {
      if (e.key === 'Tab' && !suppressUntilTyping) {
        // Trigger an immediate completion fetch so Tab feels instant.
        fetchEntries();
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      cursor = (cursor + 1) % entries.length;
      render();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      cursor = (cursor - 1 + entries.length) % entries.length;
      render();
    } else if (e.key === 'Enter') {
      if (cursor >= 0) {
        e.preventDefault();
        accept(cursor);
      }
    } else if (e.key === 'Tab') {
      if (cursor >= 0) {
        e.preventDefault();
        accept(cursor);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      hide();
    }
  }

  function onBlur() {
    setTimeout(hide, 120); // allow mousedown on item to fire
  }

  function onFocus() {
    if (!suppressUntilTyping) fetchEntries();
  }

  input.addEventListener('input', onInput);
  input.addEventListener('keydown', onKeydown);
  input.addEventListener('blur', onBlur);
  input.addEventListener('focus', onFocus);

  return {
    setApi(next) {
      api = next;
      lastQuery = '\0';
      hide();
    },
    destroy() {
      input.removeEventListener('input', onInput);
      input.removeEventListener('keydown', onKeydown);
      input.removeEventListener('blur', onBlur);
      input.removeEventListener('focus', onFocus);
      list.remove();
    },
  };
}
