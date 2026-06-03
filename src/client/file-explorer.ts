import type { MaestroApi } from '../client-shared/api';
import type { FsListEntry } from '../shared/protocol';
import { escapeHtml as esc } from '../client-shared/html';

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

declare const hljs: {
  highlightElement: (el: HTMLElement) => void;
  getLanguage: (name: string) => unknown;
} | undefined;

const HIGHLIGHT_MAX_BYTES = 200 * 1024;

const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', json5: 'json',
  css: 'css', scss: 'scss', less: 'less',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml',
  md: 'markdown', markdown: 'markdown',
  py: 'python', pyw: 'python',
  go: 'go', rs: 'rust',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  ps1: 'powershell', psm1: 'powershell',
  yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini',
  sql: 'sql',
  java: 'java', kt: 'kotlin', kts: 'kotlin',
  c: 'c', h: 'c', cpp: 'cpp', cxx: 'cpp', cc: 'cpp', hpp: 'cpp', hxx: 'cpp',
  rb: 'ruby', php: 'php', swift: 'swift',
  cs: 'csharp', fs: 'fsharp',
  lua: 'lua', dart: 'dart', scala: 'scala', r: 'r',
  diff: 'diff', patch: 'diff',
  dockerfile: 'dockerfile', makefile: 'makefile',
};

function detectLanguage(name: string): string | null {
  const base = name.toLowerCase();
  if (base === 'dockerfile' || base.endsWith('.dockerfile')) return 'dockerfile';
  if (base === 'makefile' || base === 'gnumakefile') return 'makefile';
  if (base === '.gitignore' || base === '.dockerignore' || base === '.npmignore') return 'bash';
  const dot = base.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = base.slice(dot + 1);
  return EXT_LANG[ext] ?? null;
}

export class FileExplorer {
  readonly el: HTMLDivElement;
  private currentPath = '';
  private cwdLabel = '';
  private viewerOpen = false;
  private destroyed = false;
  private pending: AbortController | null = null;
  private viewerPending: AbortController | null = null;

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
      <div class="fx__vsplit is-hidden" data-role="vsplit" title="drag to resize"></div>
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
    this.attachVerticalResize();

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
    this.viewerPending?.abort();
    const ac = (this.viewerPending = new AbortController());
    const $viewer = $(this.el, '[data-role="viewer"]');
    const $vsplit = $(this.el, '[data-role="vsplit"]');
    const $vname = $(this.el, '[data-role="vname"]');
    const $vmeta = $(this.el, '[data-role="vmeta"]');
    const $vbody = $(this.el, '[data-role="vbody"]');
    $viewer.classList.remove('is-hidden');
    $vsplit.classList.remove('is-hidden');
    this.viewerOpen = true;
    $vname.textContent = name;
    $vmeta.textContent = 'loading…';
    $vbody.textContent = '';
    let res;
    try {
      res = await this.api.fsRead(this.sessionId, rel, { signal: ac.signal });
    } catch (err) {
      if (ac.signal.aborted) return;
      $vmeta.textContent = 'error';
      $vbody.textContent = (err as Error).message;
      return;
    }
    if (ac.signal.aborted) return;
    if (res.binary) {
      $vmeta.textContent = `binary · ${fmtSize(res.size)}`;
      $vbody.textContent = '[binary file — preview not shown]';
      return;
    }
    $vmeta.textContent = fmtSize(res.size);
    this.renderHighlighted($vbody, res.content, name);
  }

  private renderHighlighted(host: HTMLElement, content: string, name: string) {
    host.textContent = '';
    const code = document.createElement('code');
    code.textContent = content;

    const tooLarge = content.length > HIGHLIGHT_MAX_BYTES;
    const lang = detectLanguage(name);

    if (!tooLarge && typeof hljs !== 'undefined' && lang && hljs.getLanguage(lang)) {
      code.className = `hljs language-${lang}`;
      try {
        hljs.highlightElement(code);
      } catch {
        // fall through to plain text — textContent already set
      }
    } else {
      code.className = 'hljs';
    }
    host.appendChild(code);
  }

  private closeViewer() {
    if (!this.viewerOpen) return;
    this.viewerOpen = false;
    $(this.el, '[data-role="viewer"]').classList.add('is-hidden');
    $(this.el, '[data-role="vsplit"]').classList.add('is-hidden');
  }

  private attachVerticalResize() {
    const $vsplit = $(this.el, '[data-role="vsplit"]');
    const KEY = 'maestro:fxViewerHeight';
    const MIN = 80;
    const apply = (px: number) => this.el.style.setProperty('--fx-viewer-h', `${px}px`);
    const saved = Number(localStorage.getItem(KEY));
    if (Number.isFinite(saved) && saved >= MIN) apply(saved);

    $vsplit.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const rect = this.el.getBoundingClientRect();
      const max = Math.floor(rect.height * 0.9);
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
      const move = (ev: MouseEvent) => {
        const next = Math.max(MIN, Math.min(max, rect.bottom - ev.clientY));
        apply(next);
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        const cur = this.el.style.getPropertyValue('--fx-viewer-h');
        const n = parseInt(cur, 10);
        if (Number.isFinite(n)) localStorage.setItem(KEY, String(n));
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  }

  destroy() {
    this.destroyed = true;
    this.pending?.abort();
    this.viewerPending?.abort();
    this.el.remove();
  }
}
