import assert from 'node:assert/strict';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  adoptedPublicationTarget,
  FLOW_STEPS,
  PUBLICATION_ADOPTION_ACTION,
  type Run,
  type RunAdoptPublishedPrParams,
} from '@farmslot/protocol';

await import('../../runtime/mock-pty.test-support.js');
const { runAdoptPublishedPr } = await import('./adopt-published-pr.js');
const {
  archiveRun,
  createRun,
  getRun,
  getRunWithArchived,
  persistRunNow,
  runsDirectory,
  updateRun,
} = await import('../../runs/store.js');
const { makeReadyGatePackage, deleteTestRunIfPresent } =
  await import('../../run-engine/test-fixtures.js');
const { collectRunGateReadiness } = await import('../../run-engine/gate-prerequisites.js');
const { latestResolvedHumanGateDecision, isReplayableResolvedHumanGateDecision } =
  await import('../../run-engine/decision-replay.js');
const { assertPublicationFinalization } =
  await import('../../run-engine/publication-finalization.js');
const { resetPublishGateApprovalForReplay } = await import('./replay-step.js');
const { buildCIWatchChainedRunParams } = await import('../../run-engine/ci-watch-chain.js');
const { reviewPRIdentity } = await import('../../review/session-mode.js');
const { initPrLinkage } = await import('../../integrations/pr-linkage.js');
const { withRunTransition } = await import('../../run-lifecycle/transition-coordinator.js');
const { refreshPublishedEvidence } =
  await import('../../run-completion/published-evidence-refresh.js');
const { runCompletionPipeline, prepareCompletionPackage, publishCompletionPackage } =
  await import('../../run-completion/orchestrator.js');
type Dependencies = import('./adopt-published-pr.js').PublicationAdoptionDependencies;

const reviewedHead = 'a'.repeat(40);
const newerHead = 'b'.repeat(40);
const packageHead = 'c'.repeat(40);
const approver = {
  principalId: 'human',
  credentialId: 'human-credential',
  displayName: 'Operator',
};
const noop = () => {};

function fixture(t: test.TestContext): Run {
  const run = createRun({
    flowType: 'dev',
    project: 'generic-project',
    ticketOrPr: 'PROJ-184',
    branch: 'fix/feature',
  });
  t.after(() => deleteTestRunIfPresent(run.id));
  const prepared = makeReadyGatePackage({ headSha: packageHead });
  return updateRun(run.id, {
    status: 'blocked',
    engineState: {
      generation: 2,
      publishGate: {
        packageId: prepared.id,
        packageHash: prepared.packageHash,
        publicationStatus: 'not_published',
        reviews: [
          {
            id: 'exhausted',
            source: 'pipeline',
            mode: 'cold',
            runner: 'scripted',
            model: null,
            loopNumber: 5,
            verdict: 'issues',
            unresolvedCount: 1,
          },
        ],
      },
    },
    decisions: [
      {
        id: 'publish-wait',
        type: 'engine_human_gate',
        title: 'Publish',
        description: '',
        createdAt: new Date().toISOString(),
        actions: [{ id: 'approve-publish', label: 'Publish', style: 'primary' }],
        payload: {
          kind: 'ready',
          prPackage: prepared,
          prNumber: null,
          repo: 'owner/repo',
          diffStat: { files: 0, additions: 0, deletions: 0 },
          workerReport: '',
          branch: 'fix/feature',
        },
      },
    ],
  });
}

function request(run: Run): RunAdoptPublishedPrParams {
  return {
    runId: run.id,
    prRef: 'https://github.com/owner/repo/pull/192',
    headSha: reviewedHead,
    reason: 'Exact-head external review and human publication approved.',
    attestReviewedPublication: true,
  };
}

