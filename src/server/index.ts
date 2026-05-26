import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import * as pty from '@lydell/node-pty';
import { ScrollbackBuffer } from './scrollback.js';
import { debug } from './debug.js';
import type {
  AgentType,
  ChatMessage,
  ChatMode,
  ClientMessage,
  ServerMessage,
  SessionInfo,
  SessionActivity,
  CreateSessionBody,
  ToolCallStatus,
} from '../shared/protocol.js';
import { AGENT_TYPES, ASK_UQ_ANSWER_PREFIX } from '../shared/protocol.js';
import { getStrategy, type AgentReader, type SpawnTarget } from './agents/index.js';
import { initAgentEnvironments } from './agents/all.js';
import { COPILOT_LAUNCH_MODE } from './agents/copilot.js';
import {
  requestVerdict,
  resolveVerdict,
  clearVerdictsForSession,
  type ToolVerdict,
} from './hook-pending.js';

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
  /** Copilot only: which launch mode this session was created with. Affects
   *  spawn argv shape and how `copilotSessionId` is interpreted. Missing →
   *  treat as `'direct'` for back-compat with sessions persisted before the
   *  agency launch mode was introduced. */
  copilotLaunchMode?: 'direct' | 'agency';
  /** Copilot only: the agent's own session uuid. In direct mode this equals
   *  `id`. In agency mode it is the agency-issued uuid, populated post-spawn
   *  by the strategy after watching `~/.copilot/session-state/`. Missing →
   *  not yet discovered (agency-new pre-discovery) OR direct mode (use `id`
   *  as the fallback at spawn time). */
  copilotSessionId?: string;
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

// ───────── chat mode (per-WS-subscriber) ─────────
//
// Each chat WS subscriber carries a mode controlling whether PreToolUse hooks
// broadcast a pending bubble and await a phone verdict, or just auto-allow.
// Stored as a WeakMap so closing the socket auto-cleans the entry. With
// chat-attach exclusivity, only one subscriber's mode is ever in effect.
const chatModes = new WeakMap<WebSocket, ChatMode>();

function getChatMode(ws: WebSocket): ChatMode {
  return chatModes.get(ws) ?? 'auto';
}
function setChatMode(ws: WebSocket, m: ChatMode) {
  chatModes.set(ws, m);
}
function effectiveSessionMode(s: Session): ChatMode {
  let best: ChatMode = 'auto';
  for (const ws of s.chatSubscribers) {
    const m = getChatMode(ws);
    if (m === 'always-pause') return 'always-pause';
    if (m === 'pause-next') best = 'pause-next';
  }
  return best;
}
function consumePauseNext(s: Session) {
  for (const ws of s.chatSubscribers) {
    if (getChatMode(ws) === 'pause-next') {
      setChatMode(ws, 'auto');
      const echo: ServerMessage = { type: 'chatMode', mode: 'auto' };
      try { ws.send(JSON.stringify(echo)); } catch {}
    }
  }
}

// ───────── persistence ─────────

