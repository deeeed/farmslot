import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fsPromises, { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { readRecordedEvidencePackage } from '@farmslot/adapter-sdk';
import {
  deriveReviewedRecipeClaims,
  validateRecordedEvidencePackage,
} from '@farmslot/adapter-sdk/evidence';
import {
  type ArtifactRef,
  parseProjectVisualClaimReviewPolicy,
  type RecipeArtifactManifestEntry,
  type RunDecision,
  type RunReviewVisualClaimParams,
} from '@farmslot/protocol';

import { JsonArtifactWriter } from '../../../../../packages/recipe-runner/src/node/writers.js';

await import('../../runtime/mock-pty.test-support.js');
const { resourceRevisions } = await import('../../resources/revisions.js');
const { createRun, updateRun, getRun, runsDirectory } = await import('../../runs/store.js');
const { runReviewVisualClaim } = await import('./claim-reviews.js');
const { visualReviewSnapshotIdentity, readVisualReviewSource } =
  await import('../../run-engine/recorded-evidence-sources.js');
const { visualReviewAuthority } = await import('../../run-engine/claim-reviews.js');
const { deleteTestRunIfPresent, makeReadyGatePackage, retainRunFixture } =
  await import('../../run-engine/test-fixtures.js');
const { retainedRunTaskDirectory } = await import('../../run-completion/retained-artifacts.js');
const { computeReadyGatePackageHash } = await import('../../run-completion/ready-gate-package.js');
const { collectRunGateReadiness, refreshRunGateReadiness } =
  await import('../../run-engine/gate-prerequisites.js');
const { readRunRecordedEvidence } = await import('./evidence-review.js');

export async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'visual-claim-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { files } = JSON.parse(
    await readFile(
      new URL(
        '../../../../../packages/recipe-runner/test/fixtures/visual-review-package.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as { files: Record<string, string> };
  const prefix = 'artifacts/recipe-runs/attempt/';
  const inventory: ArtifactRef[] = [];
  for (const [file, bytes] of Object.entries({
    ...Object.fromEntries(Object.entries(files).map(([file, bytes]) => [prefix + file, bytes])),
    'artifacts/latest-valid-recipe-run.json': JSON.stringify({
      version: 1,
      relativeArtifactRoot: 'recipe-runs/attempt',
    }),
  })) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), bytes);
    inventory.push({
      path: file,
      purpose: 'evidence',
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  const directory = path.join(root, prefix);
  // The retained legacy fixture predates attempt-local publication manifests.
  // Generate its candidate with the engine writer before sealing this test capture.
  const legacy = (await readRecordedEvidencePackage(directory)).input;
  const writer = new JsonArtifactWriter(directory);
  const fixtureManifest: { artifacts: RecipeArtifactManifestEntry[] } = JSON.parse(
    files['artifact-manifest.json']!,
  );
  for (const artifact of fixtureManifest.artifacts) writer.register(artifact);
  await writer.writeEvidenceManifest(legacy.claims!);
  await writer.write('pass');
  inventory.push({ path: `${prefix}evidence-manifest.json`, purpose: 'evidence' });
  for (const artifact of inventory)
    artifact.sha256 = createHash('sha256')
      .update(await readFile(path.join(root, artifact.path)))
      .digest('hex');
  const input = (await readRecordedEvidencePackage(directory)).input;
  assert.equal(validateRecordedEvidencePackage(input).status, 'valid');
  const prepared = makeReadyGatePackage({ evidenceManifest: inventory, selectedEvidenceKeys: [] });
  prepared.packageHash = computeReadyGatePackageHash(prepared);
  const run = createRun({
    flowType: 'dev',
    project: 'test-project',
    ticketOrPr: 'UNIT-VISUAL-CLAIM',
  });
  t.after(() => deleteTestRunIfPresent(run.id));
  const decision: RunDecision = {
    id: 'gate',
    type: 'engine_human_gate',
    title: 'Review',
    description: 'Review retained proof',
    createdAt: '2026-10-14T00:00:00Z',
    actions: [],
    payload: {
      kind: 'ready',
      prNumber: null,
      repo: null,
      workerReport: 'Finished',
      branch: prepared.branch,
      diffStat: prepared.diffStat,
      prPackage: prepared,
    },
  };
  updateRun(run.id, {
    taskFile: path.join(root, 'TASK.md'),
    status: 'human-gating',
    decisions: [decision],
  });
  await retainRunFixture(getRun(run.id)!, prepared);
  const params: RunReviewVisualClaimParams = {
    runId: run.id,
    decisionId: decision.id,
    claimId: 'check-1',
    recipeRunId: input.claims!.recipeRunId,
    snapshotIdentity: visualReviewSnapshotIdentity(run, decision.id),
    verdict: 'confirmed',
    reason: 'The recorded view shows the expected value.',
  };
  const person = {
    principalId: 'person',
    credentialId: 'credential',
    displayName: 'Reviewer',
    subjectKind: 'person' as const,
  };
  const dependencies = {
    authorizeVisualClaimReview: () => person,
    refreshPackage: async ({ runId }: { runId: string }) => {
      const current = getRun(runId);
      assert.ok(current);
      return { run: current };
    },
  };
  return { run, decision, params, dependencies, input, prepared, directory, person, inventory };
}

test('PR completion records parent visual evidence without requiring review or rewriting its ledger', async (t) => {
  const f = await fixture(t);
  const before = await readFile(path.join(f.directory, 'acceptance-status.json'));
  const result = await runReviewVisualClaim(f.params, () => {}, f.dependencies);
  f.prepared.visualJudgmentReceiptIds = [result.receipt.id];
  f.prepared.packageHash = computeReadyGatePackageHash(f.prepared);
  const { makeRun } = await import('../../run-engine/test-fixtures.js');
  const child = makeRun({ flowType: 'pr-complete', parentRunId: f.run.id });
  const sources = {
    deterministic: async () => {},
    progress: async () => ({ kind: 'idle' as const }),
    recordedEvidence: async () => [f.input],
    acceptance: async () => ({
      criteria: f.input.claims!.criteria.slice(0, 1).map(({ id, text }) => ({ id, text })),
      ledger: f.input.claims!,
      issues: [],
      inheritedSource: {
        run: f.run,
        prPackage: f.prepared,
        provenance: {
          source: 'parent-run' as const,
          parentRunId: f.run.id,
          headSha: 'a'.repeat(40),
          ledgerHash: 'retained-ledger',
        },
      },
    }),
  };
  const ready = await collectRunGateReadiness(child, null, sources);
  assert.equal(ready.state, 'ready', JSON.stringify(ready.reasons));
  const staleCI = await collectRunGateReadiness(child, null, {
    ...sources,
    deterministic: async () => {
      throw new Error('Child CI is stale');
    },
  });
  assert.ok(staleCI.reasons.some(({ code }) => code === 'deterministic-not-passed'));
  const active = await collectRunGateReadiness(child, null, {
    ...sources,
    progress: async () => ({ kind: 'making-progress' as const }),
  });
  assert.equal(active.state, 'collecting');
  assert.deepEqual(await readFile(path.join(f.directory, 'acceptance-status.json')), before);
  const receipts = f.run.visualJudgmentReceipts;
  f.run.visualJudgmentReceipts = [];
  const unreviewed = await collectRunGateReadiness(child, null, sources);
  assert.equal(unreviewed.state, 'ready');
  f.run.visualJudgmentReceipts = receipts;
  const fresh = { ...f.run, flowType: 'pr-complete' as const, decisions: [], engineState: {} };
  const ownSources = {
    deterministic: sources.deterministic,
    progress: sources.progress,
    acceptance: async () => ({
      criteria: f.input.claims!.criteria.slice(0, 1).map(({ id, text }) => ({ id, text })),
      ledger: f.input.claims!,
      issues: [],
    }),
  };
  const freshReady = await collectRunGateReadiness(fresh, null, ownSources);
  assert.equal(freshReady.state, 'ready', JSON.stringify(freshReady.reasons));
  const foreignNamespace = await collectRunGateReadiness(
    { ...fresh, id: 'foreign-task' },
    null,
    ownSources,
  );
  assert.equal(foreignNamespace.state, 'ready');
  await runReviewVisualClaim(
    {
      ...f.params,
      snapshotIdentity: visualReviewSnapshotIdentity(f.run, f.decision.id),
      verdict: 'rejected',
      reason: 'A current check found a different result.',
    },
    () => {},
    f.dependencies,
  );
  assert.equal(
    (await collectRunGateReadiness(child, null, sources)).state,
    'ready',
    'Parent review verdicts remain evidence only for PR completion',
  );
  fresh.visualJudgmentReceipts = f.run.visualJudgmentReceipts;
  assert.equal(
    (await collectRunGateReadiness(fresh, null, ownSources)).state,
    'ready',
    'Recorded visual issues do not add a PR-completion reviewer gate',
  );
  assert.deepEqual(await readFile(path.join(f.directory, 'acceptance-status.json')), before);
});

test('delegated judgments retain their own identity/digests and drive the same parent reducer', async (t) => {
  const f = await fixture(t);
  const policy = parseProjectVisualClaimReviewPolicy({
    delegatedReviewerPrincipalIds: ['lead-reviewer'],
    delegatorPrincipalId: 'person',
  })!;
  const reviewer = {
    principalId: 'lead-reviewer',
    credentialId: 'lead-credential',
    displayName: 'Lead reviewer',
    subjectKind: 'service' as const,
    delegator: { principalId: 'person', displayName: 'Operator' },
  };
  const dependencies = {
    ...f.dependencies,
    authorizeVisualClaimReview: () => reviewer,
    policy: async () => policy,
  };
  const params = { ...f.params, kind: 'lead-agent-reviewed' as const };
  const before = await readFile(path.join(f.directory, 'acceptance-status.json'));
  const result = await runReviewVisualClaim(params, () => {}, dependencies);
  assert.equal(result.receipt.kind, 'lead-agent-reviewed');
  assert.equal(result.receipt.approver.principalId, 'lead-reviewer');
  assert.equal(result.receipt.reviewerSubjectKind, 'service');
  assert.equal(result.receipt.delegation!.principalId, 'person');
  assert.ok(result.receipt.reviewedFiles!.length);
  for (const file of result.receipt.reviewedFiles!)
    assert.equal(file.digest, f.input.artifactDigests[file.path]);
  assert.deepEqual(
    deriveReviewedRecipeClaims(
      f.input,
      visualReviewAuthority(f.run, f.input, undefined, policy),
    ).map(({ verdict }) => verdict),
    ['proven', 'proven'],
  );
  assert.deepEqual(
    deriveReviewedRecipeClaims(f.input, visualReviewAuthority(f.run, f.input)).map(
      ({ verdict }) => verdict,
    ),
    ['awaiting-review', 'awaiting-review'],
  );
  assert.equal(
    (await runReviewVisualClaim(params, () => {}, dependencies)).receipt.id,
    result.receipt.id,
  );
  assert.deepEqual(await readFile(path.join(f.directory, 'acceptance-status.json')), before);
  assert.equal(f.decision.resolvedAt, undefined);
  const rejected = await runReviewVisualClaim(
    {
      ...params,
      snapshotIdentity: visualReviewSnapshotIdentity(f.run, f.decision.id),
      verdict: 'rejected',
      reason: 'The retained value is wrong.',
    },
    () => {},
    dependencies,
  );
  assert.notEqual(rejected.receipt.id, result.receipt.id);
  assert.deepEqual(
    deriveReviewedRecipeClaims(
      f.input,
      visualReviewAuthority(f.run, f.input, undefined, policy),
    ).map(({ verdict }) => verdict),
    ['failed', 'failed'],
  );
});

test('missing and changed delegation refuse a write without modifying captured evidence', async (t) => {
  const f = await fixture(t);
  const policy = {
    delegatedReviewerPrincipalIds: ['lead-reviewer'],
    delegatorPrincipalId: 'person',
  };
  const reviewer = {
    principalId: 'lead-reviewer',
    credentialId: 'lead-credential',
    displayName: 'Lead reviewer',
    subjectKind: 'service' as const,
    delegator: { principalId: 'person', displayName: 'Operator' },
  };
  const params = { ...f.params, kind: 'lead-agent-reviewed' as const };
  await assert.rejects(
    runReviewVisualClaim(params, () => {}, {
      authorizeVisualClaimReview: () => reviewer,
      policy: async () => ({ ...policy, delegatedReviewerPrincipalIds: [] }),
    }),
    /no matching project delegation/,
  );
  let reads = 0;
  await assert.rejects(
    runReviewVisualClaim(params, () => {}, {
      authorizeVisualClaimReview: () => reviewer,
      policy: async () =>
        ++reads === 1 ? policy : { ...policy, delegatedReviewerPrincipalIds: [] },
    }),
    /identity changed/,
  );
  assert.equal(f.run.visualJudgmentReceipts?.length ?? 0, 0);
});

test('durable visual review derives parent/check verdicts, retries once and preserves original bytes', async (t) => {
  const f = await fixture(t);
  const before = await readFile(path.join(f.directory, 'acceptance-status.json'));
  const watched = resourceRevisions.sample([
    { family: 'run', runId: f.run.id },
    { family: 'gate', runId: f.run.id, decisionId: f.decision.id },
    { family: 'artifacts', runId: f.run.id },
    { family: 'review', runId: f.run.id },
  ]).dependencies;
  const result = await runReviewVisualClaim(f.params, () => {}, f.dependencies);
  for (const { key, revision } of watched)
    assert(
      resourceRevisions.revision(key) > revision,
      'A retained visual receipt must invalidate its readers',
    );
  assert.equal(result.receipt.approver.principalId, 'person');
  assert.deepEqual(
    result.receipt.moments,
    f.input.claims!.criteria.find(({ id }) => id === 'check-1')!.moments,
  );
  assert.deepEqual(
    deriveReviewedRecipeClaims(f.input, visualReviewAuthority(f.run, f.input)).map(
      ({ verdict }) => verdict,
    ),
    ['proven', 'proven'],
  );
  assert.deepEqual(await readFile(path.join(f.directory, 'acceptance-status.json')), before);
  assert.equal(f.decision.resolvedAt, undefined);
  const stored = JSON.parse(await readFile(path.join(runsDirectory(), `${f.run.id}.json`), 'utf8'));
  assert.equal(stored.visualJudgmentReceipts[0].id, result.receipt.id);
  assert.deepEqual(
    deriveReviewedRecipeClaims(f.input, visualReviewAuthority(stored, f.input)),
    deriveReviewedRecipeClaims(f.input, visualReviewAuthority(f.run, f.input)),
  );
  assert.equal(
    (await runReviewVisualClaim(f.params, () => {}, f.dependencies)).receipt.id,
    result.receipt.id,
  );
  assert.equal(f.run.visualJudgmentReceipts?.length, 1);
  const rejected = await runReviewVisualClaim(
    {
      ...f.params,
      snapshotIdentity: visualReviewSnapshotIdentity(f.run, f.decision.id),
      verdict: 'rejected',
      reason: 'The value is wrong.',
    },
    () => {},
    f.dependencies,
  );
  assert.notEqual(rejected.receipt.id, result.receipt.id);
  assert.deepEqual(
    deriveReviewedRecipeClaims(f.input, visualReviewAuthority(f.run, f.input)).map(
      ({ verdict }) => verdict,
    ),
    ['failed', 'failed'],
  );
  assert.deepEqual(
    deriveReviewedRecipeClaims(
      f.input,
      visualReviewAuthority(f.run, f.input, [result.receipt.id]),
    ).map(({ verdict }) => verdict),
    ['proven', 'proven'],
  );
  assert.equal(
    (await runReviewVisualClaim(f.params, () => {}, f.dependencies)).receipt.id,
    result.receipt.id,
  );
  assert.equal(f.run.visualJudgmentReceipts?.length, 2);
  const fresh = await runReviewVisualClaim(
    {
      ...f.params,
      snapshotIdentity: visualReviewSnapshotIdentity(f.run, f.decision.id),
    },
    () => {},
    f.dependencies,
  );
  assert.notEqual(fresh.receipt.id, result.receipt.id);
  assert.deepEqual(
    deriveReviewedRecipeClaims(f.input, visualReviewAuthority(f.run, f.input)).map(
      ({ verdict }) => verdict,
    ),
    ['proven', 'proven'],
  );
  assert.equal(f.run.visualJudgmentReceipts?.length, 3);
});

test('unauthenticated, spoofed, stale, wrong-execution and derived-parent requests record nothing', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    runReviewVisualClaim(f.params, () => {}),
    { code: 'AUTH_FORBIDDEN' },
  );
  await assert.rejects(
    runReviewVisualClaim(f.params, () => {}, {
      authorizeVisualClaimReview: () => {
        throw new Error('Service credentials cannot attest');
      },
    }),
    /Service credentials/,
  );
  for (const patch of [
    { reason: ' ', verdict: 'rejected' as const },
    { snapshotIdentity: 'old' },
    { recipeRunId: 'other' },
    { claimId: 'case-1' },
    { actor: 'operator' },
    { moments: [] },
    { judgedAt: '2026-10-14' },
  ])
    await assert.rejects(runReviewVisualClaim({ ...f.params, ...patch }, () => {}, f.dependencies));
  assert.equal(f.run.visualJudgmentReceipts, undefined);
  assert.throws(
    () => updateRun(f.run.id, { visualJudgmentReceipts: [] }),
    /verified gateway writer/,
  );
});

