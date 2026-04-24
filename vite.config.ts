import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/client',
  server: {
    port: 4051,
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
    outDir: '../../dist/client',
    emptyOutDir: true,
  },
});
