import type { MaestroApi } from './api';
import type { FsListEntry } from '../shared/protocol';

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
function escapeHtml(s: string): string {
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

export class FileExplorer {
  readonly el: HTMLDivElement;
  private currentPath = '';
  private cwdLabel = '';
  private viewerOpen = false;

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

    this.el.querySelector('[data-role="refresh"]')!.addEventListener('click', () => this.refresh());
    this.el.querySelector('[data-role="vclose"]')!.addEventListener('click', () => this.closeViewer());

    void this.navigate('');
  }

  refresh() {
    void this.navigate(this.currentPath);
  }

  private async navigate(rel: string) {
    const $list = this.el.querySelector('[data-role="list"]') as HTMLElement;
    $list.innerHTML = `<div class="fx__msg">loading…</div>`;
    let res;
    try {
      res = await this.api.fsList(this.sessionId, rel);
    } catch (err) {
      $list.innerHTML = `<div class="fx__msg fx__msg--err">${escapeHtml((err as Error).message)}</div>`;
      return;
    }
    this.currentPath = res.path;
    this.cwdLabel = res.cwd;
    this.renderCrumbs();
    this.renderList(res.entries);
  }

  private renderCrumbs() {
    const $c = this.el.querySelector('[data-role="crumbs"]') as HTMLElement;
    const parts = this.currentPath ? this.currentPath.split(/[\\/]+/).filter(Boolean) : [];
    const segs: string[] = [
      `<button class="fx__crumb" data-rel="" title="${escapeHtml(this.cwdLabel)}">root</button>`,
    ];
    let acc = '';
    for (const p of parts) {
      acc = acc ? acc + '/' + p : p;
      segs.push(`<span class="fx__crumb-sep">/</span>`);
      segs.push(`<button class="fx__crumb" data-rel="${escapeHtml(acc)}">${escapeHtml(p)}</button>`);
    }
    $c.innerHTML = segs.join('');
    for (const btn of $c.querySelectorAll<HTMLButtonElement>('button.fx__crumb')) {
      btn.addEventListener('click', () => this.navigate(btn.dataset.rel ?? ''));
    }
  }

  private renderList(entries: FsListEntry[]) {
    const $list = this.el.querySelector('[data-role="list"]') as HTMLElement;
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
        `<button class="fx__row" data-kind="${e.kind}" data-name="${escapeHtml(e.name)}">
          <span class="fx__icon">${icon}</span>
          <span class="fx__name">${escapeHtml(e.name)}</span>
          <span class="fx__meta">${escapeHtml(meta)}</span>
        </button>`,
      );
    }
    if (!entries.length && !this.currentPath) {
      rows.push(`<div class="fx__msg">empty directory</div>`);
    }
    $list.innerHTML = rows.join('');
    for (const btn of $list.querySelectorAll<HTMLButtonElement>('button.fx__row')) {
      const kind = btn.dataset.kind;
      if (kind === 'up') {
        btn.addEventListener('click', () => this.navigate(parentRel(this.currentPath)));
      } else if (kind === 'dir') {
        btn.addEventListener('click', () =>
          this.navigate(joinRel(this.currentPath, btn.dataset.name ?? '')),
        );
      } else if (kind === 'file') {
        btn.addEventListener('click', () =>
          this.openFile(joinRel(this.currentPath, btn.dataset.name ?? ''), btn.dataset.name ?? ''),
        );
      }
    }
  }

  private async openFile(rel: string, name: string) {
    const $viewer = this.el.querySelector('[data-role="viewer"]') as HTMLElement;
    const $vname = this.el.querySelector('[data-role="vname"]') as HTMLElement;
    const $vmeta = this.el.querySelector('[data-role="vmeta"]') as HTMLElement;
    const $vbody = this.el.querySelector('[data-role="vbody"]') as HTMLElement;
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
    (this.el.querySelector('[data-role="viewer"]') as HTMLElement).classList.add('is-hidden');
  }

  destroy() {
    if (this.el.parentElement) this.el.parentElement.removeChild(this.el);
  }
}
