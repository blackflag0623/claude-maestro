import { defineConfig } from 'vite';
import { sharedDevServer } from './vite.shared';

export default defineConfig({
  root: 'src/client',
  server: {
    port: 4051,
    ...sharedDevServer,
  },
  build: {
    outDir: '../../dist/client',
    emptyOutDir: true,
  },
});
