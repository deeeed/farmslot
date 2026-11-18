import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import { html, nothing } from 'lit';

import {
  groupRunsByFamily,
  type Run,
  type RunFamilyGroup,
  type RunListRow,
  type TaskProgressResult,
  type TaskProgressStructured,
} from '@farmslot/protocol';
import type { ResourceQueryState } from '@farmslot/protocol/client-cache';
import { runChecklistProgressTarget } from '@farmslot/review-dispatch';

import { installFakeGateway } from '../../testing/fake-gateway.js';
import { litText } from '../../testing/lit-text.js';

mock.module('../diff-viewer/diff-review.js', { namedExports: {} });
mock.module('../diff-viewer/code-viewer.js', { namedExports: {} });
mock.module('../terminal/terminal-view.js', { namedExports: {} });

function run(id: string, summary: string, day: number): Run {
  return {
    id,
    familyId: 'family',
    parentRunId: id === 'family' ? null : 'family',
    lane: 'production',
    flowType: 'fix-bug',
    status: 'done',
    project: 'farm',
    ticketOrPr: id,
    slotId: null,
    branch: null,
    taskFile: null,
    steps: [],
    decisions: [],
    metrics: { nudgeCount: 0, runner: null, model: null },
    summary,
    createdAt: `2026-11-0${day}T00:00:00Z`,
    updatedAt: `2026-11-0${day}T00:00:00Z`,
  };
}

test('grouped rows retain an intermediate summary absent from the family heading', async (t) => {
  installFakeGateway(t);
  const { RunList } = await import('./run-list.js');
  for (const middleSummary of ['Distinct intermediate correction', 'Original']) {
    const runs = [
      run('family', 'Original issue', 1),
      run('middle', middleSummary, 2),
      run('latest', 'Latest follow-up', 3),
    ];
    const group = groupRunsByFamily(runs)[0];
    assert(group);
    interface View {
      renderFamilyGroup(group: RunFamilyGroup, checkboxes: boolean): { values: readonly unknown[] };
    }
    const view = Object.create(RunList.prototype) as View;
    Object.assign(view, {
      requestUpdate() {},
      prs: [],
      manageMode: false,
      renderFamilyReadinessBadges: () => nothing,
      renderCard: (row: RunListRow, _checkboxes: boolean, showSummary = true) =>
        html`${showSummary ? row.summary : nothing}`,
    });
    const family = view.renderFamilyGroup(group, false);
    const repeat = family.values.find(
      (value) => value && typeof value === 'object' && '_$litDirective$' in value,
    );
    assert(
      repeat && typeof repeat === 'object' && 'values' in repeat && Array.isArray(repeat.values),
    );
    const rowTemplate = repeat.values[2];
    assert(typeof rowTemplate === 'function');
    const rows = group.runs.map((row, index) => rowTemplate(row, index));
    assert.equal(litText(rows[group.runs.findIndex((row) => row.id === 'middle')]), middleSummary);
    const text = litText([family, rows]);
    for (const row of runs) assert(text.includes(row.summary ?? ''), row.id);
    assert.equal(text.split('Original issue').length - 1, 1, 'Do not duplicate the heading');
    assert.equal(text.split('Latest follow-up').length - 1, 1, 'Do not duplicate the heading');
  }
});

test('cached checklist completion leaves the run clock alone through refresh and replay', async (t) => {
  installFakeGateway(t);
  t.mock.method(Date, 'now', () => Date.parse('2026-11-05T12:00:00.000Z'));
  const { RunList } = await import('./run-list.js');
  const row: Run = {
    ...run('active', 'Worker just finished', 5),
    status: 'monitoring',
    slotId: 'test-slot',
    steps: [
      { name: 'dispatch', status: 'done', completedAt: '2026-11-05T11:00:00.000Z' },
      { name: 'monitor', status: 'running', startedAt: '2026-11-05T11:00:00.000Z' },
    ],
  };
  const target = runChecklistProgressTarget(row);
  assert(target);
  const structured: TaskProgressStructured = {
    schema: { flowType: 'fix-bug', title: 'Task', totalSteps: 1, phases: [] },
    phases: [],
    completedSteps: 1,
    totalSteps: 1,
    currentPhase: null,
    currentStep: null,
    timing: {
      schemaVersion: 1,
      events: [],
      startedAt: '2026-11-05T11:00:00.000Z',
      finishedAt: '2026-11-05T11:55:00.000Z',
    },
  };
  const data: TaskProgressResult = { slotId: target.params.slotId, markdown: '', structured };
  const state: ResourceQueryState<TaskProgressResult> = { status: 'ready', data };
  const view = Object.create(RunList.prototype) as {
    renderCard(run: RunListRow, checkboxes: boolean): unknown;
  };
  Object.assign(view, {
    requestUpdate() {},
    manageMode: false,
    progressQueries: new Map([[target.key, { state }]]),
    taskProgressByRun: new Map([[target.key, structured]]),
    taskProgressErrorsByRun: new Map(),
  });
  for (const status of ['ready', 'stale'] as const) {
    state.status = status;
    const text = litText(view.renderCard(row, false));
    assert.match(text, /Stale · no progress for 1h 0m/);
    assert.doesNotMatch(text, /Worker finished; monitor/);
  }

  const replay: Run = {
    ...row,
    statusChangedAt: '2026-11-05T11:59:30.000Z',
    steps: [
      {
        name: 'dispatch',
        status: 'done',
        startedAt: '2026-11-05T11:59:00.000Z',
        completedAt: '2026-11-05T11:59:30.000Z',
      },
      { name: 'monitor', status: 'running', startedAt: '2026-11-05T11:59:30.000Z' },
    ],
  };
  const replayTarget = runChecklistProgressTarget(replay);
  assert(replayTarget && replayTarget.key !== target.key);
  assert.deepEqual(
    replayTarget.params,
    target.params,
    'same run and slot share the retained query',
  );
  Object.assign(view, {
    progressQueries: new Map([[replayTarget.key, { state }]]),
    taskProgressByRun: new Map([[replayTarget.key, structured]]),
  });
  assert.doesNotMatch(litText(view.renderCard(replay, false)), /Worker finished; monitor/);
});