test('a changed retained file remains an integrity refusal, even with a person', async (t) => {
  const f = await fixture(t);
  const file = path.join(
    await retainedRunTaskDirectory(f.run, f.prepared.artifactBundle),
    'artifacts/recipe-runs/attempt/video.mp4',
  );
  await chmod(file, 0o600);
  await writeFile(file, 'changed recording');
  await assert.rejects(
    runReviewVisualClaim(f.params, () => {}, f.dependencies),
    /missing|changed/,
  );
  assert.equal(f.run.visualJudgmentReceipts, undefined);
});

test('source and person races between reads refuse before persistence', async (t) => {
  const f = await fixture(t);
  let reads = 0;
  await assert.rejects(
    runReviewVisualClaim(f.params, () => {}, {
      ...f.dependencies,
      source: async (...args) => {
        const source = await readVisualReviewSource(...args);
        if (++reads === 2) f.prepared.packageHash = 'changed';
        return source;
      },
    }),
    /selection changed/,
  );
  f.prepared.packageHash = computeReadyGatePackageHash(f.prepared);
  let authorizations = 0;
  await assert.rejects(
    runReviewVisualClaim(f.params, () => {}, {
      authorizeVisualClaimReview: () =>
        ++authorizations === 1 ? f.person : { ...f.person, credentialId: 'replaced' },
    }),
    /identity changed/,
  );
  assert.equal(f.run.visualJudgmentReceipts, undefined);
});