function persist() {
  const payload: PersistedSession[] = [...sessions.values()].map((s) => ({
    id: s.id,
    title: s.title,
    cwd: s.cwd,
    createdAt: s.createdAt,
    hasResumeData: s.hasResumeData,
    agentType: s.agentType,
    copilotLaunchMode: s.copilotLaunchMode,
    copilotSessionId: s.copilotSessionId,
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
    const scrollback = new ScrollbackBuffer(SCROLLBACK_BYTES);
    loadScrollback(p.id, scrollback);
    sessions.set(p.id, {
      id: p.id,
      title: p.title ?? `node-${p.id.slice(0, 4)}`,
      cwd: p.cwd,
      createdAt: p.createdAt ?? Date.now(),
      hasResumeData: p.hasResumeData ?? false,
      agentType,
      copilotLaunchMode: p.copilotLaunchMode,
      copilotSessionId: p.copilotSessionId,
      term: null,
      cols: 120,
      rows: 30,
      alive: false,
      exitCode: null,
      scrollback,
      subscribers: new Set(),
      chatSubscribers: new Set(),
      reader: null,
      syntheticBubbles: loadBubbles(p.id),
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

const pendingScrollbackFlush = new Map<string, NodeJS.Timeout>();

function scrollbackPathFor(id: string): string {
  return path.join(SCROLLBACK_DIR, `${id}.bin`);
}

function loadScrollback(id: string, buf: ScrollbackBuffer) {
  if (!SCROLLBACK_PERSIST_ENABLED) return;
  const p = scrollbackPathFor(id);
  try {
    if (!fs.existsSync(p)) return;
    const data = fs.readFileSync(p, 'utf8');
    buf.hydrate(data);
  } catch (err) {
    // Corrupt / unreadable file shouldn't block boot — just log and move on.
    console.warn(`[maestro] failed to read scrollback for ${id}:`, (err as Error).message);
  }
}

function flushScrollback(s: Session) {
  if (!SCROLLBACK_PERSIST_ENABLED) return;
  const dst = scrollbackPathFor(s.id);
  const tmp = `${dst}.tmp`;
  try {
    fs.mkdirSync(SCROLLBACK_DIR, { recursive: true });
    fs.writeFileSync(tmp, s.scrollback.read(), 'utf8');
    fs.renameSync(tmp, dst);
  } catch (err) {
    console.warn(`[maestro] failed to flush scrollback for ${s.id}:`, (err as Error).message);
    try {
      fs.unlinkSync(tmp);
    } catch {}
  }
}

function scheduleScrollbackFlush(s: Session) {
  if (!SCROLLBACK_PERSIST_ENABLED) return;
  const existing = pendingScrollbackFlush.get(s.id);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    pendingScrollbackFlush.delete(s.id);
    flushScrollback(s);
  }, SCROLLBACK_FLUSH_DEBOUNCE_MS);
  // Don't keep the Node process alive just because a debounce window is
  // open — the SIGINT/SIGTERM handlers will flush synchronously on exit.
  t.unref();
  pendingScrollbackFlush.set(s.id, t);
}

function deleteScrollback(id: string) {
  const pending = pendingScrollbackFlush.get(id);
  if (pending) {
    clearTimeout(pending);
    pendingScrollbackFlush.delete(id);
  }
  if (!SCROLLBACK_PERSIST_ENABLED) return;
  try {
    fs.unlinkSync(scrollbackPathFor(id));
  } catch {
    // File may not exist (session created and killed before any flush).
  }
}

/** Synchronously flush every pending scrollback file. Called from the
 *  SIGINT / SIGTERM / beforeExit handlers — must not be async because Node
 *  won't await a signal handler before exiting. */
function flushAllScrollbackSync() {
  if (!SCROLLBACK_PERSIST_ENABLED) return;
  for (const [id, timer] of pendingScrollbackFlush) {
    clearTimeout(timer);
    const s = sessions.get(id);
    if (s) flushScrollback(s);
  }
  pendingScrollbackFlush.clear();
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
  scheduleScrollbackFlush(s);
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

// ───────── synthetic tool_call bubbles ─────────
//
// PreToolUse-derived bubbles aren't in the JSONL transcript, so we persist
// them per-session as append-only JSONL under STORE_DIR/bubbles/<id>.jsonl.
// Load collapses by toolCallId (latest write wins) so pending → answered
// status flips just append another line.

function bubblesPath(sessionId: string): string {
  return path.join(BUBBLES_DIR, `${sessionId}.jsonl`);
}
function appendBubble(sessionId: string, m: ChatMessage) {
  try {
    fs.mkdirSync(BUBBLES_DIR, { recursive: true });
    fs.appendFileSync(bubblesPath(sessionId), JSON.stringify(m) + '\n');
  } catch (err) {
    console.error('[maestro] bubble persist failed:', (err as Error).message);
  }
}
function loadBubbles(sessionId: string): Map<string, ChatMessage> {
  const out = new Map<string, ChatMessage>();
  const p = bubblesPath(sessionId);
  if (!fs.existsSync(p)) return out;
  let raw: string;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch {
    return out;
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: ChatMessage;
    try {
      parsed = JSON.parse(trimmed) as ChatMessage;
    } catch {
      continue;
    }
    if (parsed && parsed.type === 'tool_call') {
      out.set(parsed.toolCallId, parsed);
    }
  }
  return out;
}
function deleteBubbleFile(sessionId: string) {
  try { fs.rmSync(bubblesPath(sessionId), { force: true }); } catch {}
}

/** Broadcast a tool_call bubble AND remember it on the session so a
 *  reconnecting chat client can replay it. Status updates replace prior
 *  entries with the same toolCallId. */
function broadcastToolCall(s: Session, m: Extract<ChatMessage, { type: 'tool_call' }>) {
  s.syntheticBubbles.set(m.toolCallId, m);
  if (s.syntheticBubbles.size > 500) {
    const firstKey = s.syntheticBubbles.keys().next().value as string | undefined;
    if (firstKey !== undefined) s.syntheticBubbles.delete(firstKey);
  }
  appendBubble(s.id, m);
  broadcastChat(s, { type: 'chatMessage', message: m });
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

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

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

  // Copilot launch-mode mismatch guard: a session persisted under one mode
  // (direct vs agency) cannot be revived in the other — the spawn argv shape
  // and uuid ownership differ. Silent-fresh-start would silently lose
  // conversation history, so fail closed with a clear message.
  if (s.agentType === 'copilot') {
    const persistedMode = s.copilotLaunchMode ?? 'direct';
    if (persistedMode !== COPILOT_LAUNCH_MODE) {
      throw new Error(
        `Copilot session ${s.id} was created in '${persistedMode}' launch mode, ` +
          `but this maestro process is running in '${COPILOT_LAUNCH_MODE}' mode. ` +
          `To resume this session, restart maestro with the original mode ` +
          `(set/unset MAESTRO_COPILOT_AGENCY and MAESTRO_COPILOT_BIN accordingly). ` +
          `To start over, delete the session and create a new one.`,
      );
    }
    // Direct-mode sessions: copilotSessionId is always equal to id. For old
    // pre-feature records this field is undefined on disk; backfill so the
    // reader's path resolution finds the events.jsonl immediately.
    if (persistedMode === 'direct' && !s.copilotSessionId) {
      s.copilotSessionId = s.id;
    }
  }

  const target: SpawnTarget = {
    id: s.id,
    cwd: s.cwd,
    cols: s.cols,
    rows: s.rows,
    copilotSessionId: s.copilotSessionId,
    onCopilotSessionId: (copilotSessionId: string) => {
      if (s.copilotSessionId === copilotSessionId) return;
      s.copilotSessionId = copilotSessionId;
      persist();
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
    // Copilot-only: record the launch mode at create time so a future
    // maestro restart in a different mode can fail closed instead of
    // silently starting fresh. In direct mode, the copilot uuid equals our
    // id; in agency mode, agency owns the uuid and we discover it post-
    // spawn (copilotSessionId stays undefined until then).
    copilotLaunchMode: agentType === 'copilot' ? COPILOT_LAUNCH_MODE : undefined,
    copilotSessionId:
      agentType === 'copilot' && COPILOT_LAUNCH_MODE === 'direct' ? id : undefined,
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
  deleteScrollback(id);
  deleteBubbleFile(id);
  // Note: leaves the agent's on-disk transcript intact (Claude's
  // ~/.claude/projects/<slug>/<uuid>.jsonl or Copilot's
  // ~/.copilot/session-state/<uuid>/events.jsonl) so the user can still
  // rehydrate via the agent's own `--resume <uuid>` from a shell if desired.
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

// Security headers for the static client pages. We can't lock `connect-src`
// down because the desktop client connects to user-configured remote maestro
// servers over HTTP(S)/WS(S); the rest of the policy still reduces blast
// radius (no inline <script>, no framing, only known CDNs).
//
// `style-src 'unsafe-inline'` is required: both clients use inline
// `style="--var:…"` attributes for dynamic CSS variables. The DOMPurify-
// sanitized chat markdown also relies on `'unsafe-inline'` to render the
// few inline styles marked allows by default. Tightening this would mean
// either nonces (server-rendered, can't statically serve) or hashes for
// every inline style — neither is worth the churn for this app's threat model.
const CSP = [
  "default-src 'self'",
  "script-src 'self' https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  // `blob:` is required for `@xterm/addon-image` — the renderer creates
  // ObjectURLs for decoded sixel / iTerm IIP frames before painting them
  // onto the overlay canvas. Without `blob:` here the addon silently fails
  // in production builds (Vite dev is more permissive about CSP).
  "img-src 'self' data: blob:",
  "connect-src 'self' ws: wss: http: https:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Frame-Options', 'DENY');
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

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

  // PreToolUse for Claude is special — the response body carries the verdict
  // back to claude (allow/deny). Other events get a 204 immediately.
  if (s && s.agentType === 'claude' && event === 'PreToolUse') {
    const verdict = await handlePreToolUse(s, req.body ?? {});
    res.json(verdict);
    return;
  }
  res.status(204).end();
});

/** Bridge a PreToolUse hook through the mobile chat (if any). Always
 *  resolves with a verdict the hook script can serialize as
 *  `permissionDecision: 'allow' | 'deny'`. */
async function handlePreToolUse(
  s: Session,
  body: Record<string, unknown>,
): Promise<ToolVerdict> {
  const toolName = String(body.tool_name ?? 'unknown');
  const toolInput = body.tool_input ?? {};
  const toolCallId =
    (body.tool_use_id as string | undefined) ?? crypto.randomUUID();
  const ts = Date.now();

  const mode = effectiveSessionMode(s);

  // AskUserQuestion: always intercept when a chat client is attached, even in
  // auto mode — otherwise the desktop TUI menu grabs the answer and the phone
  // sees a spurious result. Translates chosen option to deny+reason so Claude
  // reads it as user feedback. If no chat subscriber is present, fall through
  // to allow so desktop TUI handles it normally.
  const isAskUQ = toolName === 'AskUserQuestion';
  const forcePause = isAskUQ && s.chatSubscribers.size > 0;

  if (mode === 'auto' && !forcePause) {
    broadcastToolCall(s, {
      type: 'tool_call',
      toolCallId,
      toolName,
      toolInput,
      status: 'allowed',
      ts,
    });
    return { decision: 'allow' };
  }

  broadcastToolCall(s, {
    type: 'tool_call',
    toolCallId,
    toolName,
    toolInput,
    status: 'pending',
    ts,
  });
  debug(`[hook] PreToolUse ${s.id.slice(0, 8)} ${toolName} — awaiting verdict (mode=${mode}${forcePause ? ', force-pause' : ''})`);
  const verdict = await requestVerdict(s.id, toolCallId, 55_000);
  debug(`[hook] PreToolUse ${s.id.slice(0, 8)} ${toolName} → ${verdict.decision}${verdict.timedOut ? ' (timeout)' : ''}`);

  // AskUserQuestion bridge: convert verdict to deny+reason so Claude reads
  // it as user feedback. On timeout, deny with a "no answer" reason so Claude
  // moves on rather than auto-allowing into a broken TUI flow.
  let effectiveVerdict: ToolVerdict = verdict;
  if (isAskUQ) {
    effectiveVerdict = {
      decision: 'deny',
      reason: verdict.reason ?? (verdict.timedOut ? 'no answer from mobile user' : 'no selection'),
      timedOut: verdict.timedOut,
    };
  }

  let status: ToolCallStatus;
  let displayReason = effectiveVerdict.reason;
  if (isAskUQ) {
    if (effectiveVerdict.timedOut) {
      status = 'timedout';
    } else {
      status = 'answered';
      if (displayReason && displayReason.startsWith(ASK_UQ_ANSWER_PREFIX)) {
        displayReason = displayReason.slice(ASK_UQ_ANSWER_PREFIX.length);
      }
    }
  } else {
    status = effectiveVerdict.timedOut
      ? 'timedout'
      : effectiveVerdict.decision === 'deny'
        ? 'denied'
        : 'allowed';
  }
  broadcastToolCall(s, {
    type: 'tool_call',
    toolCallId,
    toolName,
    toolInput,
    status,
    denyReason: displayReason,
    ts: Date.now(),
  });

  // pause-next is one-shot. AskUQ bridging doesn't consume it (the pause was
  // forced for this tool regardless of mode).
  if (!isAskUQ) consumePauseNext(s);

  return effectiveVerdict;
}

// ───────── filesystem completion ─────────

const FS_LIMIT = 50;
const FS_EXCLUDE = new Set(['node_modules']);

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

// ───────── filesystem browse + read (per-session, clamped to cwd) ─────────

const FS_READ_MAX_BYTES = 2 * 1024 * 1024;

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

app.get('/api/fs/list', (req, res) => {
  const sid = String(req.query.sessionId ?? '');
  const s = sessions.get(sid);
  if (!s) {
    res.status(404).json({ error: 'session not found' });
    return;
  }
  const rel = String(req.query.path ?? '');
  let resolved;
  try {
    resolved = resolveInsideCwd(s.cwd, rel);
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
  res.json({ cwd: s.cwd, path: resolved.rel, abs: resolved.abs, entries });
});

app.get('/api/fs/read', (req, res) => {
  const sid = String(req.query.sessionId ?? '');
  const s = sessions.get(sid);
  if (!s) {
    res.status(404).json({ error: 'session not found' });
    return;
  }
  const rel = String(req.query.path ?? '');
  let resolved;
  try {
    resolved = resolveInsideCwd(s.cwd, rel);
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
      setChatMode(ws, 'auto');
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
      setChatMode(ws, msg.mode);
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
