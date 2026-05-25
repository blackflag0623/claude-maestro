// Vite dev-server config shared between the desktop and mobile builds.
//
// Both clients proxy `/api/*` and the `/maestro-ws` WebSocket through to the
// maestro backend on port 4050. Keep this in one place so a backend port
// change or a new endpoint prefix doesn't have to be applied twice.

import type { ServerOptions } from 'vite';

const BACKEND_HTTP = 'http://127.0.0.1:4050';
const BACKEND_WS = 'ws://127.0.0.1:4050';

export const sharedDevServer: Omit<ServerOptions, 'port'> = {
  host: true,
  allowedHosts: ['.devtunnels.ms', 'localhost', '127.0.0.1'],
  proxy: {
    '^/api/': {
      target: BACKEND_HTTP,
      changeOrigin: true,
    },
    '/maestro-ws': {
      target: BACKEND_WS,
      ws: true,
      changeOrigin: true,
    },
  },
};
