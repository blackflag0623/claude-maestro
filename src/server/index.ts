import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import * as pty from '@lydell/node-pty';
import { ScrollbackBuffer } from './scrollback.js';
import { debug } from './debug.js';
import type {
  AgentType,
  ChatMessage,
  ClientMessage,
  ServerMessage,
  SessionInfo,
  SessionActivity,
  CreateSessionBody,
} from '../shared/protocol.js';
import { AGENT_TYPES } from '../shared/protocol.js';
import { getStrategy, type AgentReader, type SpawnTarget } from './agents/index.js';
import { initAgentEnvironments } from './agents/all.js';
import { resolveVerdict, clearVerdictsForSession } from './hook-pending.js';
import { ScrollbackStore } from './scrollback-store.js';
import { BubbleStore } from './bubble-store.js';
import { ChatGating } from './chat-gating.js';
import { mountFsRoutes, expandHome } from './fs-routes.js';
import { mountSecurityMiddleware } from './http-security.js';

function isAgentType(x: unknown): x is AgentType {
  return typeof x === 'string' && (AGENT_TYPES as readonly string[]).includes(x);
}

const PORT = Number(process.env.PORT ?? 4050);
const SCROLLBACK_BYTES = 256 * 1024;
const STORE_DIR =
  process.env.MAESTRO_STORE_DIR ??
  path.join(os.homedir(), '.claude-maestro');
const STORE_FILE = path.join(STORE_DIR, 'sessions.json');
const SCROLLBACK_DIR = path.join(STORE_DIR, 'scrollback');
const BUBBLES_DIR = path.join(STORE_DIR, 'bubbles');
const SCROLLBACK_FLUSH_DEBOUNCE_MS = 2_000;
/** Opt-out for users who don't want PTY bytes (which may include tokens,
 *  paths, etc.) cached on disk across maestro restarts. When set, the
 *  server falls back to the original in-memory-only behavior. */
const SCROLLBACK_PERSIST_ENABLED =
  process.env.MAESTRO_DISABLE_SCROLLBACK_PERSIST !== '1';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Read package.json once at startup. We walk up from this file because the
