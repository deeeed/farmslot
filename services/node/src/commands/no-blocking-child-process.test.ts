import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

/**
 * Files allowed a blocking child process, each with why. tmux.ts resolves the
 * tmux binary and version once while the module loads, before the node takes
 * requests.
 */
const ALLOWED = new Set(['commands/tmux.ts']);

test('no node request path runs a blocking child process', () => {
  // One blocking call freezes every request the node is serving: an iOS
  // thumbnail's execSync on a simulator that was not booted held the event loop
  // for 10 s per poll, and support-bundle commands timed out behind it.
  const src = path.resolve(import.meta.dirname, '..');
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) return entry === 'node_modules' ? [] : walk(full);
      return full.endsWith('.ts') && !full.endsWith('.test.ts') ? [full] : [];
    });
  const offenders = walk(src)
    .map((file) => path.relative(src, file).split(path.sep).join('/'))
    .filter((file) => !ALLOWED.has(file))
    .filter((file) =>
      /\b(?:execSync|execFileSync|spawnSync)\s*\(/.test(readFileSync(path.join(src, file), 'utf8')),
    );
  assert.deepEqual(offenders, []);
});