function dependencies(overrides: Partial<Dependencies> = {}): Dependencies {
  return {
    authorizeEvidenceAttestation: () => approver,
    repository: async () => 'owner/repo',
    discover: async () => 192,
    github: async (args) => ({
      stdout: args.some((arg) => arg.endsWith('/commits'))
        ? `${reviewedHead}\n${newerHead}\n`
        : JSON.stringify({
            number: 192,
            html_url: 'https://github.com/owner/repo/pull/192',
            state: 'open',
            merged_at: null,
            draft: false,
            base: { repo: { full_name: 'owner/repo' } },
            head: { sha: newerHead, ref: 'fix/feature', repo: { full_name: 'owner/repo' } },
          }),
      stderr: '',
    }),
    readiness: async (run) => ({
      state: 'not-ready',
      identity: { runId: run.id, generation: 2 },
      reasons: [
        {
          code: 'review-result-required',
          prerequisite: 'review',
          message: 'Internal round cap reached',
        },
      ],
    }),
    continuationRefusals: async () => [
      {
        code: 'run-work-progressing',
        prerequisite: 'lifecycle',
        message: 'Worker still progressing',
      },
    ],
    ...overrides,
  };
}

function settledFixture(t: test.TestContext): Run {
  const original = fixture(t);
  return updateRun(original.id, {
    status: 'reconciling',
    error: 'Reviewer completed with an invalid result artifact: result is missing',
    decisions: [],
    steps: FLOW_STEPS[original.flowType].map((name) => ({
      name,
      status: name === 'finalize' || name === 'ci-watch' ? 'skipped' : 'done',
    })),
  });
}

test('merged publication settles a reconciled run with no remaining gate or execution steps', async (t) => {
  const run = settledFixture(t);
  const before = structuredClone(run);
  const github = dependencies().github!;
  const result = await runAdoptPublishedPr(
    request(run),
    noop,
    dependencies({
      github: async (args, options) => {
        const response = await github(args, options);
        if (args.some((arg) => arg.endsWith('/commits'))) return response;
        return {
          ...response,
          stdout: JSON.stringify({
            ...JSON.parse(response.stdout),
            state: 'closed',
            merged_at: '2026-10-21T07:38:00Z',
          }),
        };
      },
      continuationRefusals: async () => [],
    }),
  );
  assert.equal(result.run.status, 'done');
  assert.equal(result.run.error, undefined);
  assert.ok(result.run.completedAt);
  assert.equal(result.continuation, 'resumed');
  assert.equal(result.receipt.observedState, 'merged');
  assert.equal(result.receipt.priorGate?.decisionId, undefined);
  assert.deepEqual(result.run.steps, before.steps);
  assert.deepEqual(result.run.decisions, before.decisions);
  assert.deepEqual(result.run.agentContexts, before.agentContexts);
  assert.deepEqual(
    result.run.engineState?.publishGate?.reviews,
    before.engineState?.publishGate?.reviews,
  );
  assert.equal(result.run.engineState?.generation, before.engineState?.generation);
  assert.equal(result.run.engineState?.operatorForceCompleted, undefined);
});

test('settled adoption still refuses active work and never restarts incomplete steps', async (t) => {
  const progressing = settledFixture(t);
  const refused = await runAdoptPublishedPr(request(progressing), noop, dependencies());
  assert.equal(refused.continuation, 'refused');
  assert.equal(refused.refusals[0].code, 'run-work-progressing');
  assert.equal(refused.run.status, 'reconciling');
  assert.ok(refused.run.error);
  assert.ok(refused.run.prNumber);
  for (const status of ['pending', 'running', 'failed', 'skipped'] as const) {
    const run = settledFixture(t);
    updateRun(run.id, {
      steps: run.steps.map((step) => (step.name === 'review' ? { ...step, status } : step)),
    });
    const before = structuredClone(run.steps);
    const result = await runAdoptPublishedPr(
      request(run),
      noop,
      dependencies({ continuationRefusals: async () => [] }),
    );
    assert.equal(result.continuation, 'waiting');
    assert.equal(result.run.status, 'reconciling');
    assert.ok(result.run.error);
    assert.deepEqual(result.run.steps, before);
  }
});

