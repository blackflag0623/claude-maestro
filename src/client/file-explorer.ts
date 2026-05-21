import type { MaestroApi } from './api';
import type { FsListEntry } from '../shared/protocol';

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]!);
}

function joinRel(base: string, name: string): string {
  if (!base) return name;
  return base.replace(/[\\/]+$/, '') + '/' + name;
}

function parentRel(rel: string): string {
  if (!rel) return '';
  const idx = Math.max(rel.lastIndexOf('/'), rel.lastIndexOf('\\'));
  return idx < 0 ? '' : rel.slice(0, idx);
}

function fmtSize(n?: number): string {
  if (n === undefined) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function $(el: HTMLElement, sel: string): HTMLElement {
  return el.querySelector(sel) as HTMLElement;
}

export class FileExplorer {
  readonly el: HTMLDivElement;
  private currentPath = '';
  private cwdLabel = '';
  private viewerOpen = false;
  private destroyed = false;
  private pending: AbortController | null = null;

  constructor(
    private readonly api: MaestroApi,
    private readonly sessionId: string,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'fx';
    this.el.innerHTML = `
      <div class="fx__head">
        <div class="fx__crumbs" data-role="crumbs"></div>
        <button class="fx__btn" data-role="refresh" title="refresh" aria-label="refresh">↻</button>
      </div>
      <div class="fx__list" data-role="list"></div>
      <div class="fx__viewer is-hidden" data-role="viewer">
        <div class="fx__viewer-head">
          <span class="fx__viewer-name" data-role="vname"></span>
          <span class="fx__viewer-meta" data-role="vmeta"></span>
          <button class="fx__btn" data-role="vclose" title="close" aria-label="close">×</button>
        </div>
        <pre class="fx__viewer-body" data-role="vbody"></pre>
      </div>
    `;

    $(this.el, '[data-role="refresh"]').addEventListener('click', () => this.refresh());
    $(this.el, '[data-role="vclose"]').addEventListener('click', () => this.closeViewer());

    void this.navigate('');
  }

  refresh() {
    void this.navigate(this.currentPath);
  }

  private async navigate(rel: string) {
    if (this.destroyed) return;
    this.pending?.abort();
    const ac = (this.pending = new AbortController());

    const $list = $(this.el, '[data-role="list"]');
    $list.innerHTML = `<div class="fx__msg">loading…</div>`;
    let res;
    try {
      res = await this.api.fsList(this.sessionId, rel);
    } catch (err) {
      if (ac.signal.aborted) return;
      $list.innerHTML = `<div class="fx__msg fx__msg--err">${esc((err as Error).message)}</div>`;
      return;
    }
    if (ac.signal.aborted) return;
    this.currentPath = res.path;
    this.cwdLabel = res.cwd;
    this.renderCrumbs();
    this.renderList(res.entries);
  }

  private renderCrumbs() {
    const $c = $(this.el, '[data-role="crumbs"]');
    const parts = this.currentPath ? this.currentPath.split(/[\\/]+/).filter(Boolean) : [];
    const segs: string[] = [
      `<button class="fx__crumb" data-rel="" title="${esc(this.cwdLabel)}">root</button>`,
    ];
    let acc = '';
    for (const p of parts) {
      acc = acc ? acc + '/' + p : p;
      segs.push(`<span class="fx__crumb-sep">/</span>`);
      segs.push(`<button class="fx__crumb" data-rel="${esc(acc)}">${esc(p)}</button>`);
    }
    $c.innerHTML = segs.join('');
    for (const btn of $c.querySelectorAll<HTMLButtonElement>('button.fx__crumb')) {
      btn.addEventListener('click', () => this.navigate(btn.dataset.rel ?? ''));
    }
  }

  private renderList(entries: FsListEntry[]) {
    const $list = $(this.el, '[data-role="list"]');
    const rows: string[] = [];
    if (this.currentPath) {
      rows.push(
        `<button class="fx__row fx__row--up" data-kind="up">
          <span class="fx__icon">↑</span>
          <span class="fx__name">..</span>
        </button>`,
      );
    }
    for (const e of entries) {
      const icon = e.kind === 'dir' ? '▸' : e.kind === 'file' ? '·' : '?';
      const meta = e.kind === 'file' ? fmtSize(e.size) : '';
      rows.push(
        `<button class="fx__row" data-kind="${e.kind}" data-name="${esc(e.name)}">
          <span class="fx__icon">${icon}</span>
          <span class="fx__name">${esc(e.name)}</span>
          <span class="fx__meta">${esc(meta)}</span>
        </button>`,
      );
    }
    if (!entries.length && !this.currentPath) {
      rows.push(`<div class="fx__msg">empty directory</div>`);
    }
    $list.innerHTML = rows.join('');

    // Single delegated listener instead of per-row listeners
    $list.addEventListener('click', (ev) => {
      const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('button.fx__row');
      if (!btn) return;
      const kind = btn.dataset.kind;
      const name = btn.dataset.name ?? '';
      if (kind === 'up') this.navigate(parentRel(this.currentPath));
      else if (kind === 'dir') this.navigate(joinRel(this.currentPath, name));
      else if (kind === 'file') this.openFile(joinRel(this.currentPath, name), name);
    });
  }

  private async openFile(rel: string, name: string) {
    if (this.destroyed) return;
    const $viewer = $(this.el, '[data-role="viewer"]');
    const $vname = $(this.el, '[data-role="vname"]');
    const $vmeta = $(this.el, '[data-role="vmeta"]');
    const $vbody = $(this.el, '[data-role="vbody"]');
    $viewer.classList.remove('is-hidden');
    this.viewerOpen = true;
    $vname.textContent = name;
    $vmeta.textContent = 'loading…';
    $vbody.textContent = '';
    let res;
    try {
      res = await this.api.fsRead(this.sessionId, rel);
    } catch (err) {
      $vmeta.textContent = 'error';
      $vbody.textContent = (err as Error).message;
      return;
    }
    if (res.binary) {
      $vmeta.textContent = `binary · ${fmtSize(res.size)}`;
      $vbody.textContent = '[binary file — preview not shown]';
      return;
    }
    $vmeta.textContent = fmtSize(res.size);
    $vbody.textContent = res.content;
  }

  private closeViewer() {
    if (!this.viewerOpen) return;
    this.viewerOpen = false;
    $(this.el, '[data-role="viewer"]').classList.add('is-hidden');
  }

  destroy() {
    this.destroyed = true;
    this.pending?.abort();
    this.el.remove();
  }
}
