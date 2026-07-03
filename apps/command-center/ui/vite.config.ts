import { readFileSync } from 'node:fs';

import { resolve } from 'path';
import { defineConfig } from 'vite';

const uiPackage = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as {
  version?: string;
};
const appVersion = uiPackage.version ?? 'dev';

const gatewayPort = Number(process.env.GATEWAY_PORT) || 7777;
const gatewayHost = process.env.GATEWAY_PROXY_HOST || process.env.GATEWAY_HOST || '127.0.0.1';
const vitePort = Number(process.env.VITE_PORT) || 5174;
const gatewayTarget = `http://${gatewayHost}:${gatewayPort}`;
const base = process.env.FARMSLOT_CC_BASE || process.env.VITE_BASE || '/';

export default defineConfig({
  base,
  root: resolve(__dirname),
  define: {
    __FARMSLOT_APP_VERSION__: JSON.stringify(appVersion),
  },
  resolve: {
    alias: {
      '@farmslot/protocol': resolve(__dirname, '../../../packages/protocol/src'),
      '@farmslot/theme': resolve(__dirname, '../../../packages/theme/src'),
    },
  },
  server: {
    port: vitePort,
    strictPort: true,
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
        target: gatewayTarget,
        ws: true,
      },
      '/api': {
        target: gatewayTarget,
      },
    },
  },
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
  },
});
