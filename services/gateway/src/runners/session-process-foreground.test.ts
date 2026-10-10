import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const root = mkdtempSync(path.join(tmpdir(), 'runner-foreground-'));
const bin = path.join(root, 'bin');
mkdirSync(bin);
writeFileSync(path.join(bin, 'tmux'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
const originalPath = process.env.PATH;
process.env.PATH = bin + path.delimiter + originalPath;
after(() => {
  process.env.PATH = originalPath;
  rmSync(root, { recursive: true, force: true });
});
const { buildFindRunnerDescendantPidCommand } = await import('./session-process.js');

function probe(table: string, foregroundOnly: boolean): string {
  writeFileSync(
    path.join(bin, 'ps'),
    '#!/usr/bin/env node\nif (!process.argv.includes("pid=,ppid=,stat=,command=")) process.exit(2);\nprocess.stdout.write(' +
      JSON.stringify(table) +
      ');\n',
    { mode: 0o755 },
  );
  return execFileSync(
    'bash',
    ['-c', buildFindRunnerDescendantPidCommand('10', 'claude', foregroundOnly)],
    { encoding: 'utf8' },
  ).trim();
}

test('foreground input probe accepts the live runner in its foreground process group', () => {
  assert.equal(probe('10 1 Ss /bin/zsh\n20 10 S+ /usr/bin/claude\n', true), '20');
});

test('a live background runner cannot authorize terminal input', () => {
  const table = '10 1 Ss+ /bin/zsh\n20 10 S /usr/bin/claude\n';
  assert.equal(probe(table, false), '20');
  assert.throws(
    () => probe(table, true),
    (error: unknown) => (error as { status?: number }).status === 1,
  );
});

test('a foreground shell whose argv mentions the runner cannot authorize input', () => {
  assert.throws(
    () => probe('10 1 Ss+ /bin/zsh -c claude\n', true),
    (error: unknown) => (error as { status?: number }).status === 1,
  );
});