test('failed persistence and revocation during persistence expose no receipt after reload', async (t) => {
  const f = await fixture(t);
  const write = fsPromises.writeFile;
  let mode = 'fail';
  let revoked = false;
  const handle = t.mock.method(
    fsPromises,
    'writeFile',
    async (...args: Parameters<typeof write>) => {
      if (String(args[0]).includes(`${f.run.id}.json.tmp`) && mode === 'fail')
        throw new Error('Storage failed');
      const result = await write(...args);
      if (String(args[0]).includes(`${f.run.id}.json.tmp`) && mode === 'revoke') revoked = true;
      return result;
    },
  );
  syncBuiltinESMExports();
  t.after(() => {
    handle.mock.restore();
    syncBuiltinESMExports();
  });
  await assert.rejects(
    runReviewVisualClaim(f.params, () => {}, f.dependencies),
    /Storage failed/,
  );
  assert.equal(f.run.visualJudgmentReceipts, undefined);
  mode = 'revoke';
  await assert.rejects(
    runReviewVisualClaim(f.params, () => {}, {
      authorizeVisualClaimReview: () => {
        if (revoked) throw new Error('Credential revoked');
        return f.person;
      },
    }),
    /Credential revoked/,
  );
  assert.equal(getRun(f.run.id)?.visualJudgmentReceipts, undefined);
  const stored = JSON.parse(await readFile(path.join(runsDirectory(), `${f.run.id}.json`), 'utf8'));
  assert.equal(stored.visualJudgmentReceipts, undefined);
});

