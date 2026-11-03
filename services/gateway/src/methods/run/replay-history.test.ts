import assert from 'node:assert/strict';
import test from 'node:test';

import type { FlowType, RunDecision } from '@farmslot/protocol';

import { latestResolvedHumanGateDecision } from '../../run-engine/decision-replay.js';
import { deleteTestRunIfPresent } from '../../run-engine/test-fixtures.js';
import { createRun, getRun, updateRun } from '../../runs/store.js';

import { runReplayStep } from './replay-step.js';

for (const [flowType, stepName, kept] of [
  ['dev', 'write-task', ['open']],
  ['dev', 'dispatch', ['open', 'output']],
  ['dev', 'complete', ['open', 'output']],
  ['dev', 'finalize', ['approval', 'open', 'output', 'review']],
  ['pr-complete', 'complete', ['open', 'output']],
] satisfies Array<[FlowType, string, string[]]>) {
  test(
    `${flowType} replay from ${stepName} archives only the rows it clears`,
    { timeout: 4000 },
    async (t) => {
      const run = createRun({
        flowType,
        project: 'example-history',
        ticketOrPr: flowType === 'pr-complete' ? 'example/app#351' : 'PROJ-351',
      });
      t.after(() => deleteTestRunIfPresent(run.id));
      const rows: RunDecision[] = ['approval', 'open', 'output', 'review'].map((id) => ({
        id,
        type:
          id === 'review'
            ? 'engine_review_failed'
            : id === 'output'
              ? 'engine_output_review'
              : 'engine_human_gate',
        title: id,
        description: `Full ${id} row`,
        actions: [],
        createdAt: '2026-11-03T00:00:00.000Z',
        ...(id === 'approval' || id === 'review'
          ? {
              resolvedAt: '2026-11-03T00:01:00.000Z',
              resolvedAction: id === 'approval' ? 'approve-publish' : 'retry',
            }
          : {}),
        ...(id === 'output'
          ? {
              payload: {
                kind: 'output-review',
                reportPath: 'artifacts/report.md',
                manifestDigest: 'digest',
              },
            }
          : {}),
      }));
      const original = structuredClone(rows);
      const prior = stepName === 'finalize' ? [{ ...rows[0], id: 'archived-before-replay' }] : [];
      if (prior.length) updateRun(run.id, { decisions: prior });
      updateRun(run.id, {
        status: 'human-gating',
        taskFile: '/tmp/example-history/TASK.md',
        decisions: rows,
        steps: run.steps.map((step) => ({ ...step, status: 'done' })),
      });
      const replay = () =>
        runReplayStep({ runId: run.id, stepName }, () => {}, { startEngine: async () => {} });
      await replay();
      const after = getRun(run.id)!;
      assert.deepEqual(
        after.decisions.map(({ id }) => id),
        kept,
      );
      assert.deepEqual(after.decisionHistory ?? [], [
        ...prior,
        ...original.filter(({ id }) => !kept.includes(id)),
      ]);
      assert.equal(
        latestResolvedHumanGateDecision(after.decisions),
        stepName === 'finalize' ? after.decisions[0] : undefined,
      );
      const retained = structuredClone(after.decisionHistory ?? []);
      await replay();
      const repeated = getRun(run.id)!;
      assert.deepEqual((repeated.decisionHistory ?? []).slice(0, retained.length), retained);
      assert.deepEqual(
        [...repeated.decisions, ...(repeated.decisionHistory ?? [])].map(({ id }) => id).sort(),
        [...prior, ...original].map(({ id }) => id).sort(),
      );
    },
  );
}
