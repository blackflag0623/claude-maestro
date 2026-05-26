import fs from 'node:fs';
import path from 'node:path';

export interface ResolvedBin {
  /** Best path we have for the binary. When `found` is false, this is the
   *  unresolved name; spawn will likely fail, but we keep it for diagnostics. */
  path: string;
  /** True if the path resolved against PATH or the caller supplied an
   *  explicit path that exists. */
  found: boolean;
  /** Directories we searched on PATH (empty for explicit paths). Use this to
   *  build a helpful "binary not found" diagnostic. */
  searched: string[];
}

/** Look up `name` against PATH the same way an interactive shell would.
 *  Honors `PATHEXT` on Windows. Returns metadata so callers can either spawn
 *  through it transparently (`{path}`) or render a precise "not found"
 *  diagnostic listing the dirs that were checked. */
export function resolveBin(name: string): ResolvedBin {
  if (name.includes(path.sep) || name.includes('/')) {
    return { path: name, found: fs.existsSync(name), searched: [] };
  }
  const exts =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
          .split(';')
          .map((e) => e.toLowerCase())
      : [''];
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    for (const ext of exts) {
      const candidate = path.join(d, name + ext);
      try {
        if (fs.statSync(candidate).isFile()) {
          return { path: candidate, found: true, searched: dirs };
        }
      } catch {}
    }
  }
  return { path: name, found: false, searched: dirs };
}
