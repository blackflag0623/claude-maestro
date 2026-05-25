import { defineConfig } from 'vite';
import { sharedDevServer } from './vite.shared';

export default defineConfig({
  root: 'src/client-mobile',
  base: '/m/',
  server: {
    port: 4052,
    ...sharedDevServer,
  },
  build: {
    outDir: '../../dist/client-mobile',
    emptyOutDir: true,
  },
});