test(
  'completion publishes durably before unlocked slot release and adoption retry stays idempotent',
  { timeout: 4000 },
  async (t) => {
    const run = settledFixture(t);
    updateRun(run.id, { slotId: 'fixture-slot' });
    let releases = 0;
    const deps = dependencies({
      continuationRefusals: async () => [],
      releaseSlot: async (completed) => {
        releases += 1;
        assert.equal(completed.status, 'done');
        const durable = JSON.parse(
          await readFile(path.join(runsDirectory(), `${run.id}.json`), 'utf8'),
        );
        assert.equal(durable.status, 'done');
        assert.equal(durable.error, undefined);
        // This would deadlock if teardown still held the machine/run keys.
        await withRunTransition(run.id, async () => {});
        throw new Error('Fixture slot release unavailable');
      },
    });
    const first = await runAdoptPublishedPr(request(run), noop, deps);
    assert.equal(first.run.status, 'done');
    assert.equal(first.refusals[0].code, 'publication-continuation-effect-failed');
    assert.match(first.refusals[0].message, /slot-release: Fixture slot release unavailable/);
    const completedAt = first.run.completedAt;
    const second = await runAdoptPublishedPr(request(run), noop, deps);
    assert.deepEqual(second.receipt, first.receipt);
    assert.equal(second.run.completedAt, completedAt);
    assert.equal(second.run.prPublications?.length, 1);
    assert.equal(releases, 1);
  },
);

test('adopted publication remains fulfilled after gate replay without restoring package approval', async (t) => {
  const run = fixture(t);
  updateRun(run.id, { mode: 'autonomous' });
  await runAdoptPublishedPr(request(run), noop, dependencies());
  const adopted = getRun(run.id)!;
  const receipt = structuredClone(adopted.engineState?.publishGate?.humanPublicationAdoption);
  assert.ok(receipt);
  updateRun(run.id, { engineState: resetPublishGateApprovalForReplay(adopted.engineState) });
  const replayed = getRun(run.id)!;
  assert.equal(replayed.engineState?.publishGate?.publicationStatus, 'not_published');
  assert.equal(replayed.engineState?.publishGate?.approvedPackageHash, undefined);
  assert.deepEqual(replayed.engineState?.publishGate?.humanPublicationAdoption, receipt);
  assert.doesNotThrow(() => assertPublicationFinalization(replayed, 'finalize'));
  assert.doesNotThrow(() => assertPublicationFinalization(replayed, 'complete'));
  const readiness = await collectRunGateReadiness(
    replayed,
    null,
    {
      deterministic: async () => {},
      acceptance: async () => ({ criteria: [], ledger: null, issues: [] }),
      progress: async () => ({ kind: 'making-progress' }),
    },
    'post-publication',
  );
  assert.ok(
    readiness.reasons.some((reason) => reason.code === 'run-work-progressing'),
    'an adopted publication never proves native idle or bypasses continuation checks',
  );
});

