import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
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
const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface Session {
  id: string;
  title: string;
  shell: string;
  term: pty.IPty;
  cols: number;
  rows: number;
  createdAt: number;
  alive: boolean;
  exitCode: number | null;
  scrollback: string; // bounded ring (truncated from the head)
  subscribers: Set<WebSocket>;
}

const sessions = new Map<string, Session>();

function pickShell(): { file: string; args: string[] } {
  if (process.platform === 'win32') return { file: 'powershell.exe', args: [] };
  return { file: process.env.SHELL ?? '/bin/bash', args: [] };
}

function toInfo(s: Session): SessionInfo {
  return {
    id: s.id,
    shell: s.shell,
    cols: s.cols,
    rows: s.rows,
    createdAt: s.createdAt,
    alive: s.alive,
    title: s.title,
  };
}

function resizeSession(s: Session, cols: number, rows: number) {
  try {
    s.term.resize(Math.max(1, cols), Math.max(1, rows));
    s.cols = cols;
    s.rows = rows;
  } catch {}
}

function appendScrollback(s: Session, data: string) {
  s.scrollback += data;
  // Amortized O(1): only compact when well over the limit.
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

function createSession(body: CreateSessionBody): Session {
  const shell = pickShell();
  const cwd = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
  const cols = body.cols ?? 120;
  const rows = body.rows ?? 30;
  const id = crypto.randomUUID();

  const term = pty.spawn(shell.file, shell.args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: { ...process.env, MAESTRO_SESSION: id } as Record<string, string>,
  });

  const session: Session = {
    id,
    title: body.title ?? `node-${id.slice(0, 4)}`,
    shell: shell.file,
    term,
    cols,
    rows,
    createdAt: Date.now(),
    alive: true,
    exitCode: null,
    scrollback: '',
    subscribers: new Set(),
  };

  // Auto-launch `claude` once a shell prompt appears (or after 5s).
  let promptSeen = false;
  let promptBuf = '';
  const promptRegex = /(?:[>$#]\s)$/;
  const ansiStrip = /\x1b\[[0-9;?]*[a-zA-Z]/g;

  const launchClaude = () => {
    if (promptSeen) return;
    promptSeen = true;
    term.write('claude\r');
  };

  term.onData((data: string) => {
    appendScrollback(session, data);
    broadcast(session, { type: 'output', data });

    if (!promptSeen) {
      promptBuf += data;
      if (promptBuf.length > 4096) promptBuf = promptBuf.slice(-4096);
      if (promptRegex.test(promptBuf.replace(ansiStrip, ''))) launchClaude();
    }
  });

  const fallback = setTimeout(launchClaude, 5000);

  term.onExit(({ exitCode }) => {
    clearTimeout(fallback);
    session.alive = false;
    session.exitCode = exitCode;
    broadcast(session, { type: 'exit', code: exitCode });
  });

  sessions.set(id, session);
  return session;
}

function killSession(id: string): boolean {
  const s = sessions.get(id);
  if (!s) return false;
  // Tell subscribers we're going away so they don't reconnect-loop.
  broadcast(s, { type: 'exit', code: s.exitCode });
  try {
    s.term.kill();
  } catch {}
  for (const ws of s.subscribers) {
    try {
      ws.close();
    } catch {}
  }
  sessions.delete(id);
  return true;
}

// ---------- HTTP ----------

const app = express();
app.use(express.json());

// Permissive CORS: the portal may be served from a different origin pointing
// at this maestro by URL. Trust assumed via network reachability.
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
  res.json({ ok: true, name: 'claude-maestro', version: 1, sessions: sessions.size });
});

app.get('/api/sessions', (_req, res) => {
  res.json({ sessions: [...sessions.values()].map(toInfo) });
});

app.post('/api/sessions', (req, res) => {
  const body = (req.body ?? {}) as CreateSessionBody;
  const s = createSession(body);
  res.status(201).json({ session: toInfo(s) });
});

app.delete('/api/sessions/:id', (req, res) => {
  const ok = killSession(req.params.id);
  if (!ok) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json({ ok: true });
});

// Serve built client (only useful in production — `npm start` after build).
// In dev (`tsx watch src/server/index.ts`), __dirname resolves into src/, so
// guard against accidentally serving raw .ts source files which the browser
// rejects as MPEG-TS.
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
      const reply: ServerMessage = {
        type: 'attached',
        session: toInfo(s),
        scrollback: s.scrollback,
      };
      ws.send(JSON.stringify(reply));
      if (!s.alive) {
        ws.send(JSON.stringify({ type: 'exit', code: s.exitCode } satisfies ServerMessage));
      }
      return;
    }

    if (!attached) return;

    if (msg.type === 'input') {
      if (s.alive) s.term.write(msg.data);
    } else if (msg.type === 'resize') {
      resizeSession(s, msg.cols, msg.rows);
    }
  });

  ws.on('close', () => {
    s.subscribers.delete(ws);
  });
}

server.listen(PORT, () => {
  console.log(`[maestro] http + ws on http://127.0.0.1:${PORT}`);
});
