import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/client-mobile',
  base: '/m/',
  server: {
    port: 4052,
    host: true,
    allowedHosts: ['.devtunnels.ms', 'localhost', '127.0.0.1'],
    proxy: {
      '^/api/': {
        target: 'http://127.0.0.1:4050',
        changeOrigin: true,
      },
      '/maestro-ws': {
        target: 'ws://127.0.0.1:4050',
        ws: true,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: '../../dist/client-mobile',
    emptyOutDir: true,
  },
});