test('active adoption retains three heads and exhausted reviews; only the publication wait is superseded', async (t) => {
  const run = fixture(t);
  const before = structuredClone(run);
  let continued = false;
  const result = await runAdoptPublishedPr(
    request(run),
    noop,
    dependencies({
      continueDecision: async () => {
        continued = true;
        return true;
      },
    }),
  );
  assert.equal(result.continuation, 'refused');
  assert.equal(continued, false);
  assert.equal(result.receipt.headSha, reviewedHead);
  assert.equal(result.receipt.observedHeadSha, newerHead);
  assert.equal(result.receipt.priorGate?.headSha, packageHead);
  assert.equal(result.receipt.priorGate?.unmetPrerequisites[0].code, 'review-result-required');
  assert.equal(result.run.decisions[0].resolvedAction, PUBLICATION_ADOPTION_ACTION);
  assert.equal(result.run.engineState?.publishGate?.publicationStatus, 'published_ready');
  assert.equal(result.run.engineState?.publishGate?.approvedPackageHash, undefined);
  assert.deepEqual(
    result.run.engineState?.publishGate?.reviews,
    before.engineState?.publishGate?.reviews,
  );
  assert.deepEqual(result.run.decisions[0].payload, before.decisions[0].payload);
  assert.equal(result.run.status, 'blocked');
  const persisted = JSON.parse(
    await readFile(path.join(runsDirectory(), `${run.id}.json`), 'utf8'),
  );
  assert.deepEqual(persisted.engineState.publishGate.humanPublicationAdoption, result.receipt);
  assert.equal(persisted.prNumber, 192);
  assert.equal(persisted.decisions[0].resolvedAction, PUBLICATION_ADOPTION_ACTION);
  assert.equal(
    latestResolvedHumanGateDecision(result.run.decisions, true)?.resolvedAction,
    PUBLICATION_ADOPTION_ACTION,
  );
  assert.equal(
    isReplayableResolvedHumanGateDecision(result.run.decisions[0], [
      { id: 'approve-publish', label: 'Publish', style: 'primary' },
    ]),
    true,
  );
  await assert.rejects(
    refreshPublishedEvidence({ runId: run.id }, noop),
    /Wait for the published run/,
  );
  await assert.rejects(prepareCompletionPackage(run.id), /preserves the prior package/);
  const published = await publishCompletionPackage(run.id, makeReadyGatePackage());
  assert.equal(published.prNumber, 192);
  assert.equal(published.ciRepo, 'owner/repo');
  assert.equal(published.prTitleUpdated, false);
  const completion = await runCompletionPipeline(run.id);
  assert.equal(completion.prNumber, 192);
  assert.equal(completion.prCommentPosted, false);
  assert.throws(
    () =>
      createRun({
        flowType: 'dev',
        project: 'generic-project',
        ticketOrPr: 'PROJ-186',
        engineState: run.engineState,
      }),
    /gateway-owned/,
  );
  assert.throws(
    () => updateRun(run.id, { engineState: { publishGate: {} } }),
    /verified publication writer/,
  );
  assert.throws(() => updateRun(run.id, { prNumber: 193 }), /immutable/);
});

test('archived adoption preserves raw execution, old packages and every decision without resurrection', async (t) => {
  const run = fixture(t);
  updateRun(run.id, { status: 'cancelled', completedAt: new Date().toISOString() });
  await persistRunNow(run);
  await archiveRun(run.id);
  const file = path.join(runsDirectory(), 'archive', `${run.id}.json`);
  t.after(() => rm(file, { force: true }));
  const before = JSON.parse(await readFile(file, 'utf8'));
  let continued = false;
  const result = await runAdoptPublishedPr(
    request(run),
    noop,
    dependencies({
      continueDecision: async () => {
        continued = true;
        return true;
      },
    }),
  );
  assert.equal(result.archived, true);
  assert.equal(result.continuation, 'archived');
  assert.equal(continued, false);
  assert.equal(getRun(run.id), undefined);
  const after = JSON.parse(await readFile(file, 'utf8'));
  const withoutPublication = (record: Run) => {
    const copy = structuredClone(record);
    delete copy.prNumber;
    delete copy.links;
    delete copy.prPublications;
    const gate = copy.engineState!.publishGate!;
    delete gate.humanPublicationAdoption;
    delete gate.publicationStatus;
    delete gate.publicationTarget;
    delete gate.prNumber;
    return copy;
  };
  assert.deepEqual(withoutPublication(after), withoutPublication(before));
  assert.deepEqual(after.decisions, before.decisions);
  assert.deepEqual(
    (await getRunWithArchived(run.id))?.engineState?.publishGate?.humanPublicationAdoption,
    result.receipt,
  );
  const retry = await runAdoptPublishedPr(
    { ...request(run), reason: 'Different retry text' },
    noop,
    dependencies({
      github: async () => {
        throw new Error('Retry must not require GitHub');
      },
    }),
  );
  assert.deepEqual(retry.receipt, result.receipt);
  assert.equal(retry.run.prPublications?.length, 1);
  await assert.rejects(
    runAdoptPublishedPr({ ...request(run), headSha: newerHead }, noop, dependencies()),
    /Conflicting/,
  );
});