test('cancelled retained evidence can be reviewed without changing its historical gate or reopening the run', async (t) => {
  const f = await fixture(t);
  f.decision.resolvedAt = '2026-10-14T00:01:00Z';
  updateRun(f.run.id, { status: 'cancelled' });
  const historical = JSON.stringify(f.decision);
  await runReviewVisualClaim(f.params, () => {}, f.dependencies);
  assert.equal(f.run.status, 'cancelled');
  assert.equal(JSON.stringify(f.decision), historical);
  updateRun(f.run.id, { readOnly: true });
  await assert.rejects(
    runReviewVisualClaim(f.params, () => {}, f.dependencies),
    /read-only/,
  );
});

test('output review updates receipt references while preserving report and artifact identities', async (t) => {
  const f = await fixture(t);
  f.decision.payload = {
    kind: 'output-review',
    manifestDigest: 'captured',
    reportPath: 'artifacts/report.html',
  };
  updateRun(f.run.id, {
    output: {
      workerFinished: true,
      capturedAt: '2026-10-14T00:00:00Z',
      manifestDigest: 'captured',
      reportPath: 'artifacts/report.html',
      artifactManifest: f.inventory,
    },
  });
  const output = JSON.stringify(f.run.output);
  const result = await runReviewVisualClaim(
    { ...f.params, snapshotIdentity: visualReviewSnapshotIdentity(f.run, f.decision.id) },
    () => {},
    f.dependencies,
  );
  assert.deepEqual(f.run.decisions[0]!.payload, {
    kind: 'output-review',
    manifestDigest: 'captured',
    reportPath: 'artifacts/report.html',
    visualJudgmentReceiptIds: [result.receipt.id],
  });
  assert.equal(JSON.stringify(f.run.output), output);
  assert.equal(f.run.decisions[0]!.resolvedAt, undefined);
});

