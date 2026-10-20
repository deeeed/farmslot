import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

import {
  APPROVE_PUBLISH_EVIDENCE_ATTESTED_ACTION,
  APPROVE_PUBLISH_UNRESOLVED_ACTION,
  buildRunResolveDecisionParams,
  type Principal,
  type ReadyGatePrPackage,
  type RunDecision,
} from '@farmslot/protocol';

import { manualTicketData } from '../run-completion/test-fixtures.js';

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
const { withPublicationProvenance } = await import('../run-completion/evidence-attestation.js');
const { postProcessPRBody, replaceMarkdownSection } =
  await import('../run-completion/publication-artifacts.js');
const { buildPublishGateReviewStatus } = await import('../run-engine/gate-policy.js');
const { runWithSessionOriginator } = await import('../security/work-originator.js');
const { assertAcceptedFindingsCurrent } = await import('../run-engine/gate-prerequisites.js');

const approver = { principalId: 'operator', displayName: 'Operator', credentialId: 'credential' };

test('normal approval audits the actual person or service and frozen receipt ids without changing the package', async (t) => {
  for (const type of ['person', 'service'] as const) {
    const f = await fixture(t);
    f.decision.actions = [{ id: 'approve-publish', label: 'Approve', style: 'primary' }];
    const principal: Principal = {
      id: `approver-${type}`,
      subject: { type, displayName: `Reviewer ${type}` },
      roles: [],
    };
    const before = structuredClone(f.prepared);
    const params = buildRunResolveDecisionParams({
      runId: f.run.id,
      decision: f.decision,
      actionId: 'approve-publish',
    });
    const result = await runWithSessionOriginator(principal, () =>
      runResolveDecision(params, () => {}, {
        assertGatePrerequisites: async () => ({ ...f.readiness, state: 'ready', reasons: [] }),
        resumeRun: async () => {},
      }),
    );
    const saved = result.run.decisions[0]!.publicationApproval!;
    assert.equal(saved.principalId, principal.id);
    assert.equal(saved.subjectKind, type);
    assert.equal(saved.packageHash, before.packageHash);
    assert.deepEqual(saved.visualJudgmentReceiptIds, before.visualJudgmentReceiptIds ?? []);
    assert.deepEqual(f.prepared, before);
    const body = withPublicationProvenance(result.run, '## Summary\n\nChange.');
    assert.match(body, new RegExp(`Reviewer ${type} · ${type}`));
    assert.equal(withPublicationProvenance(result.run, body), body);
  }
});

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'gate-attestation-resolve-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = createRun({
    flowType: 'fix-bug',
    project: 'attestation-test',
    ticketOrPr: 'TEST-1',
    ticketData: manualTicketData('Attest retained evidence'),
  });
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
  const body = withPublicationProvenance(result.run, '## Summary\n\nChange.');
  assert.match(body, /Inspected the retained evidence/);
  assert.match(body, /Operator \(operator\)/);
  assert.equal(withPublicationProvenance(result.run, body), body);
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
  f.run.steps = [
    {
      name: 'review',
      status: 'skipped',
      outputs: { skipped: true, reason: 'disabled-for-project' },
    },
  ];
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
  const draft = withPublicationProvenance(
    result.run,
    '## Summary\n\nChange.\n\n## **Screenshots/Recordings**\n\nPrevious evidence.',
  );
  const rewritten = replaceMarkdownSection(
    draft,
    '## **Screenshots/Recordings**',
    'Hosted evidence.',
  );
  for (const baseBody of [
    rewritten,
    '## Summary\n\nChange.\n\n## Evidence policy attestation\n\nExisting retained attestation.',
  ]) {
    const initial = await postProcessPRBody(result.run, 'example/repo', 42, new Map(), [], {
      failOnError: true,
      baseBody,
      evidenceManifest: null,
      checkAuthorChecklist: false,
    });
    assert.ok(initial?.includes(reason));
    assert.ok(initial?.includes('No code review ran'));
    const refreshed = await postProcessPRBody(result.run, 'example/repo', 42, new Map(), [], {
      failOnError: true,
      baseBody: initial!,
      evidenceManifest: null,
      checkAuthorChecklist: false,
    });
    assert.equal(refreshed, initial);
    assert.equal(refreshed?.split('## Evidence policy attestation').length, 2);
    assert.equal(postedBodies.at(-1), refreshed);
  }
});

