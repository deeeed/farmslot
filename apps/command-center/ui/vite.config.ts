import { resolve } from 'path';
import { defineConfig } from 'vite';

const gatewayPort = Number(process.env.GATEWAY_PORT) || 7777;
const vitePort = Number(process.env.VITE_PORT) || 5174;

export default defineConfig({
  root: resolve(__dirname),
  resolve: {
    alias: {
      '@farmslot/protocol': resolve(__dirname, '../../../packages/protocol/src'),
      '@farmslot/theme': resolve(__dirname, '../../../packages/theme/src'),
    },
  },
  server: {
    port: vitePort,
    // Background agents edit UI source in bursts (5–20 files in seconds). Without
    // coalescing, Vite fires a full page reload per save — 76 `@customElement`
    // re-registrations + Monaco re-init stack up and trigger Chrome's
    // "Page Unresponsive" watchdog. `awaitWriteFinish` waits for writes to
    // settle, then reloads once. `hmr.overlay: false` keeps the page interactive
    // so the user can still kill a runaway tab.
    watch: {
      awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 50 },
    },
    hmr: {
      overlay: false,
    },
    proxy: {
      '/ws': {
        target: `http://localhost:${gatewayPort}`,
        ws: true,
      },
      '/api': {
        target: `http://localhost:${gatewayPort}`,
      },
    },
  },
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
  },
});