test('publication freezes qualified reviews and rejected evidence stays blocked after refresh', async (t) => {
  const f = await fixture(t);
  f.prepared.reviewPolicy = { minimumReviews: 0, requestedBy: 'dispatch' };
  f.prepared.packageHash = computeReadyGatePackageHash(f.prepared);
  f.params.snapshotIdentity = visualReviewSnapshotIdentity(f.run, f.decision.id);
  const sources = {
    acceptance: async () => ({
      criteria: f.input.claims!.criteria.map(({ id, text }) => ({ id, text })),
      ledger: f.input.claims!,
      issues: [],
    }),
    deterministic: async () => {},
    selectedEvidence: async () => {},
    progress: async () => ({ kind: 'idle' as const }),
    recordedEvidence: async () => [f.input],
  };
  const confirmed = await runReviewVisualClaim(f.params, () => {}, f.dependencies);
  const stale = await collectRunGateReadiness(f.run, f.prepared, sources);
  assert.ok(stale.reasons.some(({ code }) => code === 'evidence-override-refresh-required'));
  f.prepared.visualJudgmentReceiptIds = [confirmed.receipt.id];
  f.prepared.packageHash = computeReadyGatePackageHash(f.prepared);
  const refreshed = await collectRunGateReadiness(f.run, f.prepared, sources);
  assert.equal(refreshed.state, 'ready', JSON.stringify(refreshed.reasons));
  const rejected = await runReviewVisualClaim(
    {
      ...f.params,
      snapshotIdentity: visualReviewSnapshotIdentity(f.run, f.decision.id),
      verdict: 'rejected',
      reason: 'The recorded value is wrong.',
    },
    () => {},
    f.dependencies,
  );
  f.prepared.visualJudgmentReceiptIds.push(rejected.receipt.id);
  const blocked = await collectRunGateReadiness(f.run, f.prepared, sources);
  assert.ok(blocked.reasons.some(({ evidencePolicy }) => evidencePolicy === 'claim-verdict'));
});

