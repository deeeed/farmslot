#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [artifactsArg, outputArg, platform] = process.argv.slice(2);
if (!artifactsArg || !outputArg || !['ios', 'android'].includes(platform)) {
  throw new Error(
    'Usage: build-native-ux-catalog.mjs <recipe-artifacts-dir> <output-dir> <ios|android>',
  );
}

const routes = [
  { id: '01_review', path: 'runs', title: 'Review queue', fullHeight: true },
  { id: '02_terminals', path: 'workers', title: 'Terminals', fullHeight: true },
  { id: '03_advanced', path: 'advanced', title: 'Advanced', fullHeight: true },
  { id: '04_settings', path: 'settings', title: 'Settings', fullHeight: true },
  { id: '05_raw_fleet', path: 'fleet', title: 'Fleet', fullHeight: true },
  { id: '06_raw_prs', path: 'prs', title: 'Pull requests', fullHeight: true },
  { id: '07_raw_inbox', path: 'inbox', title: 'Decision inbox', fullHeight: true },
];

const artifactsDir = path.resolve(artifactsArg);
const outputDir = path.resolve(outputArg);
const platformDir = path.join(outputDir, platform);
mkdirSync(platformDir, { recursive: true });

for (const route of routes) {
  copyFileSync(
    path.join(artifactsDir, platform, `${route.id}.png`),
    path.join(platformDir, `${route.id}.png`),
  );
}

const manifestPath = path.join(outputDir, 'manifest.json');
const manifest = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, 'utf8'))
  : { capturedAt: '', variant: process.env.APP_VARIANT ?? 'development', routes: [] };
const routeIds = new Set(routes.map((route) => route.id));
manifest.capturedAt = new Date().toISOString();
manifest.routes = [...routes, ...manifest.routes.filter((route) => !routeIds.has(route.id))];
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const result = spawnSync(
  process.execPath,
  [path.join(import.meta.dirname, 'generate-ux-catalog.mjs'), outputDir],
  { stdio: 'inherit' },
);
if (result.status !== 0) process.exit(result.status ?? 1);
