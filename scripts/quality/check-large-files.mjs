#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const DEFAULT_THRESHOLD = 1000;
const DEFAULT_LIMIT = 40;
const INCLUDED_EXTENSIONS = new Set([
  '.cjs',
  '.css',
  '.js',
  '.json',
  '.md',
  '.mjs',
  '.ts',
  '.tsx',
  '.yaml',
  '.yml',
]);
const IGNORED_PATH_PARTS = new Set([
  '.git',
  '.omc',
  '.omx',
  '.yarn',
  'build',
  'coverage',
  'dist',
  'node_modules',
]);
const IGNORED_SUFFIXES = ['.generated.md', '.lock'];

function numberArg(name, fallback) {
  const flagIndex = process.argv.indexOf(`--${name}`);
  const raw =
    flagIndex >= 0 ? process.argv[flagIndex + 1] : process.env[`LARGE_FILE_${name.toUpperCase()}`];
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function extensionOf(file) {
  const slash = file.lastIndexOf('/');
  const dot = file.lastIndexOf('.');
  return dot > slash ? file.slice(dot) : '';
}

function shouldCheck(file) {
  if (!INCLUDED_EXTENSIONS.has(extensionOf(file))) return false;
  if (IGNORED_SUFFIXES.some((suffix) => file.endsWith(suffix))) return false;
  return !file.split('/').some((part) => IGNORED_PATH_PARTS.has(part));
}

function trackedFiles() {
  const result = spawnSync('git', ['ls-files'], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  return result.stdout.split('\n').filter(Boolean);
}

function lineCount(file) {
  const contents = readFileSync(file, 'utf8');
  if (contents.length === 0) return 0;
  return contents.split('\n').length - (contents.endsWith('\n') ? 1 : 0);
}

const threshold = numberArg('threshold', DEFAULT_THRESHOLD);
const limit = numberArg('limit', DEFAULT_LIMIT);
const largeFiles = trackedFiles()
  .filter((file) => existsSync(file))
  .filter(shouldCheck)
  .map((file) => ({ file, lines: lineCount(file) }))
  .filter(({ lines }) => lines > threshold)
  .sort((a, b) => b.lines - a.lines || a.file.localeCompare(b.file));

if (largeFiles.length === 0) {
  console.log(`[large-files] No tracked source/docs files exceed ${threshold} LOC.`);
  process.exit(0);
}

console.warn(
  `[large-files] ${largeFiles.length} tracked source/docs file(s) exceed ${threshold} LOC. ` +
    'This is a refactor warning only; split touched files before adding more code.',
);
for (const { file, lines } of largeFiles.slice(0, limit)) {
  console.warn(`[large-files] ${String(lines).padStart(5)} ${file}`);
}
if (largeFiles.length > limit) {
  console.warn(
    `[large-files] ...and ${largeFiles.length - limit} more. Use --limit to print more.`,
  );
}
