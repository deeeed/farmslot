#!/usr/bin/env node
import { chmodSync, existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const packageRoot = dirname(require.resolve('node-pty/package.json'));
const prebuildsDir = join(packageRoot, 'prebuilds');

if (!existsSync(prebuildsDir)) {
  process.exit(0);
}

for (const arch of readdirSync(prebuildsDir)) {
  const helper = join(prebuildsDir, arch, 'spawn-helper');
  if (existsSync(helper)) {
    chmodSync(helper, 0o755);
  }
}
