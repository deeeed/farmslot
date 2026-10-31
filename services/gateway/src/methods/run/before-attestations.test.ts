import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test, { type TestContext } from 'node:test';

import {
  ATTEST_BEFORE_ATTEMPT_ACTION,
  buildRunDecisionActionRequest,
  Events,
  type Run,
  type RunAttestBeforeAttemptParams,
  type RunDecision,
} from '@farmslot/protocol';

await import('../../runtime/mock-pty.test-support.js');
const { createRun, getRun, updateRun } = await import('../../runs/store.js');
const { runAttestBeforeAttempt } = await import('./before-attestations.js');
const { deleteTestRunIfPresent } = await import('../../run-engine/test-fixtures.js');

const attempt = '20261031042938001-53783';
const manifest = JSON.stringify({
  version: 1,
  artifacts: [{ path: 'before.png', type: 'screenshot', label: 'Before' }],
});

function fixture(t: TestContext) {
  const run = createRun({
    flowType: 'dev',
    project: 'test-project',
    ticketOrPr: 'UNIT-BEFORE-ATTESTATION',
  });
  t.after(() => deleteTestRunIfPresent(run.id));
  // A package refused for its before side leaves the publish gate without a package.
  const decision: RunDecision = {
    id: 'gate',
    type: 'engine_human_gate',
    title: 'Publication package is unavailable',
    description: 'Test',
    createdAt: '2026-10-31T00:00:00Z',
    actions: [],
    payload: {
      kind: 'ready',
      prNumber: null,
      repo: null,
      workerReport: 'Publication package is unavailable',
      branch: 'feature',
      diffStat: { files: 0, additions: 0, deletions: 0 },
      stale: true,
    },
  };
  updateRun(run.id, { status: 'human-gating', decisions: [decision] });
  const params = buildRunDecisionActionRequest({
    runId: run.id,
    decision,
    actionId: ATTEST_BEFORE_ATTEMPT_ACTION,
    recipeRunId: attempt,
    reason: ' The recipe needs files this change adds. ',
  }).params as RunAttestBeforeAttemptParams;
  const dependencies = {
    authorizeEvidenceAttestation: () => ({
      principalId: 'person',
      displayName: 'Reviewer',
      credentialId: 'credential',
    }),
    readAttemptManifest: async (_run: Run, root: string) =>
      root === `recipe-runs/${attempt}` ? manifest : null,
  };
  return { run, decision, params, dependencies };
}

test('a person attests a same-run attempt bound to its manifest digest, idempotently', async (t) => {
  const f = fixture(t);
  const events: string[] = [];
  const { attestation } = await runAttestBeforeAttempt(
    f.params,
    (event) => events.push(event),
    f.dependencies,
  );
  assert.deepEqual(
    { ...attestation, id: undefined, attestedAt: undefined },
    {
      id: undefined,
      runId: f.run.id,
      decisionId: 'gate',
      attemptRoot: `recipe-runs/${attempt}`,
      manifestSha256: createHash('sha256').update(manifest).digest('hex'),
      approver: { principalId: 'person', displayName: 'Reviewer', credentialId: 'credential' },
      reason: 'The recipe needs files this change adds.',
      attestedAt: undefined,
    },
  );
  assert.ok(Number.isFinite(Date.parse(attestation.attestedAt)));
  assert.deepEqual(events, [Events.RUN_UPDATED]);
  const retry = await runAttestBeforeAttempt(f.params, () => {}, f.dependencies);
  assert.equal(retry.attestation.id, attestation.id);
  const saved = getRun(f.run.id)!;
  assert.deepEqual(saved.beforeAttemptAttestations, [attestation]);
  // The attestation resolves nothing; the operator retries the gate.
  assert.equal(saved.decisions[0]?.resolvedAt, undefined);
  assert.throws(
    () => updateRun(f.run.id, { beforeAttemptAttestations: [] }),
    /verified gateway writer/,
  );
});