test('publication and refresh disclose skipped code review without duplicating provenance', async (t) => {
  const f = await fixture(t);
  f.run.steps = [
    {
      name: 'review',
      status: 'skipped',
      outputs: { skipped: true, reason: 'disabled-for-project' },
    },
  ];
  const options = {
    failOnError: true,
    baseBody: '## Summary\n\nChange.',
    evidenceManifest: null,
    checkAuthorChecklist: false,
  };
  const body = await postProcessPRBody(f.run, 'example/repo', 42, new Map(), [], options);
  assert.ok(body?.includes('Code review: No code review ran.'));
  assert.equal(postedBodies.at(-1), body);
  const refreshed = await postProcessPRBody(f.run, 'example/repo', 42, new Map(), [], {
    ...options,
    baseBody: body!,
  });
  assert.equal(refreshed, body);
  f.run.engineState!.publishGate!.reviews = [
    buildPublishGateReviewStatus({
      source: 'human-gate',
      priorReviewCount: 0,
      requestedRunner: null,
      reviewId: 'review-1',
      reviewResult: {
        mode: 'cold',
        verdict: 'blocked',
        reason: 'review-unavailable: node offline',
        retryCount: 0,
        validationDepth: 'static-code',
        attempts: [],
      },
    }),
  ];
  const unavailable = await postProcessPRBody(f.run, 'example/repo', 42, new Map(), [], {
    ...options,
    baseBody: body!,
  });
  assert.ok(unavailable?.includes('No code review ran'));
  f.run.engineState!.publishGate!.reviews = [
    {
      id: 'review-1',
      source: 'human-gate',
      mode: 'cold',
      loopNumber: 1,
      verdict: 'pass',
      unresolvedCount: 0,
      feedbackSent: false,
    },
  ];
  const reviewed = await postProcessPRBody(f.run, 'example/repo', 42, new Map(), [], {
    ...options,
    baseBody: body!,
  });
  assert.ok(!reviewed?.includes('No code review ran'));
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

/** The gate as TAT-4006's: one open finding at the head, review rounds spent. */
async function acceptFixture(t: test.TestContext) {
  const f = await fixture(t);
  const readiness = {
    state: 'not-ready' as const,
    identity: f.readiness.identity,
    reasons: [
      {
        code: 'review-fix-required',
        prerequisite: 'review' as const,
        message: 'Review rounds spent: 1 issue open',
        actionId: 'hold',
        allowedReviewOverrides: [APPROVE_PUBLISH_UNRESOLVED_ACTION],
      },
    ],
    findings: [
      {
        reviewId: 'review-8',
        file: 'acceptance-status.json',
        line: 10,
        description: 'Owner gate.',
      },
    ],
    findingsDigest: 'sha256:shown',
  };
  f.decision.actions = [
    { id: APPROVE_PUBLISH_UNRESOLVED_ACTION, label: 'Accept', style: 'danger' },
    { id: 'hold', label: 'Hold', style: 'secondary' },
  ];
  f.decision.payload = {
    ...f.decision.payload!,
    gateReadiness: readiness,
  } as RunDecision['payload'];
  updateRun(f.run.id, { decisions: [f.decision] });
  const params = buildRunResolveDecisionParams({
    runId: f.run.id,
    decision: f.decision,
    actionId: APPROVE_PUBLISH_UNRESOLVED_ACTION,
    reason: 'The owner accepts the descoped clause.',
  });
  const person: Principal = {
    id: 'operator',
    subject: { type: 'person', displayName: 'Operator' },
    roles: [],
  };
  const resolve = (
    request: typeof params,
    dependencies: Parameters<typeof runResolveDecision>[2] = {},
  ) =>
    runWithSessionOriginator(person, () =>
      runResolveDecision(request, () => {}, {
        assertGatePrerequisites: async () => readiness,
        resumeRun: async () => {},
        ...dependencies,
      }),
    );
  return { ...f, readiness, params, resolve };
}

test('accepting review findings needs a person, a written reason and the shown findings', async (t) => {
  const f = await acceptFixture(t);
  assert.equal(f.params.findingsDigest, 'sha256:shown');
  await assert.rejects(f.resolve(f.params), /authenticated human publish gate/);
  const person = { authorizeEvidenceAttestation: () => approver };
  await assert.rejects(f.resolve({ ...f.params, reason: ' ' }, person), /written reason/);
  await assert.rejects(f.resolve({ ...f.params, findingsDigest: undefined }, person), /digest/);
  await assert.rejects(
    f.resolve({ ...f.params, findingsDigest: 'sha256:stale' }, person),
    /findings changed since they were shown/,
  );
  assert.equal(getRun(f.run.id)!.decisions[0].resolvedAt, undefined);
  assert.equal(getRun(f.run.id)!.decisions[0].publicationApproval, undefined);
});

test('accepted findings are recorded with the reason, head and approver, and disclosed in the PR', async (t) => {
  const f = await acceptFixture(t);
  const result = await f.resolve(f.params, { authorizeEvidenceAttestation: () => approver });
  const saved = result.run.decisions[0]!;
  assert.equal(saved.resolvedAction, APPROVE_PUBLISH_UNRESOLVED_ACTION);
  assert.deepEqual(saved.publicationApproval?.acceptedFindings, {
    findings: f.readiness.findings,
    digest: 'sha256:shown',
  });
  assert.equal(saved.publicationApproval?.reason, 'The owner accepts the descoped clause.');
  assert.equal(saved.publicationApproval?.headSha, f.prepared.headSha);
  assert.deepEqual(saved.publicationApproval?.approver, approver);
  const body = withPublicationProvenance(result.run, '## Summary\n\nChange.');
  assert.match(body, /## Accepted review findings/);
  assert.match(body, /Accepted by Operator \(operator\)/);
  assert.match(body, /The owner accepts the descoped clause\./);
  assert.match(body, /acceptance-status\.json:10: Owner gate\. \(review review-8\)/);
  assert.equal(withPublicationProvenance(result.run, body), body);
  // Finalize and replay refuse once the head's open findings differ from the accepted set.
  assertAcceptedFindingsCurrent(saved, f.readiness);
  for (const readiness of [undefined, { ...f.readiness, findingsDigest: 'sha256:other' }])
    assert.throws(
      () => assertAcceptedFindingsCurrent(saved, readiness),
      /no longer match the open findings/,
    );
});
