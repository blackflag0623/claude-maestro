import { defineConfig } from 'vite';
import { sharedDevServer } from './vite.shared';

export default defineConfig({
  root: 'src/client',
  server: {
    port: 4051,
    ...sharedDevServer,
  },
  // Force-include xterm + addons in pre-bundling so Vite doesn't lazy-discover
  // them and then evict the cache mid-session ("504 Outdated Optimize Dep").
  // Lazy discovery is the trigger; explicit `include` makes the bundle stable.
  optimizeDeps: {
    include: [
      '@xterm/xterm',
      '@xterm/addon-fit',
      '@xterm/addon-webgl',
      '@xterm/addon-web-links',
      '@xterm/addon-search',
      '@xterm/addon-serialize',
      '@xterm/addon-unicode11',
      '@xterm/addon-image',
    ],
  },
  build: {
    outDir: '../../dist/client',
    emptyOutDir: true,
  },
});