// server runs from `dist/server/` after build but from `src/server/` under
// `tsx`; in either case the package.json is two directories up.
const PKG_VERSION: string = (() => {
  try {
    const pkgPath = path.resolve(__dirname, '..', '..', 'package.json');
    const raw = fs.readFileSync(pkgPath, 'utf8');
    return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

interface PersistedSession {
  id: string;
  title: string;
  cwd: string;
  createdAt: number;
  hasResumeData: boolean; // false until first run actually persists conversation
  /** Which CLI agent backs this session. Defaults to `'claude'` on load for
   *  records persisted before the agent abstraction was introduced. */
  agentType: AgentType;
  /** Per-agent opaque state, owned by the strategy module. Anything the
   *  strategy needs to round-trip across maestro restarts goes here. Older
   *  records may carry legacy top-level `copilotLaunchMode` /
   *  `copilotSessionId` fields; we migrate those on load. */
  agentState: Record<string, unknown>;
}

interface Session extends PersistedSession {
  term: pty.IPty | null; // null = dormant (not yet revived this maestro process)
  cols: number;
  rows: number;
  alive: boolean;
  exitCode: number | null;
  scrollback: ScrollbackBuffer;
  subscribers: Set<WebSocket>;
  /** Subset of `subscribers` that attached via `attachChat`. They receive
   *  `chatMessage` frames (parsed from the agent's on-disk transcript)
   *  instead of raw `output`. */
  chatSubscribers: Set<WebSocket>;
  /** Per-agent transcript reader. Lazily created when the PTY is spawned,
   *  used both to derive activity (claude via hook poke / copilot via file
   *  tailing) and to serve chat history on `attachChat`. */
  reader: AgentReader | null;
  /** In-memory ring of synthetic ChatMessages (currently `tool_call` bubbles)
   *  the server fabricated that the JSONL transcript doesn't contain. Used to
   *  replay them when a chat client reconnects. Keyed by toolCallId so status
   *  updates replace rather than stack. Capped at 500. */
  syntheticBubbles: Map<string, ChatMessage>;
  activity: SessionActivity;
}

const sessions = new Map<string, Session>();

const scrollbackStore = new ScrollbackStore({
  dir: SCROLLBACK_DIR,
  debounceMs: SCROLLBACK_FLUSH_DEBOUNCE_MS,
  enabled: SCROLLBACK_PERSIST_ENABLED,
});
const bubbleStore = new BubbleStore(BUBBLES_DIR);
const chatGating = new ChatGating({
  bubbleStore,
  broadcastChat: (s, msg) => broadcastChat(s as Session, msg),
});

// ───────── persistence ─────────

function persist() {
  const payload: PersistedSession[] = [...sessions.values()].map((s) => ({
    id: s.id,
    title: s.title,
    cwd: s.cwd,
    createdAt: s.createdAt,
    hasResumeData: s.hasResumeData,
    agentType: s.agentType,
    agentState: s.agentState,
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
    // Backward compat: pre-abstraction records have no agentType. Unknown
    // values get quarantined (we skip the entry rather than crash later).
    const at = (p as Partial<PersistedSession>).agentType;
    let agentType: AgentType;
    if (at === undefined) {
      agentType = 'claude';
    } else if (isAgentType(at)) {
      agentType = at;
    } else {
      console.warn(`[maestro] skipping session ${p.id} with unknown agentType: ${String(at)}`);
      continue;
    }
    // Migrate legacy top-level Copilot fields into agentState. Older records
    // wrote `copilotLaunchMode` / `copilotSessionId` directly on the record.
    const legacy = p as Partial<PersistedSession> & {
      copilotLaunchMode?: 'direct' | 'agency';
      copilotSessionId?: string;
    };
    let agentState: Record<string, unknown> =
      (p.agentState && typeof p.agentState === 'object' ? p.agentState : {}) as Record<string, unknown>;
    if (agentType === 'copilot' && Object.keys(agentState).length === 0) {
      agentState = {
        copilotLaunchMode: legacy.copilotLaunchMode,
        copilotSessionId: legacy.copilotSessionId,
      };
    }
    // Strategy can reject the rehydrated state (e.g. Copilot launch-mode
    // mismatch). We surface that as a warning and skip the session — better
    // than failing later inside spawn with an opaque error.
    try {
      getStrategy(agentType).validateAgentState?.(agentState);
    } catch (err) {
      console.warn(`[maestro] skipping session ${p.id}: ${(err as Error).message}`);
      continue;
    }
    const scrollback = new ScrollbackBuffer(SCROLLBACK_BYTES);
    scrollbackStore.hydrate(p.id, scrollback);
    sessions.set(p.id, {
      id: p.id,
      title: p.title ?? `node-${p.id.slice(0, 4)}`,
      cwd: p.cwd,
      createdAt: p.createdAt ?? Date.now(),
      hasResumeData: p.hasResumeData ?? false,
      agentType,
      agentState,
      term: null,
      cols: 120,
      rows: 30,
      alive: false,
      exitCode: null,
      scrollback,
      subscribers: new Set(),
      chatSubscribers: new Set(),
      reader: null,
      syntheticBubbles: bubbleStore.load(p.id),
      activity: 'unknown',
    });
  }
  debug(`[maestro] restored ${sessions.size} dormant session(s) from ${STORE_FILE}`);
}

// ───────── scrollback persistence ─────────
//
// PTY bytes mirrored to ~/.claude-maestro/scrollback/<id>.bin so the visual
// buffer survives maestro restart. Writes debounce ~2s and use rename-over-
// temp. Disable via MAESTRO_DISABLE_SCROLLBACK_PERSIST=1 (see KNOWN_ISSUES.md).
// Implementation lives in `scrollback-store.ts`; this section is just the
// glue that pairs sessions with the store.

/** Synchronously flush every pending scrollback file. Called from the
 *  SIGINT / SIGTERM / beforeExit handlers — must not be async because Node
 *  won't await a signal handler before exiting. */
function flushAllScrollbackSync() {
  const reads = new Map<string, () => string>();
  for (const [id, s] of sessions) reads.set(id, () => s.scrollback.read());
  scrollbackStore.flushAll(reads);
}

// ───────── helpers ─────────

function toInfo(s: Session): SessionInfo {
  return {
    id: s.id,
    cwd: s.cwd,
    cols: s.cols,
    rows: s.rows,
    createdAt: s.createdAt,
    alive: s.alive,
    title: s.title,
    attached: s.term !== null,
    activity: s.activity,
    agentType: s.agentType,
  };
}

function appendScrollback(s: Session, data: string) {
  s.scrollback.append(data);
  scrollbackStore.schedule(s.id, () => s.scrollback.read());
}

function broadcast(s: Session, msg: ServerMessage) {
  const payload = JSON.stringify(msg);
  for (const ws of s.subscribers) {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
}

/** Sends a frame to terminal subscribers (everyone in `subscribers` who is NOT a chat client). */
function broadcastTerminal(s: Session, msg: ServerMessage) {
  const payload = JSON.stringify(msg);
  for (const ws of s.subscribers) {
    if (s.chatSubscribers.has(ws)) continue;
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
}

function broadcastChat(s: Session, msg: ServerMessage) {
  const payload = JSON.stringify(msg);
  for (const ws of s.chatSubscribers) {
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

// Writes >1KB are split into chunks dispatched across libuv ticks so
// node-pty drains between writes (ConPTY's pipe buffer is small).
// Bracketed-paste spans are kept atomic (up to 64 KB) so the TUI sees
// the whole span in one read.
const PTY_WRITE_CHUNK = 1024;
const PTY_BRACKETED_MAX = 64 * 1024;
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

function splitPasteSpans(data: string): string[] {
  const parts: string[] = [];
  let i = 0;
  while (i < data.length) {
    const start = data.indexOf(PASTE_START, i);
    if (start < 0) { parts.push(data.slice(i)); break; }
    if (start > i) parts.push(data.slice(i, start));
    const end = data.indexOf(PASTE_END, start + PASTE_START.length);
    if (end < 0) { parts.push(data.slice(start)); break; }
    const spanEnd = end + PASTE_END.length;
    parts.push(data.slice(start, spanEnd));
    i = spanEnd;
  }
  return parts;
}

function writeToPty(s: Session, data: string) {
  if (!s.term || data.length === 0) return;

  if (data.length <= PTY_WRITE_CHUNK && !data.includes(PASTE_START)) {
    s.term.write(data);
    return;
  }

  const parts = splitPasteSpans(data);
  let pi = 0;
  let off = 0;

  const pump = () => {
    if (!s.term || pi >= parts.length) return;
    const piece = parts[pi]!;

    if (piece.startsWith(PASTE_START) && piece.length <= PTY_BRACKETED_MAX) {
      s.term.write(piece);
      pi++;
      off = 0;
    } else {
      s.term.write(piece.slice(off, off + PTY_WRITE_CHUNK));
      off += PTY_WRITE_CHUNK;
      if (off >= piece.length) { pi++; off = 0; }
    }

    if (pi < parts.length) setImmediate(pump);
  };
  pump();
}

// expandHome is imported from fs-routes (single definition).

function setActivity(s: Session, a: SessionActivity) {
  if (s.activity === a) return;
  s.activity = a;
  broadcast(s, { type: 'activity', activity: a });
}

// ───────── PTY spawn (agent-agnostic) ─────────

/** Grace period before disposing a reader after natural PTY exit. Gives the
 *  agent a final chance to flush any tail-end transcript writes. */
const READER_DISPOSE_GRACE_MS = 1500;

function spawnAgent(s: Session, mode: 'new' | 'resume') {
  const strategy = getStrategy(s.agentType);

  // Strategy gets one final chance to refuse the agentState — used by Copilot
  // to fail-closed on launch-mode mismatch. (Already enforced on load, but
  // defensive against in-memory tampering or future state mutations.)
  strategy.validateAgentState?.(s.agentState);

  const target: SpawnTarget = {
    id: s.id,
    cwd: s.cwd,
    cols: s.cols,
    rows: s.rows,
    agentState: s.agentState,
    onAgentStateChange: (next: Record<string, unknown>) => {
      // Strategy mutates target.agentState in place AND calls back so we can
      // persist. The reference is shared (target.agentState === s.agentState)
      // so the in-memory copy already reflects the change; this just snapshots.
      s.agentState = next;
      persist();
    },
    onResumeUnavailable: (reason: string) => {
      // The strategy detected that a resume can't proceed (transcript / session
      // record gone) and is downgrading to a fresh session. Reset the resume
      // bookkeeping and surface a banner so the user knows the conversation
      // was reset rather than silently lost.
      if (s.hasResumeData) {
        s.hasResumeData = false;
        persist();
      }
      const banner =
        `\r\n\x1b[33m[maestro] Cannot resume previous conversation: ${reason}.\r\n` +
        `          Starting a fresh session in this node.\x1b[0m\r\n\r\n`;
      appendScrollback(s, banner);
      broadcastTerminal(s, { type: 'output', data: banner });
    },
  };

  const term = strategy.spawn(target, mode);
  s.term = term;
  s.alive = true;
  s.exitCode = null;

  // Reader is created once per spawn so it sees the same target snapshot the
  // PTY was spawned with. Disposed on natural exit (with grace) or kill.
  if (!s.reader) {
    s.reader = strategy.createReader(target, {
      onActivity: (a) => setActivity(s, a),
      onChatMessage: (m) => broadcastChat(s, { type: 'chatMessage', message: m }),
    });
  }

  term.onData((data: string) => {
    appendScrollback(s, data);
    broadcastTerminal(s, { type: 'output', data });
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
    setActivity(s, 'unknown');
    broadcast(s, { type: 'exit', code: exitCode });
    // Give the reader a brief window to catch a final transcript write
    // (e.g. an `assistant.turn_end` event arriving just after the PTY exits)
    // before tearing down its timers.
    const reader = s.reader;
    if (reader) {
      s.reader = null;
      setTimeout(() => {
        try {
          reader.dispose();
        } catch {}
      }, READER_DISPOSE_GRACE_MS);
    }
  });
}

function ensureSpawned(s: Session) {
  if (s.term) return;
  spawnAgent(s, s.hasResumeData ? 'resume' : 'new');
}

// ───────── lifecycle ─────────

function createSession(body: CreateSessionBody): Session {
  const id = crypto.randomUUID();
  const cwd = body.cwd?.trim() ? expandHome(body.cwd.trim()) : os.homedir();
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw new Error(`cwd does not exist or is not a directory: ${cwd}`);
  }
  let agentType: AgentType = 'claude';
  if (body.agentType !== undefined) {
    if (!isAgentType(body.agentType)) {
      throw new Error(`unknown agentType: ${String(body.agentType)}`);
    }
    agentType = body.agentType;
  }
  const s: Session = {
    id,
    title: body.title?.trim() || `node-${id.slice(0, 4)}`,
    cwd,
    createdAt: Date.now(),
    hasResumeData: false,
    agentType,
    // Strategy seeds its initial state (e.g. Copilot launch mode + uuid).
    agentState: getStrategy(agentType).initialAgentState?.(id) ?? {},
    term: null,
    cols: body.cols ?? 120,
    rows: body.rows ?? 30,
    alive: false,
    exitCode: null,
    scrollback: new ScrollbackBuffer(SCROLLBACK_BYTES),
    subscribers: new Set(),
    chatSubscribers: new Set(),
    reader: null,
    syntheticBubbles: new Map(),
    activity: 'unknown',
  };
  sessions.set(id, s);
  try {
    spawnAgent(s, 'new');
  } catch (err) {
    sessions.delete(id);
    throw err;
  }
  persist();
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
  if (s.reader) {
    try {
      s.reader.dispose();
    } catch {}
    s.reader = null;
  }
  for (const ws of s.subscribers) {
    try {
      ws.close();
    } catch {}
  }
  sessions.delete(id);
  persist();
  scrollbackStore.remove(id);
  bubbleStore.remove(id);
  // Note: leaves the agent's on-disk transcript intact (Claude's
  // ~/.claude/projects/<slug>/<uuid>.jsonl or Copilot's
  // ~/.copilot/session-state/<uuid>/events.jsonl) so the user can still
  // rehydrate via the agent's own `--resume <uuid>` from a shell if desired.
  return true;
}

// ───────── HTTP ─────────

const app = express();
app.use(express.json());
mountSecurityMiddleware(app);

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, name: 'claude-maestro', version: PKG_VERSION, sessions: sessions.size });
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

// Hook callback: agent processes (currently only Claude) POST here from the
// wrapper script. The event name arrives in `x-maestro-event`; the JSON body
// always contains `session_id`. The strategy decides what each event means
// for activity / chat — Copilot doesn't have hooks at all and its strategy
// returns null.
app.post('/api/hook', async (req, res) => {
  const event = String(req.headers['x-maestro-event'] ?? '');
  const sid = (req.body?.session_id as string | undefined) ?? '';
  debug(`[hook] event=${event} session_id=${sid.slice(0, 8)}`);
  const s = sid ? sessions.get(sid) : undefined;
  if (!s && sid) {
    debug(`[hook] no session in map for ${sid.slice(0, 8)} — known: [${[...sessions.keys()].map((k) => k.slice(0, 8)).join(',')}]`);
  }
  if (s) {
    const strategy = getStrategy(s.agentType);
    const outcome = strategy.handleHookEvent?.(event, req.body) ?? null;
    if (outcome?.activity) setActivity(s, outcome.activity);
    if (outcome?.flushChat) s.reader?.poke();
  }

  // PreToolUse: only agents declaring `supportsPermissionGating` participate
  // in the chat-bridged Allow/Deny flow. Others' PreToolUse (if they have one
  // at all) just gets a 204 like any other event.
  if (s && getStrategy(s.agentType).supportsPermissionGating && event === 'PreToolUse') {
    const verdict = await chatGating.handlePreToolUse(s, req.body ?? {});
    res.json(verdict);
    return;
  }
  res.status(204).end();
});

mountFsRoutes(app, (sid) => sessions.get(sid)?.cwd ?? null);

const clientDist = path.resolve(__dirname, '../client');
const mobileDist = path.resolve(__dirname, '../client-mobile');
const isDevSource = clientDist.includes(`${path.sep}src${path.sep}`);
if (isDevSource) {
  app.get('/', (_req, res) => {
    res
      .status(404)
      .type('text/plain')
      .send(
        'claude-maestro server is running in dev mode.\n' +
          'Open the Vite client instead: http://localhost:4051 (desktop)\n' +
          '                          or  http://localhost:4052 (mobile)\n' +
          '(this port serves the built clients only, after `npm run build`)\n',
      );
  });
  app.get('/m', (_req, res) => {
    res
      .status(404)
      .type('text/plain')
      .send(
        'mobile client is dev-only on this port.\n' +
          'Open http://localhost:4052 instead, or run `npm run build` first.\n',
      );
  });
} else {
  // Mount mobile first so /m/* doesn't fall through to the root SPA.
  app.use('/m', express.static(mobileDist));
  app.use(express.static(clientDist));
}

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// WebSocket keepalive. Without this a half-open socket (mobile client backgrounded,
// laptop slept, NAT idle-timeout, etc.) can hold an exclusive `attachChat`
// subscription indefinitely, locking everyone else out with `chatLocked`.
//
// Protocol: every WS_PING_INTERVAL_MS we ping each socket; on the previous
// tick we also check whether the pong from the round before that arrived.
// If two consecutive intervals pass with no pong, terminate — which fires
// `close`, which runs the cleanup in `attach()` and frees the session.
const WS_PING_INTERVAL_MS = 25_000;
interface KeepaliveSocket extends WebSocket { isAlive?: boolean }

const keepaliveTimer = setInterval(() => {
  for (const ws of wss.clients as Set<KeepaliveSocket>) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      // Socket already dying; next tick will terminate it.
    }
  }
}, WS_PING_INTERVAL_MS);
keepaliveTimer.unref?.();

wss.on('close', () => {
  clearInterval(keepaliveTimer);
});

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
    const ka = ws as KeepaliveSocket;
    ka.isAlive = true;
    ws.on('pong', () => { ka.isAlive = true; });
    attach(ws, sessionId);
  });
});

