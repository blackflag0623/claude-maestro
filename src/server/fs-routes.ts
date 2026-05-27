import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Express } from 'express';

const FS_LIMIT = 50;
const FS_EXCLUDE = new Set(['node_modules']);
const FS_READ_MAX_BYTES = 2 * 1024 * 1024;

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function resolveInsideCwd(cwd: string, rel: string): { abs: string; rel: string } {
  const abs = path.resolve(cwd, rel || '.');
  const r = path.relative(cwd, abs);
  const outside = r.startsWith('..') || path.isAbsolute(r);
  if (outside) {
    const e = new Error('path is outside session cwd') as Error & { code?: string };
    e.code = 'OUTSIDE_CWD';
    throw e;
  }
  return { abs, rel: r };
}

/** Mount `/api/fs/complete`, `/api/fs/list`, `/api/fs/read`.
 *
 *  `lookupCwd(sessionId) → string | null` lets the routes hop from a session
 *  id to a clamping cwd without depending on the full Session struct. */
export function mountFsRoutes(
  app: Express,
  lookupCwd: (sessionId: string) => string | null,
): void {
  app.get('/api/fs/complete', (req, res) => {
    const raw = String(req.query.prefix ?? '').trim();
    const showHidden = raw.includes('/.') || raw.includes('\\.') || /(?:^|[\\/])\.[^\\/]*$/.test(raw);

    const expanded = expandHome(raw || '~');
    const sep = expanded.includes('\\') ? '\\' : '/';
    const endsWithSep = /[\\/]$/.test(expanded);

    let dir: string;
    let needle: string;
    if (!raw) {
      dir = os.homedir();
      needle = '';
    } else if (endsWithSep) {
      dir = expanded;
      needle = '';
    } else {
      dir = path.dirname(expanded);
      needle = path.basename(expanded);
    }

    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      res.json({ base: dir, entries: [] });
      return;
    }

    const needleLower = needle.toLowerCase();
    const out: string[] = [];
    for (const d of dirents) {
      if (!d.isDirectory()) continue;
      if (FS_EXCLUDE.has(d.name)) continue;
      if (!showHidden && d.name.startsWith('.')) continue;
      if (needleLower && !d.name.toLowerCase().startsWith(needleLower)) continue;
      out.push(path.join(dir, d.name) + sep);
      if (out.length >= FS_LIMIT) break;
    }
    out.sort((a, b) => a.localeCompare(b));
    res.json({ base: dir, entries: out });
  });

  app.get('/api/fs/list', (req, res) => {
    const sid = String(req.query.sessionId ?? '');
    const cwd = lookupCwd(sid);
    if (!cwd) {
      res.status(404).json({ error: 'session not found' });
      return;
    }
    const rel = String(req.query.path ?? '');
    let resolved;
    try {
      resolved = resolveInsideCwd(cwd, rel);
    } catch (err) {
      const e = err as Error & { code?: string };
      res.status(e.code === 'OUTSIDE_CWD' ? 403 : 400).json({ error: e.message });
      return;
    }
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(resolved.abs, { withFileTypes: true });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    const entries = dirents.map((d) => {
      const kind: 'dir' | 'file' | 'other' = d.isDirectory() ? 'dir' : d.isFile() ? 'file' : 'other';
      const entry: { name: string; kind: typeof kind; size?: number; mtime?: number } = {
        name: d.name,
        kind,
      };
      if (kind === 'file') {
        try {
          const st = fs.statSync(path.join(resolved.abs, d.name));
          entry.size = st.size;
          entry.mtime = st.mtimeMs;
        } catch {}
      }
      return entry;
    });
    entries.sort((a, b) => {
      if (a.kind !== b.kind) {
        if (a.kind === 'dir') return -1;
        if (b.kind === 'dir') return 1;
      }
      return a.name.localeCompare(b.name);
    });
    res.json({ cwd, path: resolved.rel, abs: resolved.abs, entries });
  });

  app.get('/api/fs/read', (req, res) => {
    const sid = String(req.query.sessionId ?? '');
    const cwd = lookupCwd(sid);
    if (!cwd) {
      res.status(404).json({ error: 'session not found' });
      return;
    }
    const rel = String(req.query.path ?? '');
    let resolved;
    try {
      resolved = resolveInsideCwd(cwd, rel);
    } catch (err) {
      const e = err as Error & { code?: string };
      res.status(e.code === 'OUTSIDE_CWD' ? 403 : 400).json({ error: e.message });
      return;
    }
    let st: fs.Stats;
    try {
      st = fs.statSync(resolved.abs);
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
      return;
    }
    if (st.isDirectory()) {
      res.status(400).json({ error: 'path is a directory' });
      return;
    }
    if (st.size > FS_READ_MAX_BYTES) {
      res.status(413).json({ error: `file too large (${st.size} bytes, max ${FS_READ_MAX_BYTES})` });
      return;
    }
    let buf: Buffer;
    try {
      buf = fs.readFileSync(resolved.abs);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    const sniff = buf.subarray(0, Math.min(buf.length, 8192));
    const binary = sniff.includes(0);
    if (binary) {
      res.json({ binary: true, size: st.size, abs: resolved.abs });
      return;
    }
    res.json({
      binary: false,
      size: st.size,
      mtime: st.mtimeMs,
      content: buf.toString('utf8'),
      abs: resolved.abs,
    });
  });
}

export { expandHome };