test('a pending gate presents the projected ledger and keeps the engine verdict', async (t) => {
  const f = await fixture(t);
  f.prepared.reviewPolicy = { minimumReviews: 0, requestedBy: 'dispatch' };
  f.prepared.packageHash = computeReadyGatePackageHash(f.prepared);
  f.params.snapshotIdentity = visualReviewSnapshotIdentity(f.run, f.decision.id);
  const confirmed = await runReviewVisualClaim(f.params, () => {}, f.dependencies);
  f.prepared.visualJudgmentReceiptIds = [confirmed.receipt.id];
  f.prepared.packageHash = computeReadyGatePackageHash(f.prepared);
  const current = getRun(f.run.id)!;
  updateRun(f.run.id, {
    decisions: current.decisions.map((decision) =>
      decision.id === f.decision.id && decision.payload?.kind === 'ready'
        ? {
            ...decision,
            payload: {
              ...decision.payload,
              prPackage: f.prepared,
              acceptanceStatus: f.input.claims,
            },
          }
        : decision,
    ),
  });
  const engineBytes = JSON.stringify(f.input.claims);
  await refreshRunGateReadiness(getRun(f.run.id)!, {
    acceptance: async () => ({
      criteria: f.input.claims!.criteria.map(({ id, text }) => ({ id, text })),
      ledger: f.input.claims!,
      issues: [],
    }),
    deterministic: async () => {},
    selectedEvidence: async () => {},
    progress: async () => ({ kind: 'idle' as const }),
    recordedEvidence: async () => [f.input],
  });
  const payload = getRun(f.run.id)!.decisions.find(({ id }) => id === f.decision.id)?.payload;
  assert.equal(payload?.kind, 'ready');
  const rows = payload?.kind === 'ready' ? (payload.acceptanceStatus?.criteria ?? []) : [];
  for (const id of ['case-1', 'check-1']) {
    const row = rows.find((entry) => entry.id === id);
    assert.equal(row?.verdict, 'proven', id);
    assert.equal(row?.engineVerdict, 'awaiting-review', id);
  }
  assert.equal(JSON.stringify(f.input.claims), engineBytes, 'engine claims stay unchanged');
});