test('same-tuple concurrent adoption retains the first receipt and canonical CI/fix target', async (t) => {
  const run = fixture(t);
  const [first, second] = await Promise.all([
    runAdoptPublishedPr(request(run), noop, dependencies()),
    runAdoptPublishedPr(request(run), noop, dependencies()),
  ]);
  assert.deepEqual(first.receipt, second.receipt);
  assert.equal(getRun(run.id)?.prPublications?.length, 1);
  assert.deepEqual(adoptedPublicationTarget(first.run), {
    repository: 'owner/repo',
    prNumber: 192,
  });
  assert.deepEqual(reviewPRIdentity(first.run), { repository: 'owner/repo', prNumber: 192 });
  const chain = buildCIWatchChainedRunParams(first.run, 'dispatch-pr-complete', 'changed/config');
  assert.equal(chain?.createParams.ticketOrPr, 'owner/repo#192');
});

test('missing attestation, person authority, foreign refs and unsupported flows refuse before mutation', async (t) => {
  const run = fixture(t);
  const before = structuredClone(run);
  await assert.rejects(runAdoptPublishedPr(request(run), noop), /authenticated person/);
  await assert.rejects(
    runAdoptPublishedPr(
      { ...request(run), attestReviewedPublication: false } as unknown as RunAdoptPublishedPrParams,
      noop,
      dependencies(),
    ),
    /Explicit/,
  );
  await assert.rejects(
    runAdoptPublishedPr({ ...request(run), reason: ' ' }, noop, dependencies()),
    /written reason/,
  );
  await assert.rejects(
    runAdoptPublishedPr({ ...request(run), headSha: 'abcdef' }, noop, dependencies()),
    /full commit/,
  );
  await assert.rejects(
    runAdoptPublishedPr(
      { ...request(run), prRef: 'https://github.com/foreign/repo/pull/192' },
      noop,
      dependencies(),
    ),
    /declared repository/,
  );
  await assert.rejects(
    runAdoptPublishedPr(request(run), noop, dependencies({ discover: async () => 193 })),
    /different PR/,
  );
  assert.deepEqual(run, before);
  for (const flowType of ['qa', 'review-pr', 'pr-complete'] as const) {
    updateRun(run.id, { flowType });
    await assert.rejects(runAdoptPublishedPr(request(run), noop, dependencies()), /Only writable/);
  }
  updateRun(run.id, { flowType: 'dev', completionPolicy: 'artifact-only' });
  await assert.rejects(runAdoptPublishedPr(request(run), noop, dependencies()), /Only writable/);
});

test('GitHub branch/history failures, in-flight publication and conflicting linkage refuse', async (t) => {
  const run = fixture(t);
  await assert.rejects(
    runAdoptPublishedPr({ ...request(run), headSha: 'd'.repeat(40) }, noop, dependencies()),
    /not in this PR history/,
  );
  const normal = dependencies().github!;
  await assert.rejects(
    runAdoptPublishedPr(
      request(run),
      noop,
      dependencies({
        github: async (args, opts) => {
          const value = await normal(args, opts);
          const facts = JSON.parse(value.stdout);
          facts.head.ref = 'wrong-branch';
          return { ...value, stdout: JSON.stringify(facts) };
        },
      }),
    ),
    /GitHub PR facts/,
  );
  updateRun(run.id, { prNumber: 193 });
  await assert.rejects(runAdoptPublishedPr(request(run), noop, dependencies()), /different PR/);
  updateRun(run.id, {
    prNumber: undefined,
    engineState: {
      ...run.engineState,
      publishGate: { ...run.engineState?.publishGate, publicationStatus: 'pending_publish' },
    },
  });
  await assert.rejects(runAdoptPublishedPr(request(run), noop, dependencies()), /in-flight/);
});

