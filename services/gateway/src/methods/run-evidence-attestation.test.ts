import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

import {
  APPROVE_PUBLISH_EVIDENCE_ATTESTED_ACTION,
  buildRunResolveDecisionParams,
  type ReadyGatePrPackage,
  type RunDecision,
} from '@farmslot/protocol';

await import('../runtime/mock-pty.test-support.js');
const github = await import('../integrations/github-client.js');
const postedBodies: string[] = [];
mock.module('../integrations/github-client.js', {
  namedExports: {
    ...github,
    ghRequest: async (args: string[]) => {
      if (args[0] !== 'pr' || args[1] !== 'edit')
        throw new Error('Unexpected external publication request in attestation test');
      postedBodies.push(await readFile(args[args.indexOf('--body-file') + 1], 'utf8'));
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  },
});
const { runResolveDecision } = await import('./run.js');
const { createRun, getRun, updateRun } = await import('../runs/store.js');
const { makeReadyGatePackage, deleteTestRunIfPresent, retainRunFixture } =
  await import('../run-engine/test-fixtures.js');
const { computeReadyGatePackageHash } = await import('../run-completion/ready-gate-package.js');
const { withEvidenceAttestation } = await import('../run-completion/evidence-attestation.js');
const { postProcessPRBody } = await import('../run-completion/publication-artifacts.js');

const approver = { principalId: 'operator', displayName: 'Operator', credentialId: 'credential' };

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'gate-attestation-resolve-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = createRun({ flowType: 'fix-bug', project: 'attestation-test', ticketOrPr: 'TEST-1' });
  t.after(() => deleteTestRunIfPresent(run.id));
  await mkdir(path.join(root, 'artifacts'));
  const taskFile = path.join(root, 'TASK.md');
  await writeFile(taskFile, '# Test\n');
  await writeFile(path.join(root, 'artifacts/pr-description.md'), 'Body');
  const prepared: ReadyGatePrPackage = JSON.parse(
    JSON.stringify(
      makeReadyGatePackage({
        reviewSnapshot: undefined,
        reviewPolicy: { minimumReviews: 0, requestedBy: 'dispatch' },
      }),
    ),
  );
  prepared.packageHash = computeReadyGatePackageHash(prepared);
  await writeFile(path.join(root, prepared.artifactPath), JSON.stringify(prepared));
  const decision: RunDecision = {
    id: 'gate',
    type: 'engine_human_gate',
    title: 'Publish',
    description: 'Test',
    actions: [{ id: APPROVE_PUBLISH_EVIDENCE_ATTESTED_ACTION, label: 'Attest', style: 'danger' }],
    createdAt: new Date().toISOString(),
    payload: {
      kind: 'ready',
      branch: prepared.branch,
      prNumber: null,
      repo: null,
      workerReport: 'done',
      diffStat: prepared.diffStat,
      prPackage: prepared,
    },
  };
  updateRun(run.id, {
    status: 'human-gating',
    taskFile,
    decisions: [decision],
    engineState: {
      generation: 0,
      publishGate: {
        packageId: prepared.id,
        packageHash: prepared.packageHash,
        publicationStatus: 'not_published',
      },
    },
  });
  await retainRunFixture(getRun(run.id)!, prepared);
  const params = buildRunResolveDecisionParams({
    runId: run.id,
    decision,
    actionId: APPROVE_PUBLISH_EVIDENCE_ATTESTED_ACTION,
    evidenceAttestationReason: 'Inspected the retained evidence.',
  });
  const readiness = {
    state: 'not-ready' as const,
    identity: { runId: run.id, generation: 0, packageHash: prepared.packageHash },
    reasons: [
      {
        code: 'evidence-policy-unsatisfied',
        prerequisite: 'evidence' as const,
        evidencePolicy: 'criterion-binding' as const,
        message: 'Criterion binding differs.',
      },
    ],
  };
  return { run, decision, prepared, params, readiness };
}

test('attested resolve refuses background calls and blank reasons before consuming a gate', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    runResolveDecision(f.params, () => {}),
    /authenticated human publish gate/,
  );
  await assert.rejects(
    runResolveDecision({ ...f.params, evidenceAttestationReason: ' ' }, () => {}, {
      authorizeEvidenceAttestation: () => approver,
    }),
    /written reason/,
  );
  assert.equal(getRun(f.run.id)!.decisions[0].resolvedAt, undefined);
});

