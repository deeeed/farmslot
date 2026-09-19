import assert from 'node:assert/strict';
import test from 'node:test';

import type { AcceptanceStatusLedger, TaskStepSubtaskProgress } from '@farmslot/protocol';
import { colors } from '@farmslot/theme';

import {
  acceptanceLedgerView,
  acceptanceVerdictColor,
  subtaskProgressView,
  subtaskStatusColor,
  taskStepStatusColor,
} from './task-progress-view';

function unit(overrides: Partial<TaskStepSubtaskProgress> = {}): TaskStepSubtaskProgress {
  return {
    id: 'perps-review',
    status: 'running',
    source: {
      kind: 'skill',
      ref: '.agents/skills/mms-perps-review-pr/skill.md',
      sha256: 'a',
      renderedSha256: 'b',
    },
    progress: {
      schema: { flowType: 'subtask', title: 'Review', totalSteps: 2, phases: [] },
      phases: [],
      completedSteps: 1,
      totalSteps: 2,
      currentPhase: 'Review',
      currentStep: 'Check the state derivation',
    },
    lastEventAt: '2026-09-19T10:58:00Z',
    ...overrides,
  };
}

test('a running unit shows its source basename, counts, and current step', () => {
  const view = subtaskProgressView(unit());
  assert.equal(view.title, 'skill.md');
  assert.equal(view.counts, '1/2');
  assert.equal(view.currentStep, 'Check the state derivation');
  assert.equal(view.staleNote, null);
  assert.equal(view.settled, false);
  assert.equal(view.color, colors.accent);
});

test('an inline unit has no ref to show', () => {
  const view = subtaskProgressView(
    unit({ source: { kind: 'inline', sha256: 'a', renderedSha256: 'b' } }),
  );
  assert.equal(view.title, 'inline');
});

test('a stale unit names the last child mark in visible text, not a tooltip', () => {
  const view = subtaskProgressView(unit({ status: 'stale' }));
  assert.equal(view.staleNote, 'no mark since 2026-09-19T10:58:00Z');
  assert.equal(view.color, colors.statusWarn);
  assert.equal(view.settled, false);
});

test('blocked keeps ownership, complete settles', () => {
  assert.equal(subtaskProgressView(unit({ status: 'blocked' })).settled, false);
  assert.equal(subtaskProgressView(unit({ status: 'complete' })).settled, true);
  assert.equal(subtaskStatusColor('blocked'), colors.statusFail);
  assert.equal(subtaskStatusColor('complete'), colors.statusOk);
});

test('step colours match the parent checklist rows', () => {
  assert.equal(taskStepStatusColor('done'), colors.statusOk);
  assert.equal(taskStepStatusColor('running'), colors.statusWarn);
  assert.equal(taskStepStatusColor('skipped'), colors.textMuted);
  assert.equal(taskStepStatusColor('pending'), colors.accent);
});

function ledger(): AcceptanceStatusLedger {
  return {
    schemaVersion: 1,
    criteria: [
      {
        id: 'AC-1',
        text: 'Unlocking twice does not prompt twice',
        verdict: 'proven',
        proofMode: 'visual',
        evidence: ['artifacts/recipe-run/screens/after-unlock.png'],
        recipeNodes: ['assert-single-prompt'],
        updatedAt: '2026-09-19T11:00:00.000Z',
      },
      {
        id: 'AC-2',
        text: 'A cancelled unlock leaves the vault locked',
        verdict: 'weak',
        evidence: [],
        recipeNodes: [],
        note: 'Unit test only.',
        updatedAt: '2026-09-19T11:01:00.000Z',
      },
    ],
  };
}

test('the acceptance panel view counts proven and colours blocking verdicts as failures', () => {
  const view = acceptanceLedgerView(ledger());
  assert.equal(view.counts, '1/2 proven');
  assert.equal(view.countsLabel, 'proven 1, weak 1, missing 0, untestable 0, no verdict 0');
  // A weak criterion is open work, so the compact panel starts expanded.
  assert.equal(view.hasOpenCriteria, true);
  assert.equal(view.rows[0].color, colors.statusOk);
  assert.equal(view.rows[1].color, colors.statusFail);
  // A phone shows evidence basenames, never the full task-dir path.
  assert.deepEqual(view.rows[0].evidence, ['after-unlock.png']);
  assert.deepEqual(view.rows[1].evidence, []);
});

test('an all-settled ledger starts collapsed, untestable included', () => {
  const settled = ledger();
  settled.criteria[1] = { ...settled.criteria[1], verdict: 'untestable' };
  const view = acceptanceLedgerView(settled);
  assert.equal(view.hasOpenCriteria, false);
  assert.equal(view.rows[1].color, colors.statusWarn);
});

test('an unjudged criterion is a neutral row counted against the registered total', () => {
  const view = acceptanceLedgerView({ schemaVersion: 1, criteria: [ledger().criteria[0]] }, [
    { id: 'AC-1', text: 'Proven already' },
    { id: 'AC-2', text: 'Not judged yet' },
  ]);
  assert.equal(view.counts, '1/2 proven');
  assert.match(view.countsLabel, /no verdict 1$/);
  assert.equal(view.rows[1].verdict, null);
  assert.equal(view.rows[1].color, colors.textMuted);
  assert.deepEqual(view.rows[1].evidence, []);
});

test('verdict colours cover every vocabulary entry and the unknown fallback', () => {
  assert.equal(acceptanceVerdictColor('proven'), colors.statusOk);
  assert.equal(acceptanceVerdictColor('weak'), colors.statusFail);
  assert.equal(acceptanceVerdictColor('missing'), colors.statusFail);
  assert.equal(acceptanceVerdictColor('untestable'), colors.statusWarn);
  assert.equal(acceptanceVerdictColor('something-new'), colors.accent);
  assert.equal(acceptanceVerdictColor(null), colors.textMuted);
});