test('generation and authority changes during GitHub verification cannot consume the gate', async (t) => {
  for (const revoked of [false, true]) {
    const run = fixture(t);
    let active = true;
    const normal = dependencies().github!;
    await assert.rejects(
      runAdoptPublishedPr(
        request(run),
        noop,
        dependencies({
          authorizeEvidenceAttestation: () => {
            if (!active) throw new Error('Credential revoked');
            return approver;
          },
          github: async (args, opts) => {
            if (revoked) active = false;
            else updateRun(run.id, { engineState: { ...run.engineState, generation: 3 } });
            return normal(args, opts);
          },
        }),
      ),
      revoked ? /Credential revoked/ : /changed during verification/,
    );
    assert.equal(run.prNumber, undefined);
    assert.equal(run.decisions[0].resolvedAt, undefined);
  }
});

test('failed durable write exposes no receipt, publication link or wake', async (t) => {
  const run = fixture(t);
  await persistRunNow(run);
  const file = path.join(runsDirectory(), `${run.id}.json`);
  await rm(file);
  await mkdir(file);
  t.after(() => rm(file, { recursive: true, force: true }));
  let broadcasts = 0;
  initPrLinkage(() => {
    broadcasts += 1;
  });
  t.after(() => initPrLinkage(noop));
  await assert.rejects(runAdoptPublishedPr(request(run), noop, dependencies()), /EISDIR|ENOTEMPTY/);
  assert.equal(run.prNumber, undefined);
  assert.equal(run.engineState?.publishGate?.humanPublicationAdoption, undefined);
  assert.equal(run.decisions[0].resolvedAt, undefined);
  assert.equal(broadcasts, 0);
});

test('unknown prior readiness stays explicit and unrelated waits are retained', async (t) => {
  const run = fixture(t);
  updateRun(run.id, {
    decisions: [
      ...run.decisions,
      {
        id: 'other-wait',
        type: 'retrospective',
        title: 'Retrospective',
        description: '',
        actions: [],
        createdAt: new Date().toISOString(),
      },
    ],
  });
  const result = await runAdoptPublishedPr(
    request(run),
    noop,
    dependencies({
      readiness: async () => {
        throw new Error('Source unavailable');
      },
    }),
  );
  assert.equal(
    result.receipt.priorGate?.unmetPrerequisites[0].code,
    'publication-readiness-unknown',
  );
  assert.equal(result.run.decisions[1].resolvedAt, undefined);
});

test('post-publication evaluation skips old-package approval but retains deterministic, acceptance and progress guards', async (t) => {
  const run = fixture(t);
  await runAdoptPublishedPr(request(run), noop, dependencies());
  const overrides = {
    deterministic: async () => {
      throw new Error('Missing deterministic proof');
    },
    acceptance: async () => ({ criteria: [], ledger: null, issues: ['Missing acceptance'] }),
    progress: async () => ({ kind: 'making-progress' as const }),
  };
  const readiness = await collectRunGateReadiness(run, null, overrides, 'post-publication');
  assert.deepEqual(
    readiness.reasons.map((reason) => reason.code),
    ['deterministic-not-passed', 'acceptance-incomplete', 'run-work-progressing'],
  );
});

test('failed publication projection retains the receipt and retry repairs only the effect', async (t) => {
  const run = fixture(t);
  initPrLinkage(() => {
    throw new Error('Update projection unavailable');
  });
  t.after(() => initPrLinkage(noop));
  const first = await runAdoptPublishedPr(request(run), noop, dependencies());
  assert.equal(first.continuation, 'refused');
  assert.equal(first.refusals[0].code, 'publication-projection-failed');
  assert.equal(first.run.prNumber, 192);
  initPrLinkage(noop);
  const retry = await runAdoptPublishedPr(request(run), noop, dependencies());
  assert.deepEqual(retry.receipt, first.receipt);
  assert.equal(retry.run.prPublications?.length, 1);
  assert.ok(!retry.refusals.some((reason) => reason.code === 'publication-projection-failed'));
});

