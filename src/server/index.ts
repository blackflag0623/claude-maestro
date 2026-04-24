import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import * as pty from '@lydell/node-pty';
import type {
  ClientMessage,
  ServerMessage,
  SessionInfo,
  CreateSessionBody,
} from '../shared/protocol.js';

const PORT = Number(process.env.PORT ?? 4050);
const SCROLLBACK_BYTES = 256 * 1024;
const STORE_DIR =
  process.env.MAESTRO_STORE_DIR ??
  path.join(os.homedir(), '.claude-maestro');
const STORE_FILE = path.join(STORE_DIR, 'sessions.json');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface PersistedSession {
  id: string;
  title: string;
  cwd: string;
  createdAt: number;
  hasResumeData: boolean; // false until first run actually persists conversation
}

interface Session extends PersistedSession {
  term: pty.IPty | null; // null = dormant (not yet revived this maestro process)
  cols: number;
  rows: number;
  alive: boolean;
  exitCode: number | null;
  scrollback: string;
  subscribers: Set<WebSocket>;
}

const sessions = new Map<string, Session>();

// ───────── persistence ─────────

function persist() {
  const payload: PersistedSession[] = [...sessions.values()].map((s) => ({
    id: s.id,
    title: s.title,
    cwd: s.cwd,
    createdAt: s.createdAt,
    hasResumeData: s.hasResumeData,
  }));
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify(payload, null, 2));
  } catch (err) {
    console.error('[maestro] persist failed:', (err as Error).message);
  }
}

function loadPersisted() {
  if (!fs.existsSync(STORE_FILE)) return;
  let raw: PersistedSession[];
  try {
    raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
  } catch (err) {
    console.error('[maestro] could not parse store, ignoring:', (err as Error).message);
    return;
  }
  for (const p of raw) {
    if (!p?.id || !p?.cwd) continue;
    sessions.set(p.id, {
      id: p.id,
      title: p.title ?? `node-${p.id.slice(0, 4)}`,
      cwd: p.cwd,
      createdAt: p.createdAt ?? Date.now(),
      hasResumeData: p.hasResumeData ?? false,
      term: null,
      cols: 120,
      rows: 30,
      alive: false,
      exitCode: null,
      scrollback: '',
      subscribers: new Set(),
    });
  }
  console.log(`[maestro] restored ${sessions.size} dormant session(s) from ${STORE_FILE}`);
}

// ───────── helpers ─────────

const CLAUDE_BIN = process.env.MAESTRO_CLAUDE_BIN ?? 'claude';

function toInfo(s: Session): SessionInfo {
  return {
    id: s.id,
    shell: CLAUDE_BIN,
    cwd: s.cwd,
    cols: s.cols,
    rows: s.rows,
    createdAt: s.createdAt,
    alive: s.alive,
    title: s.title,
    attached: s.term !== null,
  };
}

function appendScrollback(s: Session, data: string) {
  s.scrollback += data;
  if (s.scrollback.length > SCROLLBACK_BYTES * 1.5) {
    s.scrollback = s.scrollback.slice(-SCROLLBACK_BYTES);
  }
}

function broadcast(s: Session, msg: ServerMessage) {
  const payload = JSON.stringify(msg);
  for (const ws of s.subscribers) {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
}

function resizeSession(s: Session, cols: number, rows: number) {
  s.cols = cols;
  s.rows = rows;
  if (!s.term) return;
  try {
    s.term.resize(Math.max(1, cols), Math.max(1, rows));
  } catch {}
}

// ───────── PTY spawn ─────────

/** Spawn `claude` with --session-id (new) or --resume (existing). */
function spawnClaude(s: Session, mode: 'new' | 'resume') {
  const args =
    mode === 'new'
      ? ['--session-id', s.id]
      : ['--resume', s.id];

  // node-pty wants an absolute / on-PATH executable name; cross-platform
  // resolution is delegated to the OS via shell-less spawn (uses PATH).
  const term = pty.spawn(CLAUDE_BIN, args, {
    name: 'xterm-256color',
    cols: s.cols,
    rows: s.rows,
    cwd: s.cwd,
    env: { ...process.env, MAESTRO_SESSION: s.id } as Record<string, string>,
  });

  s.term = term;
  s.alive = true;
  s.exitCode = null;

  term.onData((data: string) => {
    appendScrollback(s, data);
    broadcast(s, { type: 'output', data });
    // Once we've seen *any* output, the conversation file exists on disk.
    if (!s.hasResumeData) {
      s.hasResumeData = true;
      persist();
    }
  });

  term.onExit(({ exitCode }) => {
    s.alive = false;
    s.exitCode = exitCode;
    s.term = null;
    broadcast(s, { type: 'exit', code: exitCode });
  });
}

function ensureSpawned(s: Session) {
  if (s.term) return;
  spawnClaude(s, s.hasResumeData ? 'resume' : 'new');
}

// ───────── lifecycle ─────────

function createSession(body: CreateSessionBody): Session {
  const id = crypto.randomUUID();
  const cwd = body.cwd?.trim() || os.homedir();
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw new Error(`cwd does not exist or is not a directory: ${cwd}`);
  }
  const s: Session = {
    id,
    title: body.title?.trim() || `node-${id.slice(0, 4)}`,
    cwd,
    createdAt: Date.now(),
    hasResumeData: false,
    term: null,
    cols: body.cols ?? 120,
    rows: body.rows ?? 30,
    alive: false,
    exitCode: null,
    scrollback: '',
    subscribers: new Set(),
  };
  sessions.set(id, s);
  persist();
  spawnClaude(s, 'new');
  return s;
}

