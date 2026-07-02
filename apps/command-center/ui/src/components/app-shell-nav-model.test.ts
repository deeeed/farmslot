import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Run, RunStep } from '@farmslot/protocol';

import {
  activeSidebarRuns,
  clampSidebarWidth,
  isAlphaFeaturesEnabled,
  parseStoredSidebarWidth,
  sidebarPreviewSteps,
  sidebarRunRoute,
  sidebarRunSummary,
} from './app-shell-nav-model.js';

function run(id: string, status: Run['status'], overrides: Partial<Run> = {}): Run {
  return {
    id,
    familyId: id,
    lane: 'production',
    flowType: 'fix-bug',
    status,
    project: 'demo',
    ticketOrPr: 'DEMO-1',
    slotId: null,
    branch: null,
    taskFile: null,
    steps: [],
    decisions: [],
    metrics: {},
    createdAt: '2026-06-01T00:00:00Z',
    updatedAt: '2026-06-01T00:00:00Z',
    ...overrides,
  } as Run;
}

function step(name: string, status: RunStep['status'], detail?: string): RunStep {
  return { name, status, detail } as RunStep;
}

test('sidebar width parser clamps stored values', () => {
  assert.equal(parseStoredSidebarWidth(null), 260);
  assert.equal(parseStoredSidebarWidth('20'), 180);
  assert.equal(parseStoredSidebarWidth('999'), 420);
  assert.equal(clampSidebarWidth(277.6), 278);
});

test('active sidebar runs include live attention states and cap list', () => {
  assert.deepEqual(
    activeSidebarRuns([
      run('a', 'monitoring'),
      run('b', 'failed'),
      run('c', 'done'),
      run('d', 'cancelled'),
    ]).map((r) => r.id),
    ['a', 'b'],
  );
  assert.deepEqual(
    activeSidebarRuns([run('a', 'monitoring'), run('b', 'preparing')], 1).map((r) => r.id),
    ['a'],
  );
});

test('sidebar run route opens assigned slot and falls back to run detail', () => {
  assert.equal(sidebarRunRoute(run('run-1', 'monitoring', { slotId: 'mac-1' })), '#slot/mac-1');
  assert.equal(sidebarRunRoute(run('run/2', 'slot-finding')), '#run/run/2');
  assert.equal(
    sidebarRunRoute(run('failed-run', 'failed', { slotId: 'mac-1' })),
    '#run/failed-run',
  );
});

test('sidebar summary prefers run summary then active step detail', () => {
  assert.equal(
    sidebarRunSummary(run('a', 'monitoring', { summary: 'Fix flaky login' })),
    'Fix flaky login',
  );
  assert.equal(
    sidebarRunSummary(
      run('b', 'monitoring', {
        steps: [step('prepare', 'done'), step('verify', 'running', 'CDP pass')],
      }),
    ),
    'CDP pass',
  );
  assert.equal(sidebarRunSummary(run('c', 'monitoring', { branch: 'fix/demo' })), 'fix/demo');
});

test('alpha features flag only enables on the exact opt-in value', () => {
  assert.equal(isAlphaFeaturesEnabled(null), false);
  assert.equal(isAlphaFeaturesEnabled('false'), false);
  assert.equal(isAlphaFeaturesEnabled('1'), false);
  assert.equal(isAlphaFeaturesEnabled('true'), true);
});

test('sidebar preview steps centers around the running step', () => {
  const steps = [
    step('a', 'done'),
    step('b', 'done'),
    step('c', 'running'),
    step('d', 'pending'),
    step('e', 'pending'),
    step('f', 'pending'),
  ];
  assert.deepEqual(
    sidebarPreviewSteps(steps, 3).map((s) => s.name),
    ['b', 'c', 'd'],
  );
});
