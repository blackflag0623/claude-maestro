import type { CreateSessionBody, SessionInfo } from '../shared/protocol';

async function failure(r: Response, fallback: string): Promise<never> {
  let detail = `${fallback} ${r.status}`;
  try {
    const j = await r.json();
    if (j?.error) detail = j.error;
  } catch {}
  throw new Error(detail);
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
    const u = new URL(this.baseUrl, location.href);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.pathname = u.pathname.replace(/\/$/, '') + '/maestro-ws';
    u.search = `?sessionId=${encodeURIComponent(sessionId)}`;
    return u.toString();
  }

  async health(): Promise<{ ok: boolean; sessions: number }> {
    const r = await fetch(this.url('/api/health'));
    if (!r.ok) await failure(r, 'health');
    return r.json();
  }

  async list(): Promise<SessionInfo[]> {
    const r = await fetch(this.url('/api/sessions'));
    if (!r.ok) await failure(r, 'list');
    return (await r.json()).sessions as SessionInfo[];
  }

  async create(body: CreateSessionBody = {}): Promise<SessionInfo> {
    const r = await fetch(this.url('/api/sessions'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) await failure(r, 'create');
    return (await r.json()).session as SessionInfo;
  }

  async kill(id: string): Promise<void> {
    const r = await fetch(this.url(`/api/sessions/${encodeURIComponent(id)}`), {
      method: 'DELETE',
    });
    if (!r.ok && r.status !== 404) await failure(r, 'kill');
  }

  async completePath(
    prefix: string,
    init?: RequestInit,
  ): Promise<{ base: string; entries: string[] }> {
    const r = await fetch(this.url(`/api/fs/complete?prefix=${encodeURIComponent(prefix)}`), init);
    if (!r.ok) await failure(r, 'complete');
    return r.json();
  }
}