function killSession(id: string): boolean {
  const s = sessions.get(id);
  if (!s) return false;
  broadcast(s, { type: 'exit', code: s.exitCode });
  if (s.term) {
    try {
      s.term.kill();
    } catch {}
  }
  for (const ws of s.subscribers) {
    try {
      ws.close();
    } catch {}
  }
  sessions.delete(id);
  persist();
  // Note: leaves ~/.claude/projects/<slug>/<uuid>.jsonl on disk; user can
  // still rehydrate via `claude --resume <uuid>` from a shell if desired.
  return true;
}

// ───────── HTTP ─────────

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, name: 'claude-maestro', version: 2, sessions: sessions.size });
});

app.get('/api/sessions', (_req, res) => {
  res.json({ sessions: [...sessions.values()].map(toInfo) });
});

app.post('/api/sessions', (req, res) => {
  const body = (req.body ?? {}) as CreateSessionBody;
  try {
    const s = createSession(body);
    res.status(201).json({ session: toInfo(s) });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.delete('/api/sessions/:id', (req, res) => {
  const ok = killSession(req.params.id);
  if (!ok) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json({ ok: true });
});

// ───────── filesystem completion ─────────

const FS_LIMIT = 50;
const FS_EXCLUDE = new Set(['node_modules']);

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

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

const clientDist = path.resolve(__dirname, '../client');
const isDevSource = clientDist.includes(`${path.sep}src${path.sep}`);
if (isDevSource) {
  app.get('/', (_req, res) => {
    res
      .status(404)
      .type('text/plain')
      .send(
        'claude-maestro server is running in dev mode.\n' +
          'Open the Vite client instead: http://localhost:4051\n' +
          '(this port serves the built client only, after `npm run build`)\n',
      );
  });
} else {
  app.use(express.static(clientDist));
}

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '', 'http://localhost');
  if (url.pathname !== '/maestro-ws') {
    socket.destroy();
    return;
  }
  const sessionId = url.searchParams.get('sessionId') ?? '';
  if (!sessions.has(sessionId)) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    attach(ws, sessionId);
  });
});

function attach(ws: WebSocket, sessionId: string) {
  const s = sessions.get(sessionId);
  if (!s) {
    ws.close();
    return;
  }
  s.subscribers.add(ws);

  let attached = false;

  ws.on('message', (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === 'attach') {
      if (attached) return;
      attached = true;
      resizeSession(s, msg.cols, msg.rows);
      // Lazy-revive: if session is dormant (e.g. restored from disk on boot),
      // spawn `claude --resume <uuid>` now that someone wants it.
      try {
        ensureSpawned(s);
      } catch (err) {
        const reply: ServerMessage = {
          type: 'error',
          message: `failed to spawn claude: ${(err as Error).message}`,
        };
        ws.send(JSON.stringify(reply));
        return;
      }
      const reply: ServerMessage = {
        type: 'attached',
        session: toInfo(s),
        scrollback: s.scrollback,
      };
      ws.send(JSON.stringify(reply));
      if (!s.alive && s.exitCode !== null) {
        ws.send(JSON.stringify({ type: 'exit', code: s.exitCode } satisfies ServerMessage));
      }
      return;
    }

    if (!attached) return;

    if (msg.type === 'input') {
      if (s.alive && s.term) s.term.write(msg.data);
    } else if (msg.type === 'resize') {
      resizeSession(s, msg.cols, msg.rows);
    }
  });

  ws.on('close', () => {
    s.subscribers.delete(ws);
  });
}

loadPersisted();

server.listen(PORT, () => {
  console.log(`[maestro] http + ws on http://127.0.0.1:${PORT}`);
  console.log(`[maestro] store: ${STORE_FILE}`);
});
