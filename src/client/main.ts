import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { ClientMessage, ServerMessage } from '../shared/protocol';

const term = new Terminal({
  cursorBlink: true,
  fontFamily: 'Consolas, "Cascadia Mono", Menlo, monospace',
  fontSize: 14,
  allowProposedApi: true,
});
const fit = new FitAddon();
term.loadAddon(fit);
term.open(document.getElementById('term')!);
fit.fit();

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  // In Vite dev (port 4051) the proxy forwards /maestro-ws to the server.
  return `${proto}//${location.host}/maestro-ws`;
}

let ws: WebSocket | null = null;
let reconnectDelay = 500;

function connect() {
  ws = new WebSocket(wsUrl());

  ws.onopen = () => {
    reconnectDelay = 500;
    sendResize();
  };

  ws.onmessage = (e) => {
    const msg: ServerMessage = JSON.parse(e.data);
    if (msg.type === 'output') term.write(msg.data);
    else if (msg.type === 'exit') term.write(`\r\n[process exited: ${msg.code}]\r\n`);
  };

  ws.onclose = () => {
    term.write(`\r\n[disconnected, retrying in ${reconnectDelay}ms]\r\n`);
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 5000);
  };

  ws.onerror = () => {
    try { ws?.close(); } catch {}
  };
}

function send(msg: ClientMessage) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function sendResize() {
  send({ type: 'resize', cols: term.cols, rows: term.rows });
}

term.onData((data) => send({ type: 'input', data }));
term.onResize(() => sendResize());

window.addEventListener('resize', () => {
  fit.fit();
});

connect();