function attach(ws: WebSocket, sessionId: string) {
  const s = sessions.get(sessionId);
  if (!s) {
    ws.close();
    return;
  }

  let attached = false;
  let mode: 'terminal' | 'chat' | null = null;

  ws.on('message', (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === 'attach') {
      if (attached) return;
      s.subscribers.add(ws);
      mode = 'terminal';
      resizeSession(s, msg.cols, msg.rows);
      try {
        ensureSpawned(s);
      } catch (err) {
        const reply: ServerMessage = {
          type: 'error',
          message: `failed to spawn ${s.agentType}: ${(err as Error).message}`,
        };
        ws.send(JSON.stringify(reply));
        s.subscribers.delete(ws);
        ws.close();
        return;
      }
      attached = true;
      const reply: ServerMessage = {
        type: 'attached',
        session: toInfo(s),
        scrollback: s.scrollback.read(),
      };
      ws.send(JSON.stringify(reply));
      if (!s.alive && s.exitCode !== null) {
        ws.send(JSON.stringify({ type: 'exit', code: s.exitCode } satisfies ServerMessage));
      }
      return;
    }

    if (msg.type === 'attachChat') {
      if (attached) return;
      // Exclusive chat mode: no other subscriber may be connected.
      if (s.subscribers.size > 0) {
        const reply: ServerMessage = {
          type: 'error',
          code: 'chatLocked',
          message: 'another client is connected to this session',
        };
        ws.send(JSON.stringify(reply));
        ws.close();
        return;
      }
      s.subscribers.add(ws);
      s.chatSubscribers.add(ws);
      mode = 'chat';
      resizeSession(s, msg.cols, msg.rows);
      try {
        ensureSpawned(s);
      } catch (err) {
        const reply: ServerMessage = {
          type: 'error',
          message: `failed to spawn ${s.agentType}: ${(err as Error).message}`,
        };
        ws.send(JSON.stringify(reply));
        s.subscribers.delete(ws);
        s.chatSubscribers.delete(ws);
        ws.close();
        return;
      }
      // The spawn path lazily creates a reader for this session. If the
      // strategy declined to (a future agent type without a transcript at
      // all), tell the client up front so it can disable the chat UI.
      if (!s.reader) {
        const reply: ServerMessage = {
          type: 'error',
          code: 'chatNotSupported',
          message: `agent ${s.agentType} does not support chat`,
        };
        ws.send(JSON.stringify(reply));
        s.subscribers.delete(ws);
        s.chatSubscribers.delete(ws);
        ws.close();
        return;
      }
      attached = true;
      chatGating.setMode(ws, 'auto');
      // Merge JSONL transcript entries with in-memory synthetic tool_call
      // bubbles, sorted by ts so the conversation reads chronologically.
      const transcript = s.reader.readAll();
      const synthetic = [...s.syntheticBubbles.values()];
      const history: ChatMessage[] = [...transcript, ...synthetic].sort((a, b) => a.ts - b.ts);
      const reply: ServerMessage = {
        type: 'chatAttached',
        session: toInfo(s),
        history,
        mode: 'auto',
      };
      ws.send(JSON.stringify(reply));
      if (!s.alive && s.exitCode !== null) {
        ws.send(JSON.stringify({ type: 'exit', code: s.exitCode } satisfies ServerMessage));
      }
      return;
    }

    if (!attached) return;

    if (msg.type === 'input') {
      if (mode === 'chat') {
        debug(`[chat] ${s.id.slice(0, 8)} input: ${JSON.stringify(msg.data.slice(0, 80))}`);
      }
      writeToPty(s, msg.data);
    } else if (msg.type === 'resize') {
      // Chat clients have no real cols/rows; ignore their resizes so they don't
      // fight a (future) terminal client's geometry. Exclusive mode currently
      // makes this moot, but keep the guard for when exclusivity loosens.
      if (mode === 'chat') return;
      resizeSession(s, msg.cols, msg.rows);
    } else if (msg.type === 'setChatMode') {
      if (mode !== 'chat') return;
      chatGating.setMode(ws, msg.mode);
      ws.send(JSON.stringify({ type: 'chatMode', mode: msg.mode } satisfies ServerMessage));
      debug(`[chat] ${s.id.slice(0, 8)} mode → ${msg.mode}`);
    } else if (msg.type === 'toolDecision') {
      if (mode !== 'chat') return;
      const ok = resolveVerdict(s.id, msg.toolCallId, {
        decision: msg.decision,
        reason: msg.reason,
      });
      debug(`[chat] ${s.id.slice(0, 8)} toolDecision ${msg.toolCallId.slice(0, 8)} ${msg.decision} (resolved=${ok})`);
    }
  });

  ws.on('close', () => {
    const wasChat = s.chatSubscribers.has(ws);
    s.subscribers.delete(ws);
    s.chatSubscribers.delete(ws);
    // Chat client disappeared mid-PreToolUse → release the wait so Claude
    // isn't blocked until the 55s timeout fires.
    if (wasChat) clearVerdictsForSession(s.id);
  });
}

