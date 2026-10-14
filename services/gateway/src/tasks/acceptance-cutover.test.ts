import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import '../runtime/mock-pty.test-support.js';

import type { SlotLocality } from '../core/slot-io.js';

// Install the PTY/tmux refusal before loading production transport dependencies.
const { readAcceptanceStatusForDisplay } = await import('./acceptance-status.js');

const LOCAL: SlotLocality = { host: 'localhost', machine: 'local', sshTarget: '' };
const CRITERIA = [{ id: 'AC-1', text: 'The registered command exits successfully' }];
const ENGINE_LEDGER = {
  schemaVersion: 2,
  recipeRunId: 'engine-execution',
  recording: { status: 'not-required', segments: [] },
  criteria: [
    {
      ...CRITERIA[0],
      kind: 'acceptance',
      verdict: 'proven',
      proofMode: 'state',
      evidence: ['artifacts/command.log'],
      recipeNodes: ['assert-command-exit'],
      assertionIndices: [1],
      moments: [],
    },
  ],
};
const MANIFEST = {
  standalone: [{ file: 'artifacts/unrelated.mp4', covers: ['AC-1'] }],
};

function taskFixture(t: test.TestContext, manifest: string, ledger?: string): string {
  const taskDir = mkdtempSync(path.join(os.tmpdir(), 'acceptance-display-cutover-'));
  t.after(() => rmSync(taskDir, { recursive: true, force: true }));
  mkdirSync(path.join(taskDir, 'inputs'), { recursive: true });
  mkdirSync(path.join(taskDir, 'artifacts'), { recursive: true });
  writeFileSync(
    path.join(taskDir, 'inputs', 'handoff.json'),
    JSON.stringify({ task: { acceptanceCriteria: CRITERIA.map((row) => row.text) } }),
  );
  writeFileSync(path.join(taskDir, 'artifacts', 'evidence-manifest.json'), manifest);
  if (ledger !== undefined)
    writeFileSync(path.join(taskDir, 'artifacts', 'acceptance-status.json'), ledger);
  return taskDir;
}

test('a manifest covers entry cannot become an acceptance display fallback', async (t) => {
  const taskDir = taskFixture(t, JSON.stringify(MANIFEST));
  const manifestPath = path.join(taskDir, 'artifacts', 'evidence-manifest.json');
  const before = readFileSync(manifestPath);
  const result = await readAcceptanceStatusForDisplay(LOCAL, taskDir);
  assert.deepEqual(result.criteria, CRITERIA);
  assert.equal(result.ledger, null);
  assert.equal(result.source, undefined);
  assert.equal(result.evidenceLinks, undefined);
  assert.equal(result.evidenceLinksError, undefined);
  assert.deepEqual(readFileSync(manifestPath), before, 'general media transport stays intact');
});

test('an unrelated malformed media manifest cannot become an acceptance error', async (t) => {
  const taskDir = taskFixture(t, '{ invalid media inventory');
  const result = await readAcceptanceStatusForDisplay(LOCAL, taskDir);
  assert.deepEqual(result.criteria, CRITERIA);
  assert.equal(result.ledger, null);
  assert.equal(result.evidenceLinksError, undefined);
  assert.equal(result.error, undefined);
});

test('a valid engine projection remains the whole display input', async (t) => {
  const taskDir = taskFixture(t, JSON.stringify(MANIFEST), JSON.stringify(ENGINE_LEDGER));
  const result = await readAcceptanceStatusForDisplay(LOCAL, taskDir);
  assert.deepEqual(result.criteria, CRITERIA);
  assert.deepEqual(result.ledger, ENGINE_LEDGER);
  assert.equal(result.source, 'ledger');
  assert.equal(result.evidenceLinks, undefined);
  assert.equal(result.error, undefined);
});

test('a malformed ledger reports its own error without using manifest covers', async (t) => {
  const taskDir = taskFixture(t, JSON.stringify(MANIFEST), '{ invalid ledger');
  const result = await readAcceptanceStatusForDisplay(LOCAL, taskDir);
  assert.equal(result.ledger, null);
  assert.match(result.error ?? '', /invalid .*acceptance-status\.json/);
  assert.equal(result.evidenceLinks, undefined);
});