test('adoption wakes the existing decision resolver without issuing an ordinary approval', async (t) => {
  const run = fixture(t);
  const { createEngineDecision } = await import('../../run-engine/engine-decisions.js');
  const payload = run.decisions[0].payload;
  updateRun(run.id, { decisions: [], steps: [{ name: 'human-gate', status: 'running' }] });
  const pending = createEngineDecision(
    run.id,
    'human_gate',
    'Publication wait',
    [{ id: 'hold', label: 'Hold', style: 'secondary' }],
    payload,
    { readProgress: async () => ({ kind: 'idle' }) },
  );
  const deadline = Date.now() + 1000;
  while (!run.decisions.some((decision) => !decision.resolvedAt)) {
    if (Date.now() > deadline) throw new Error('Publication decision did not open');
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const result = await runAdoptPublishedPr(
    request(run),
    noop,
    dependencies({ continuationRefusals: async () => [] }),
  );
  assert.equal(result.continuation, 'resumed');
  assert.equal(await pending, PUBLICATION_ADOPTION_ACTION);
  assert.equal(run.engineState?.publishGate?.approvedPackageHash, undefined);
  assert.equal(run.prNumber, 192);
});

test('verified draft, closed and merged PRs record their observed publication state', async (t) => {
  for (const state of ['draft', 'closed', 'merged']) {
    const run = fixture(t);
    const normal = dependencies().github!;
    const result = await runAdoptPublishedPr(
      request(run),
      noop,
      dependencies({
        github: async (args, opts) => {
          const output = await normal(args, opts);
          if (args.some((arg) => arg.endsWith('/commits'))) return output;
          const facts = JSON.parse(output.stdout);
          facts.draft = state === 'draft';
          facts.state = state === 'draft' ? 'open' : 'closed';
          facts.merged_at = state === 'merged' ? '2026-10-14T00:00:00Z' : null;
          return { ...output, stdout: JSON.stringify(facts) };
        },
      }),
    );
    assert.equal(
      result.receipt.publicationStatus,
      state === 'draft' ? 'published_draft' : 'published_ready',
    );
    assert.equal(result.receipt.observedState, state === 'draft' ? 'open' : state);
  }
});

test('legacy archive identity is checked after migration while raw history stays unchanged', async (t) => {
  const run = fixture(t);
  updateRun(run.id, {
    project: 'farmslot',
    flowType: 'feature' as never,
    status: 'cancelled',
    completedAt: new Date().toISOString(),
  });
  await persistRunNow(run);
  await archiveRun(run.id);
  const file = path.join(runsDirectory(), 'archive', `${run.id}.json`);
  t.after(() => rm(file, { force: true }));
  const before = JSON.parse(await readFile(file, 'utf8'));
  const result = await runAdoptPublishedPr(request(run), noop, dependencies());
  assert.equal(result.archived, true);
  assert.equal(result.run.project, 'farmslot-farm');
  assert.equal(result.run.flowType, 'dev');
  const after = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(after.project, before.project);
  assert.equal(after.flowType, before.flowType);
  assert.deepEqual(after.decisions, before.decisions);
  assert.deepEqual(after.steps, before.steps);
  assert.equal(after.engineState.generation, before.engineState.generation);
});

test('adoption during progress observation cannot append a fresh publication gate', async (t) => {
  const run = fixture(t);
  const { createEngineDecision } = await import('../../run-engine/engine-decisions.js');
  const payload = run.decisions[0].payload;
  updateRun(run.id, { decisions: [] });
  let entered!: () => void;
  let release!: () => void;
  const observed = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(release);
  const gate = createEngineDecision(
    run.id,
    'human_gate',
    'Publication wait',
    [{ id: 'hold', label: 'Hold', style: 'secondary' }],
    payload,
    {
      readProgress: async () => {
        entered();
        await barrier;
        return { kind: 'idle' };
      },
    },
  );
  const refused = assert.rejects(gate, /does not own its continuation slot/);
  await observed;
  const result = await runAdoptPublishedPr(request(run), noop, dependencies());
  assert.equal(result.receipt.priorGate?.decisionId, undefined);
  release();
  await refused;
  assert.equal(run.decisions.length, 0);
  assert.equal(run.engineState?.publishGate?.publicationStatus, 'published_ready');
});
