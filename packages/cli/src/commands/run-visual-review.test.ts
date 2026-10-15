import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import { Command } from 'commander';

import { Methods } from '@farmslot/protocol';

const calls: Array<{ method: string; params: unknown }> = [];
const output: unknown[] = [];
let errors: string[] = [];
const run = {
  id: 'run',
  status: 'cancelled',
  decisions: [
    {
      id: 'retained-output',
      resolvedAt: '2026-10-14T00:00:00Z',
      payload: { kind: 'output-review', manifestDigest: 'captured' },
    },
  ],
};
mock.module('../context.js', {
  namedExports: {
    resolveContext: () => ({
      output: {},
      client: {
        call: async (method: string, params: unknown) => {
          calls.push({ method, params });
          if (method === 'run.get') return { run };
          if (method === Methods.RUN_RECIPE_RUNS_FOR_RUN)
            return {
              recipeRuns: [{ id: 'artifact-group', recipeRunId: 'execution' }],
              recordedEvidence: {
                errors,
                visualReviewContext: {
                  snapshotIdentity: 'review-fence',
                  decisionId: 'retained-output',
                },
              },
            };
          assert.equal(method, Methods.RUN_REVIEW_VISUAL_CLAIM);
          return { receipt: { id: 'review' } };
        },
      },
    }),
  },
});
mock.module('../envelope.js', {
  namedExports: {
    createEmitter: () => ({
      machine: true,
      ok: (value: unknown) => output.push(value),
      fail: (error: Error) => output.push(error.message),
    }),
  },
});
const { registerRunCommand } = await import('./run.js');

async function review(action: string, kind?: string) {
  calls.length = 0;
  output.length = 0;
  const program = new Command('farmslot');
  registerRunCommand(program);
  await program.parseAsync(
    [
      'run',
      'gate',
      'run',
      '--action',
      action,
      '--claim',
      'AC-1',
      '--recipe-run',
      'execution',
      '--reason',
      'The recording matches.',
      ...(kind ? ['--judgment-kind', kind] : []),
    ],
    { from: 'user' },
  );
}

test('CLI selects captured execution directly and uses the same execution for review', async () => {
  for (const action of ['confirm-visual', 'reject-visual']) {
    errors = [];
    await review(action);
    assert.deepEqual(calls[1], {
      method: Methods.RUN_RECIPE_RUNS_FOR_RUN,
      params: {
        runId: 'run',
        recordedRecipeRunId: 'execution',
        includeRecordedEvidence: true,
        decisionId: 'retained-output',
        evidenceSnapshotHash: 'captured',
      },
    });
    assert.deepEqual(calls[2], {
      method: Methods.RUN_REVIEW_VISUAL_CLAIM,
      params: {
        runId: 'run',
        decisionId: 'retained-output',
        snapshotIdentity: 'review-fence',
        claimId: 'AC-1',
        recipeRunId: 'execution',
        reason: 'The recording matches.',
        verdict: action === 'confirm-visual' ? 'confirmed' : 'rejected',
      },
    });
    assert.deepEqual(output, [{ receipt: { id: 'review' } }]);
  }
});

test('delegated review uses the existing command and snapshot, without an actor field', async () => {
  errors = [];
  await review('confirm-visual', 'lead-agent-reviewed');
  const request = calls.find(({ method }) => method === Methods.RUN_REVIEW_VISUAL_CLAIM)!;
  assert.equal((request.params as { kind: string }).kind, 'lead-agent-reviewed');
  assert.equal((request.params as { snapshotIdentity: string }).snapshotIdentity, 'review-fence');
  assert.equal('actor' in (request.params as object), false);
  await review('confirm-visual', 'human-impersonation');
  assert.equal(
    calls.some(({ method }) => method === Methods.RUN_REVIEW_VISUAL_CLAIM),
    false,
  );
  assert.deepEqual(output, ['--judgment-kind must be person-reviewed or lead-agent-reviewed.']);
});

test('an unreadable package never reaches the human review writer', async () => {
  errors = ['The captured evidence changed.'];
  await review('confirm-visual');
  assert.equal(
    calls.some(({ method }) => method === Methods.RUN_REVIEW_VISUAL_CLAIM),
    false,
  );
  assert.deepEqual(output, ['Select valid captured evidence before visual review.']);
});