test('an attempt in the harness attempts/ layout is named by its path under recipe-runs/', async (t) => {
  const f = fixture(t);
  const nested = 'attempts/20261031050157814-3227';
  const { attestation } = await runAttestBeforeAttempt(
    { ...f.params, recipeRunId: nested },
    () => {},
    {
      ...f.dependencies,
      readAttemptManifest: async (_run: Run, root: string) =>
        root === `recipe-runs/${nested}` ? manifest : null,
    },
  );
  assert.equal(attestation.attemptRoot, `recipe-runs/${nested}`);
  for (const recipeRunId of [
    'attempts/../escape',
    'attempts//x',
    '/attempts/x',
    'attempts/.hidden',
    'attempts/x/',
    'attempts\\x',
  ])
    await assert.rejects(
      runAttestBeforeAttempt({ ...f.params, recipeRunId }, () => {}, f.dependencies),
      /Name one recipe attempt/,
    );
});

test('a credential revoked or replaced at commit leaves no attestation', async (t) => {
  const f = fixture(t);
  const person = f.dependencies.authorizeEvidenceAttestation();
  // Call 1 authorizes the request; 2 rechecks before the durable write, 3 after it.
  for (const [failingCall, refusal] of [
    [2, /revoked/],
    [3, /revoked/],
  ] as const) {
    let calls = 0;
    await assert.rejects(
      runAttestBeforeAttempt(f.params, () => {}, {
        ...f.dependencies,
        authorizeEvidenceAttestation: () => {
          if (++calls === failingCall) throw new Error('Credential revoked');
          return person;
        },
      }),
      refusal,
    );
  }
  let calls = 0;
  await assert.rejects(
    runAttestBeforeAttempt(f.params, () => {}, {
      ...f.dependencies,
      authorizeEvidenceAttestation: () =>
        ++calls === 1 ? person : { ...person, credentialId: 'replaced' },
    }),
    /identity changed/,
  );
  assert.equal(getRun(f.run.id)?.beforeAttemptAttestations, undefined);
});

test('unauthenticated, blank reason, unknown attempt and a changed gate leave no attestation', async (t) => {
  const f = fixture(t);
  assert.throws(
    () =>
      buildRunDecisionActionRequest({
        runId: f.run.id,
        decision: f.decision,
        actionId: ATTEST_BEFORE_ATTEMPT_ACTION,
        recipeRunId: attempt,
        reason: ' ',
      }),
    /reason/,
  );
  await assert.rejects(
    runAttestBeforeAttempt(f.params, () => {}),
    /credential-backed/,
  );
  await assert.rejects(
    runAttestBeforeAttempt(f.params, () => {}, {
      ...f.dependencies,
      authorizeEvidenceAttestation: () => {
        throw new Error('Credential revoked');
      },
    }),
    /revoked/,
  );
  for (const [patch, refusal] of [
    [{ reason: ' ' }, /written reason/],
    [{ recipeRunId: 'unknown-attempt' }, /not a recipe attempt captured by this run/],
    [{ recipeRunId: '../escape' }, /Name one recipe attempt/],
    [{ decisionId: 'missing' }, /publish gate is unavailable/],
    [{ packageHash: 'stale' }, /displayed gate package changed/],
  ] as const)
    await assert.rejects(
      runAttestBeforeAttempt({ ...f.params, ...patch }, () => {}, f.dependencies),
      refusal,
    );
  await assert.rejects(
    runAttestBeforeAttempt(f.params, () => {}, {
      ...f.dependencies,
      readAttemptManifest: async () => '{"version":1}',
    }),
    /not a recipe attempt captured by this run/,
  );
  await assert.rejects(
    runAttestBeforeAttempt(f.params, () => {}, {
      ...f.dependencies,
      readAttemptManifest: async () => {
        f.decision.resolvedAt = new Date().toISOString();
        return manifest;
      },
    }),
    /gate changed/,
  );
  await assert.rejects(
    runAttestBeforeAttempt(f.params, () => {}, f.dependencies),
    /publish gate is unavailable/,
  );
  assert.equal(getRun(f.run.id)?.beforeAttemptAttestations, undefined);
});