test('QA review consumes only frozen case registration, even when another retained package is valid', async (t) => {
  const f = await fixture(t);
  const root = path.dirname(f.run.taskFile!);
  const history = path.join(root, 'artifacts/recipe-runs/history');
  await cp(f.directory, history, { recursive: true });
  const inventory = [
    ...f.inventory,
    ...f.inventory
      .filter(({ path: file }) => file.startsWith('artifacts/recipe-runs/attempt/'))
      .map((file) => ({
        ...file,
        path: file.path.replace('artifacts/recipe-runs/attempt/', 'artifacts/recipe-runs/history/'),
      })),
  ];
  const qa = {
    profile: { id: 'changes', title: 'Changed behavior', template_id: 'validation/shared' },
    inputs: { scope: 'pr' },
  };
  const index = {
    version: 1,
    runId: f.run.id,
    qa,
    source: { headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) },
    suitePath: 'qa-suite',
    scope: {
      path: 'qa-scope.json',
      digest: `sha256:${'c'.repeat(64)}`,
      suiteDigest: `sha256:${'d'.repeat(64)}`,
    },
    packages: { smoke: 'recipe-runs/attempt' },
    smoke: { caseId: 'smoke', proofTarget: 'check-1' },
  };
  const bytes = JSON.stringify(index);
  const indexPath = path.join(path.dirname(f.run.taskFile!), 'artifacts/qa-result.json');
  await writeFile(indexPath, bytes);
  inventory.push({
    path: 'artifacts/qa-result.json',
    purpose: 'json',
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
  f.decision.payload = {
    kind: 'output-review',
    manifestDigest: 'captured-qa',
    reportPath: 'artifacts/report.html',
  };
  updateRun(f.run.id, {
    flowType: 'qa',
    qa,
    qaSource: index.source,
    output: {
      capturedAt: '2026-10-14T00:00:00Z',
      workerFinished: true,
      manifestDigest: 'captured-qa',
      reportPath: 'artifacts/report.html',
      artifactManifest: inventory,
    },
  });
  await retainRunFixture(getRun(f.run.id)!);
  const source = await readVisualReviewSource(f.run, f.decision.id);
  assert.deepEqual(
    source.sources.map(({ artifactPrefix }) => artifactPrefix),
    ['artifacts/recipe-runs/attempt/'],
  );
  const display = await readRunRecordedEvidence(
    f.run,
    undefined,
    { decisionId: f.decision.id, packageHash: 'captured-qa' },
    f.input.claims!.recipeRunId,
  );
  assert.deepEqual(display.errors, []);
  assert.equal(display.input?.claims?.recipeRunId, f.input.claims!.recipeRunId);
  const unavailable = await readRunRecordedEvidence(
    f.run,
    undefined,
    { decisionId: f.decision.id, packageHash: 'captured-qa' },
    'unregistered-corrected-execution',
  );
  assert.equal(unavailable.input, undefined);
  await assert.rejects(
    runReviewVisualClaim(
      {
        ...f.params,
        snapshotIdentity: source.snapshotIdentity,
        recipeRunId: 'unregistered-corrected-execution',
      },
      () => {},
      f.dependencies,
    ),
    /Select one execution/,
  );
  assert.equal(f.run.visualJudgmentReceipts, undefined);
  const originalIndex = await readFile(indexPath);
  await runReviewVisualClaim(
    { ...f.params, snapshotIdentity: source.snapshotIdentity },
    () => {},
    f.dependencies,
  );
  assert.deepEqual(await readFile(indexPath), originalIndex);
});

test('one-tap confirmation has no invented reason and retains identity through refresh', async (t) => {
  const f = await fixture(t);
  const { reason: _reason, ...params } = f.params;
  const before = await readFile(path.join(f.directory, 'acceptance-status.json'));
  const result = await runReviewVisualClaim(params, () => {}, f.dependencies);
  assert.equal('reason' in result.receipt, false);
  assert.equal(result.receipt.approver.principalId, f.person.principalId);
  assert.equal(
    (await runReviewVisualClaim(params, () => {}, f.dependencies)).receipt.id,
    result.receipt.id,
  );
  assert.deepEqual(
    deriveReviewedRecipeClaims(f.input, visualReviewAuthority(f.run, f.input)).map(
      ({ verdict }) => verdict,
    ),
    ['proven', 'proven'],
  );
  await assert.rejects(
    runReviewVisualClaim({ ...params, verdict: 'rejected' }, () => {}, f.dependencies),
    /written reason/,
  );
  await assert.rejects(
    runReviewVisualClaim({ ...params, kind: 'lead-agent-reviewed' }, () => {}, f.dependencies),
    /written reason/,
  );
  const written = await runReviewVisualClaim(
    {
      ...params,
      snapshotIdentity: visualReviewSnapshotIdentity(f.run, f.decision.id),
      reason: 'Inspected the retained clip.',
    },
    () => {},
    f.dependencies,
  );
  assert.notEqual(written.receipt.id, result.receipt.id);
  assert.deepEqual(await readFile(path.join(f.directory, 'acceptance-status.json')), before);
  assert.equal(f.decision.resolvedAt, undefined);
});

test('a failed automatic refresh preserves the judgment and retry reuses its receipt', async (t) => {
  const f = await fixture(t);
  const before = await readFile(path.join(f.directory, 'acceptance-status.json'));
  await assert.rejects(
    runReviewVisualClaim(f.params, () => {}, {
      ...f.dependencies,
      refreshPackage: async () => {
        throw new Error('Source is unavailable');
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error && 'code' in error);
      assert.equal(error.code, 'VISUAL_JUDGMENT_REFRESH_REQUIRED');
      assert.match(error.message, /Judgment saved.*Source is unavailable/);
      return true;
    },
  );
  const saved = getRun(f.run.id)?.visualJudgmentReceipts;
  assert.equal(saved?.length, 1);
  const result = await runReviewVisualClaim(f.params, () => {}, f.dependencies);
  assert.equal(result.receipt.id, saved?.[0]?.id);
  assert.equal(result.run.visualJudgmentReceipts?.length, 1);
  assert.equal(f.decision.resolvedAt, undefined);
  assert.deepEqual(await readFile(path.join(f.directory, 'acceptance-status.json')), before);
});

test('a person Issue is a qualified Send back Issue until a later Looks right replaces it', async (t) => {
  const f = await fixture(t);
  const { qualifiedVisualIssues, admitVisualRepair } =
    await import('../../run-engine/visual-repair.js');
  await runReviewVisualClaim(
    { ...f.params, verdict: 'rejected', reason: 'The value shown is 2, not 1.' },
    () => {},
    f.dependencies,
  );
  const issues = qualifiedVisualIssues(getRun(f.run.id)!, f.input);
  assert.deepEqual(
    issues.map(({ claimId, reason, recipeRunId, proofMode }) => ({
      claimId,
      reason,
      recipeRunId,
      proofMode,
    })),
    [
      {
        claimId: 'check-1',
        reason: 'The value shown is 2, not 1.',
        recipeRunId: f.input.claims!.recipeRunId,
        proofMode: 'visual',
      },
    ],
  );
  assert.equal(issues[0]!.receiptId, getRun(f.run.id)!.visualJudgmentReceipts!.at(-1)!.id);
  // Admission derives everything from the frozen gate and refuses before the decision
  // is consumed or any budget is charged: first a stale package, then nested criteria
  // without a task registration.
  const gate = () => getRun(f.run.id)!.decisions.find(({ id }) => id === 'gate')!;
  await assert.rejects(admitVisualRepair(getRun(f.run.id)!, gate()), {
    code: 'VISUAL_REPAIR_REFUSED',
    message: 'Visual review changed after this package was prepared.',
  });
  f.prepared.visualJudgmentReceiptIds = [issues[0]!.receiptId];
  await retainRunFixture(getRun(f.run.id)!, f.prepared);
  await assert.rejects(admitVisualRepair(getRun(f.run.id)!, gate()), {
    code: 'VISUAL_REPAIR_REFUSED',
    message: 'The package has no valid task registration.',
  });
  assert.equal(getRun(f.run.id)!.engineState?.publishGate?.visualRepairs, undefined);
  await runReviewVisualClaim(
    { ...f.params, snapshotIdentity: visualReviewSnapshotIdentity(getRun(f.run.id)!, 'gate') },
    () => {},
    f.dependencies,
  );
  assert.deepEqual(qualifiedVisualIssues(getRun(f.run.id)!, f.input), []);
});
