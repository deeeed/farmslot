import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { assembleLearningPackage } from '../src/learning-package/assemble.js';
import type { HandoffContext, LearningPackageInput } from '../src/learning-package/types.js';
import { deriveTaskKey } from '../src/spec/task-key.js';
import type { Manifest } from '../src/spec/types.js';

test('ticket-backed taskKey is the normalized ticket', () => {
  assert.equal(deriveTaskKey({ ticket: 'PROJ-1234' }), 'proj-1234');
  assert.equal(deriveTaskKey({ ticket: '  Proj_1234 ' }), 'proj-1234');
  // The ticket wins even when task content is present.
  assert.equal(deriveTaskKey({ ticket: 'PROJ-9', title: 'anything' }), 'proj-9');
});

test('ticketless taskKey is a deterministic content hash, insensitive to formatting noise', () => {
  const a = deriveTaskKey({
    title: 'Fix the gate',
    description: 'It  flakes',
    acceptanceCriteria: 'green',
  });
  const b = deriveTaskKey({
    title: '  fix THE gate ',
    description: 'it flakes',
    acceptanceCriteria: ' Green ',
  });
  assert.equal(a, b);
  assert.match(a, /^task-[a-f0-9]{16}$/);
  // Different work produces a different family.
  assert.notEqual(a, deriveTaskKey({ title: 'Fix the other gate', description: 'It flakes' }));
});

function scenario(learnings?: string): { ctx: HandoffContext; input: LearningPackageInput } {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'handoff-tk-'));
  const artifactsDir = path.join(workspace, 'artifacts');
  mkdirSync(artifactsDir, { recursive: true });
  writeFileSync(path.join(workspace, 'TASK.md'), '# Task\n');
  writeFileSync(path.join(artifactsDir, 'report.md'), '# Report\n');
  writeFileSync(path.join(artifactsDir, 'learnings.md'), learnings ?? '# Learnings\n');
  return {
    ctx: { stagingRoot: mkdtempSync(path.join(os.tmpdir(), 'handoff-tk-stage-')), workspace },
    input: {
      surface: 'fleet',
      runRecord: {
        packageId: '20260703T154211Z-fleet-dev-proj-123-a1b2c3d4',
        project: 'demo-farm',
        domain: '',
        run: { startedAt: '2026-07-03T15:42:11Z', flow: 'dev', outcome: 'success' },
        task: { title: 'Do the thing', sourceKind: 'text', ticket: 'PROJ-123' },
      },
      templateProvenance: [],
      taskDoc: { taskMd: path.join(workspace, 'TASK.md') },
      artifacts: { artifactsDir },
    },
  };
}

test('assemble stamps the derived taskKey into manifest.json', () => {
  const { ctx, input } = scenario();
  const result = assembleLearningPackage(input, ctx);
  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') return;
  assert.equal(result.manifest.taskKey, 'proj-123');
  const stored = JSON.parse(
    readFileSync(path.join(result.packageDir, 'manifest.json'), 'utf8'),
  ) as Manifest;
  assert.equal(stored.taskKey, 'proj-123');
});

test('a blocked assembly stamps taskKey into the quarantine manifest too', () => {
  const { ctx, input } = scenario(
    'abandon ability able about above absent absorb abstract absurd abuse access accident',
  );
  const result = assembleLearningPackage(input, ctx);
  assert.equal(result.status, 'blocked');
  if (result.status !== 'blocked') return;
  const stored = JSON.parse(
    readFileSync(path.join(result.quarantineDir, 'manifest.json'), 'utf8'),
  ) as Manifest;
  assert.equal(stored.taskKey, 'proj-123');
});

test('two attempts at the same ticketless task land in one family across machines', () => {
  const task = {
    title: 'Stabilize flaky spinner assertion',
    description: 'The spinner test fails on slow CI nodes.',
    acceptanceCriteria: 'Test passes 50/50 runs.',
  };
  // Attempt one on machine A, attempt two on machine B: same derivation inputs,
  // no coordinator - identical family key.
  assert.equal(deriveTaskKey(task), deriveTaskKey({ ...task }));
});

test('a punctuation-only ticket falls back to the content-hash family key', () => {
  const withJunkTicket = deriveTaskKey({ ticket: '!!!', title: 'Fix the gate' });
  assert.match(withJunkTicket, /^task-[a-f0-9]{16}$/);
  assert.equal(withJunkTicket, deriveTaskKey({ title: 'Fix the gate' }));
});
