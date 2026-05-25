import type {
  CreateSessionBody,
  FsListResponse,
  FsReadResponse,
  SessionInfo,
} from '../shared/protocol';

/**
 * REST + WebSocket client for a single maestro backend.
 *
 * One `MaestroApi` instance is bound to one `baseUrl` (a maestro server's
 * origin, or '' / '/' for same-origin). Shared between the desktop and
 * mobile clients — keep this module dependency-free of any UI concerns.
 */

async function failure(r: Response, fallback: string): Promise<never> {
  let detail = `${fallback} ${r.status}`;
  try {
    const j = await r.json();
    if (j?.error) detail = j.error;
  } catch {}
  throw new Error(detail);
}

export interface RequestOpts {
  signal?: AbortSignal;
}

export class MaestroApi {
  readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  private url(path: string) {
    return this.baseUrl + path;
  }

  wsUrl(sessionId: string): string {
    // Anchor against the page origin, not its pathname. The mobile client is
    // served under /m/ — `new URL('', location.href)` would keep that prefix
    // and produce /m/maestro-ws, which neither the Vite proxy nor the server
    // upgrade gate accept. Absolute baseUrls (remote servers) still resolve
    // correctly because they include their own scheme+host.
    const u = new URL(this.baseUrl || '/', location.href);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.pathname = u.pathname.replace(/\/$/, '') + '/maestro-ws';
    u.search = `?sessionId=${encodeURIComponent(sessionId)}`;
    return u.toString();
  }

  async health(opts: RequestOpts = {}): Promise<{ ok: boolean; sessions: number }> {
    const r = await fetch(this.url('/api/health'), { signal: opts.signal });
    if (!r.ok) await failure(r, 'health');
    return r.json();
  }

  async list(opts: RequestOpts = {}): Promise<SessionInfo[]> {
    const r = await fetch(this.url('/api/sessions'), { signal: opts.signal });
    if (!r.ok) await failure(r, 'list');
    return (await r.json()).sessions as SessionInfo[];
  }

  async create(body: CreateSessionBody = {}, opts: RequestOpts = {}): Promise<SessionInfo> {
    const r = await fetch(this.url('/api/sessions'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (!r.ok) await failure(r, 'create');
    return (await r.json()).session as SessionInfo;
  }

  async kill(id: string, opts: RequestOpts = {}): Promise<void> {
    const r = await fetch(this.url(`/api/sessions/${encodeURIComponent(id)}`), {
      method: 'DELETE',
      signal: opts.signal,
    });
    if (!r.ok && r.status !== 404) await failure(r, 'kill');
  }

  async completePath(
    prefix: string,
    opts: RequestOpts = {},
  ): Promise<{ base: string; entries: string[] }> {
    const r = await fetch(
      this.url(`/api/fs/complete?prefix=${encodeURIComponent(prefix)}`),
      { signal: opts.signal },
    );
    if (!r.ok) await failure(r, 'complete');
    return r.json();
  }

  async fsList(sessionId: string, path = '', opts: RequestOpts = {}): Promise<FsListResponse> {
    const r = await fetch(
      this.url(
        `/api/fs/list?sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(path)}`,
      ),
      { signal: opts.signal },
    );
    if (!r.ok) await failure(r, 'fs list');
    return r.json();
  }

  async fsRead(sessionId: string, path: string, opts: RequestOpts = {}): Promise<FsReadResponse> {
    const r = await fetch(
      this.url(
        `/api/fs/read?sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(path)}`,
      ),
      { signal: opts.signal },
    );
    if (!r.ok) await failure(r, 'fs read');
    return r.json();
  }
}
