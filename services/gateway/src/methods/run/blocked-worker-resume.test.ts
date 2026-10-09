import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { replaceSignalIfUnchangedCommand } from '../../run-engine/run-monitor.js';

const runningAgain = {
  status: 'running',
  attemptId: 'a1',
  step: 'Publish evidence',
  timestamp: '2026-10-09T13:10:00Z',
} as const;

test('the attempt rotation replaces SIGNAL.json only while it holds the bytes read', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'signal-rotate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "it's SIGNAL.json");
  const observed = `${JSON.stringify(runningAgain, null, 2)}\n`;
  const next = `${JSON.stringify({ ...runningAgain, attemptId: 'a2', note: "100% '$x'" }, null, 2)}\n`;
  const run = (cmd: string) => {
    try {
      execFileSync('sh', ['-c', cmd]);
      return true;
    } catch {
      return false;
    }
  };

  writeFileSync(file, observed);
  assert.equal(run(replaceSignalIfUnchangedCommand(file, observed, next)), true);
  assert.equal(readFileSync(file, 'utf8'), next);

  // The worker marked a step in between: its write wins.
  const marked = `${JSON.stringify({ ...runningAgain, step: 'Later' }, null, 2)}\n`;
  writeFileSync(file, marked);
  assert.equal(run(replaceSignalIfUnchangedCommand(file, observed, next)), false);
  assert.equal(readFileSync(file, 'utf8'), marked);
});
