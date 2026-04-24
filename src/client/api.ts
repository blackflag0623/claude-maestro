import type { CreateSessionBody, SessionInfo } from '../shared/protocol';

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
    if (!r.ok) throw new Error(`health ${r.status}`);
    return r.json();
  }

  async list(): Promise<SessionInfo[]> {
    const r = await fetch(this.url('/api/sessions'));
    if (!r.ok) throw new Error(`list ${r.status}`);
    return (await r.json()).sessions as SessionInfo[];
  }

  async create(body: CreateSessionBody = {}): Promise<SessionInfo> {
    const r = await fetch(this.url('/api/sessions'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`create ${r.status}`);
    return (await r.json()).session as SessionInfo;
  }

  async kill(id: string): Promise<void> {
    const r = await fetch(this.url(`/api/sessions/${encodeURIComponent(id)}`), {
      method: 'DELETE',
    });
    if (!r.ok && r.status !== 404) throw new Error(`kill ${r.status}`);
  }
}