test('attested resolve rechecks authority and binds the retained receipt to the exact package', async (t) => {
  const f = await fixture(t);
  let checks = 0;
  const dependencies = {
    authorizeEvidenceAttestation: () => {
      checks++;
      return approver;
    },
    assertGatePrerequisites: async () => f.readiness,
  };
  const result = await runResolveDecision(f.params, () => {}, dependencies);
  assert.equal(checks, 2);
  const saved = result.run.decisions[0];
  assert.equal(saved.evidenceAttestation?.packageHash, f.prepared.packageHash);
  assert.deepEqual(saved.evidenceAttestation?.approver, approver);
  const body = withEvidenceAttestation(result.run, '## Summary\n\nChange.');
  assert.match(body, /Inspected the retained evidence/);
  assert.match(body, /Operator \(operator\)/);
  assert.equal(withEvidenceAttestation(result.run, body), body);
});

test('authority revocation during awaited validation leaves no approval or receipt', async (t) => {
  const f = await fixture(t);
  let checks = 0;
  await assert.rejects(
    runResolveDecision(f.params, () => {}, {
      authorizeEvidenceAttestation: () => {
        if (++checks > 1) throw new Error('credential revoked');
        return approver;
      },
      assertGatePrerequisites: async () => f.readiness,
    }),
    /credential revoked/,
  );
  assert.equal(getRun(f.run.id)!.decisions[0].resolvedAt, undefined);
  assert.equal(getRun(f.run.id)!.decisions[0].evidenceAttestation, undefined);
});

test('publication and refresh retain the exact reason despite artifact-path sanitization', async (t) => {
  const f = await fixture(t);
  const reason =
    'Inspected artifacts/chart-before.png and artifacts/chart-after.png.\nThe claim is satisfied.';
  const result = await runResolveDecision(
    { ...f.params, evidenceAttestationReason: reason },
    () => {},
    {
      authorizeEvidenceAttestation: () => approver,
      assertGatePrerequisites: async () => f.readiness,
    },
  );
  const initial = await postProcessPRBody(result.run, 'example/repo', 42, new Map(), [], {
    failOnError: true,
    baseBody: '## Summary\n\nChange.',
    evidenceManifest: null,
    checkAuthorChecklist: false,
  });
  assert.ok(initial?.includes(reason));
  const refreshed = await postProcessPRBody(result.run, 'example/repo', 42, new Map(), [], {
    failOnError: true,
    baseBody: initial!,
    evidenceManifest: null,
    checkAuthorChecklist: false,
  });
  assert.equal(refreshed, initial);
  assert.equal(refreshed?.split('## Evidence policy attestation').length, 2);
  assert.equal(postedBodies.at(-1), refreshed);
});

test('stale checked identity and gate replacement leave the decision unresolved', async (t) => {
  for (const field of ['runId', 'generation', 'packageHash'] as const) {
    const f = await fixture(t);
    await assert.rejects(
      runResolveDecision(f.params, () => {}, {
        authorizeEvidenceAttestation: () => approver,
        assertGatePrerequisites: async () => ({
          ...f.readiness,
          identity: { ...f.readiness.identity, [field]: field === 'generation' ? 1 : 'stale' },
        }),
      }),
      /current checked publication package/,
    );
    assert.equal(getRun(f.run.id)!.decisions[0].resolvedAt, undefined);
  }
  const f = await fixture(t);
  await assert.rejects(
    runResolveDecision(f.params, () => {}, {
      authorizeEvidenceAttestation: () => approver,
      assertGatePrerequisites: async () => {
        updateRun(f.run.id, {
          decisions: [{ ...f.decision, payload: { ...f.decision.payload! } }],
        });
        return f.readiness;
      },
    }),
    /gate package changed during validation/,
  );
  assert.equal(getRun(f.run.id)!.decisions[0].evidenceAttestation, undefined);
});

test('caller-supplied attestation receipt cannot consume a gate', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    runResolveDecision(
      {
        ...f.params,
        selectionData: { ...f.params.selectionData, evidenceAttestation: { approver } },
      },
      () => {},
      { authorizeEvidenceAttestation: () => approver },
    ),
    /gateway-owned/,
  );
  assert.equal(getRun(f.run.id)!.decisions[0].resolvedAt, undefined);
});
