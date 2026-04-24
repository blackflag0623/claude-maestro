import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import * as pty from '@lydell/node-pty';
import type { ClientMessage, ServerMessage } from '../shared/protocol.js';

const PORT = Number(process.env.PORT ?? 4050);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

// Serve built client in production
const clientDist = path.resolve(__dirname, '../client');
app.use(express.static(clientDist));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/maestro-ws' });

function pickShell(): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    return { file: 'powershell.exe', args: [] };
  }
  return { file: process.env.SHELL ?? '/bin/bash', args: [] };
}

wss.on('connection', (ws: WebSocket) => {
  const shell = pickShell();
  const cwd = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();

  const term = pty.spawn(shell.file, shell.args, {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd,
    env: { ...process.env, MAESTRO_SESSION: '1' } as Record<string, string>,
  });

  let promptSeen = false;
  let buffer = '';
  // Detect a shell prompt then auto-launch claude. Cheap heuristic:
  // PowerShell ends prompt with "> ", bash/zsh with "$ " or "# ".
  const promptRegex = /(?:[>$#]\s)$/;

  const onData = (data: string) => {
    const msg: ServerMessage = { type: 'output', data };
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));

    if (!promptSeen) {
      buffer += data;
      if (buffer.length > 4096) buffer = buffer.slice(-4096);
      if (promptRegex.test(buffer.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ''))) {
        promptSeen = true;
        term.write('claude\r');
      }
    }
  };

  term.onData(onData);
  term.onExit(({ exitCode }) => {
    const msg: ServerMessage = { type: 'exit', code: exitCode };
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    ws.close();
  });

  // Fallback: if no prompt detected within 5s, launch anyway.
  const fallback = setTimeout(() => {
    if (!promptSeen) {
      promptSeen = true;
      term.write('claude\r');
    }
  }, 5000);

  ws.on('message', (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === 'input') {
      term.write(msg.data);
    } else if (msg.type === 'resize') {
      try {
        term.resize(Math.max(1, msg.cols), Math.max(1, msg.rows));
      } catch {}
    }
  });

  ws.on('close', () => {
    clearTimeout(fallback);
    try {
      term.kill();
    } catch {}
  });
});

server.listen(PORT, () => {
  console.log(`[maestro] http + ws on http://127.0.0.1:${PORT}`);
});
