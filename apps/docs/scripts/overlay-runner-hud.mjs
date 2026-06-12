#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, renameSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const docsRoot = resolve(new URL('..', import.meta.url).pathname);
const items = [
  {
    id: 'parallel-watch',
    video: 'static/videos/demos/command-center-parallel-watch.mp4',
    poster: 'static/img/demos/command-center-parallel-watch.png',
    at: '00:00:06',
    node: 'record-proof-window',
    detail: 'watch + steer live terminal runs',
  },
  {
    id: 'gateway-intelligence',
    video: 'static/videos/demos/command-center-gateway-intelligence.mp4',
    poster: 'static/img/demos/command-center-gateway-intelligence.png',
    at: '00:00:16',
    node: 'ask-status',
    detail: 'gateway question + answer proof',
  },
];
const onlyArg = process.argv.find((arg) => arg.startsWith('--only='));
const only = onlyArg ? onlyArg.slice('--only='.length) : '';
const selectedItems = only ? items.filter((item) => item.id === only) : items;
if (only && selectedItems.length === 0) throw new Error(`Unknown HUD overlay id: ${only}`);

for (const item of selectedItems) {
  const video = resolve(docsRoot, item.video);
  const poster = resolve(docsRoot, item.poster);
  if (!existsSync(video)) throw new Error(`Missing video: ${video}`);
  const overlay = `${video}.hud.png`;
  const tmp = `${video}.hud.mp4`;
  makeOverlay(overlay, item);
  run('ffmpeg', [
    '-y',
    '-i',
    video,
    '-i',
    overlay,
    '-filter_complex',
    'overlay=18:18',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'copy',
    tmp,
  ]);
  if (!existsSync(tmp) || statSync(tmp).size === 0) throw new Error(`HUD output missing: ${tmp}`);
  renameSync(tmp, video);
  run('ffmpeg', ['-y', '-ss', item.at, '-i', video, '-frames:v', '1', poster]);
  console.log(`HUD overlay applied: ${item.video}`);
}

function makeOverlay(path, item) {
  run('magick', [
    '-size',
    '640x126',
    'xc:none',
    '-fill',
    'rgba(8,12,24,0.86)',
    '-stroke',
    '#84ffc4',
    '-strokewidth',
    '2',
    '-draw',
    'roundrectangle 0,0 639,125 18,18',
    '-font',
    '/System/Library/Fonts/SFNS.ttf',
    '-fill',
    '#84ffc4',
    '-pointsize',
    '18',
    '-annotate',
    '+22+32',
    'RECIPE RUNNER HUD',
    '-font',
    '/System/Library/Fonts/SFNS.ttf',
    '-fill',
    '#ffffff',
    '-pointsize',
    '24',
    '-annotate',
    '+22+70',
    item.node,
    '-font',
    '/System/Library/Fonts/SFNS.ttf',
    '-fill',
    '#dbe7ff',
    '-pointsize',
    '18',
    '-annotate',
    '+22+108',
    item.detail,
    path,
  ]);
}

function run(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', cwd: docsRoot });
  if (result.status !== 0) throw new Error(`${cmd} failed:\n${result.stderr || result.stdout}`);
}
