#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [artifactsArg, outputArg, platform] = process.argv.slice(2);
if (!artifactsArg || !outputArg || !['ios', 'android'].includes(platform)) {
  throw new Error(
    'Usage: build-ready-gate-ux-catalog.mjs <recipe-artifacts-dir> <output-dir> <ios|android>',
  );
}

const artifactsDir = path.resolve(artifactsArg);
const outputDir = path.resolve(outputArg);
const platformDir = path.join(outputDir, platform);
mkdirSync(platformDir, { recursive: true });

copyFileSync(
  path.join(artifactsDir, platform, '10_run_detail.png'),
  path.join(platformDir, '10_run_detail.png'),
);
copyFileSync(
  path.join(artifactsDir, platform, '11_ready_gate_full.png'),
  path.join(platformDir, '11_ready_gate_full.png'),
);

const manifestPath = path.join(outputDir, 'manifest.json');
const manifest = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, 'utf8'))
  : { capturedAt: '', variant: process.env.APP_VARIANT ?? 'development', routes: [] };
manifest.capturedAt = new Date().toISOString();
manifest.routes = manifest.routes.filter(
  (route) => !['10_run_detail', '11_ready_gate_full'].includes(route.id),
);
manifest.routes.push(
  {
    id: '10_run_detail',
    path: 'run/:runId',
    title: 'Ready run package',
    fullHeight: true,
  },
  {
    id: '11_ready_gate_full',
    path: 'decision/:decisionId?workspace=ready',
    title: 'Ready gate — full height',
    fullHeight: true,
  },
);
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const generate = spawnSync(
  process.execPath,
  [path.join(import.meta.dirname, 'generate-ux-catalog.mjs'), outputDir],
  { stdio: 'inherit' },
);
if (generate.status !== 0) process.exit(generate.status ?? 1);
