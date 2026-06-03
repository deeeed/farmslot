import assert from 'node:assert/strict';
import test from 'node:test';

import type { CollisionPayload, Run, RunStep } from '@farmslot/protocol';

import {
  collisionLastStepLabel,
  resolveCollisionDirOwners,
} from './run-detail-collision-renderers.js';

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-1',
    familyId: 'family-1',
    lane: 'production',
    flowType: 'fix-bug',
    status: 'done',
    project: 'app-a',
    ticketOrPr: 'BUG-123',
    slotId: null,
    branch: null,
    taskFile: '/tasks/bug-123/TASK.md',
    steps: [],
    decisions: [],
    metrics: { nudgeCount: 0, runner: 'codex', model: 'gpt-5' },
    createdAt: '2026-05-14T00:00:00.000Z',
    updatedAt: '2026-05-14T00:00:00.000Z',
    ...overrides,
  };
}

function step(name: string, status: RunStep['status']): RunStep {
  return { name, status };
}

function collisionPayload(overrides: Partial<CollisionPayload> = {}): CollisionPayload {
  return {
    kind: 'collision',
    ticketSlug: 'bug-123',
    existingDirs: ['bug-123'],
    priorRunIds: [],
    ...overrides,
  };
}

test('resolveCollisionDirOwners honors gateway supplied dir owners', () => {
  const owner = run({ id: 'owned-run' });
  const result = resolveCollisionDirOwners(
    collisionPayload({ dirOwners: { 'bug-123': 'owned-run' } }),
    [owner],
    'app-a',
  );

  assert.equal(result.get('bug-123'), owner);
});

test('resolveCollisionDirOwners falls back to newest project-local task dir owner', () => {
  const older = run({ id: 'older', createdAt: '2026-05-14T00:00:00.000Z' });
  const newest = run({ id: 'newest', createdAt: '2026-05-14T01:00:00.000Z' });
  const foreignProject = run({
    id: 'foreign',
    project: 'app-b',
    createdAt: '2026-05-14T02:00:00.000Z',
  });

  const result = resolveCollisionDirOwners(
    collisionPayload(),
    [older, foreignProject, newest],
    'app-a',
  );

  assert.equal(result.get('bug-123'), newest);
});

test('collisionLastStepLabel surfaces failed, running, done, and created states', () => {
  assert.equal(collisionLastStepLabel(run({ steps: [step('prepare', 'done')] })), 'last: prepare');
  assert.equal(
    collisionLastStepLabel(run({ steps: [step('prepare', 'done'), step('test', 'running')] })),
    'running test',
  );
  assert.equal(
    collisionLastStepLabel(run({ steps: [step('prepare', 'done'), step('test', 'failed')] })),
    'failed at test',
  );
  assert.equal(collisionLastStepLabel(run({ steps: [] })), 'not started');
});