loadPersisted();

// Flush any debounced scrollback to disk before the process actually exits.
// Signal handlers MUST stay synchronous — Node does not await async work in
// SIGINT/SIGTERM listeners before terminating, and any I/O queued after the
// listener returns is lost. After flushing we re-raise the exit so we don't
// silently swallow Ctrl+C.
let exiting = false;
function gracefulExit(signal: NodeJS.Signals | 'beforeExit', code = 0) {
  if (exiting) return;
  exiting = true;
  try {
    flushAllScrollbackSync();
  } catch (err) {
    console.error('[maestro] scrollback flush failed during exit:', (err as Error).message);
  }
  if (signal !== 'beforeExit') {
    // Default Node action for SIGINT is exit(130); preserve conventional codes.
    process.exit(signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : code);
  }
}
process.on('SIGINT', () => gracefulExit('SIGINT'));
process.on('SIGTERM', () => gracefulExit('SIGTERM'));
process.on('beforeExit', (code) => gracefulExit('beforeExit', code));

server.listen(PORT, () => {
  const addr = server.address();
  const boundPort = typeof addr === 'object' && addr ? addr.port : PORT;
  // Init agent helpers AFTER bind so the port baked into Claude's hook URL
  // matches what was actually claimed (PORT=0 → kernel-chosen port works).
  initAgentEnvironments(boundPort);
  // Startup banner is intentionally unguarded — operators need to see it.
  console.log(`[maestro] v${PKG_VERSION} http + ws on http://127.0.0.1:${boundPort}`);
  console.log(`[maestro] store: ${STORE_FILE}`);
  if (SCROLLBACK_PERSIST_ENABLED) {
    console.log(`[maestro] scrollback: ${SCROLLBACK_DIR}`);
  } else {
    console.log(`[maestro] scrollback persistence disabled (MAESTRO_DISABLE_SCROLLBACK_PERSIST=1)`);
  }
});
