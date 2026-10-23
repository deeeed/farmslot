import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mock, test, type TestContext } from 'node:test';

import { ACCEPTANCE_STATUS_ARTIFACT, type Run, type RunDecision } from '@farmslot/protocol';

import { retainFixtureTask } from '../../../../packages/run-bundle/src/retained.test-support.js';

await import('../runtime/mock-pty.test-support.js');
const store = await import('../runs/store.js');
let parent: Run | undefined;
mock.module('../runs/store.js', {
  namedExports: {
    ...store,
    getRunWithArchived: async (id: string) => (parent?.id === id ? parent : undefined),
  },
});
const github = await import('../integrations/github-client.js');
let posted = '';
let existingComment = '';
let createdComments = 0;
let patchedComments = 0;
let refuseCommentWrite = false;
mock.module('../integrations/github-client.js', {
  namedExports: {
    ...github,
    ghRequest: async (args: string[]) => {
      if (args[0] === 'api' && args.includes('--paginate'))
        return { stdout: existingComment, stderr: '', exitCode: 0 };
      if (args[0] === 'pr' && args[1] === 'comment') {
        if (refuseCommentWrite) throw new Error('Comment permission denied');
        createdComments++;
        posted = await readFile(args[args.indexOf('--body-file') + 1]!, 'utf8');
      }
      if (args.includes('PATCH')) {
        if (refuseCommentWrite) throw new Error('Comment permission denied');
        patchedComments++;
        const file = args[args.indexOf('-F') + 1]!;
        posted = await readFile(file.slice('body=@'.length), 'utf8');
        existingComment = JSON.stringify({ id: 777, body: posted });
      }
      return { stdout: '[]', stderr: '', exitCode: 0 };
    },
  },
});
const prompts = await import('../core/prompt-templates.js');
mock.module('../core/prompt-templates.js', {
  namedExports: { ...prompts, loadPromptTemplate: async () => null },
});

const { makeRun, makeReadyGatePackage } = await import('../run-engine/test-fixtures.js');
const { readRetainedRunText, runBundleStore } = await import('./retained-artifacts.js');
const { computeReadyGatePackageHash, sha256Text } = await import('./ready-gate-package.js');
const {
  readInheritedAcceptanceCandidate: readInheritedAcceptanceSource,
  readInheritedAcceptanceSource: readQualifiedInheritedAcceptance,
} = await import('./inherited-acceptance.js');
const { certifyingReview, openFindingAtHead, writeReviewClaimPackage } =
  await import('../run-engine/review-claim.test-support.js');
const { postPRComment } = await import('./pr-publication.js');

async function fixture(t: TestContext, requireFresh = false, noLedger = false) {
  existingComment = '';
  createdComments = 0;
  patchedComments = 0;
  refuseCommentWrite = false;
  const root = await mkdtemp(path.join(os.tmpdir(), 'parent-acceptance-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const childDir = path.join(root, 'child');
  const parentDir = path.join(root, 'parent');
  await mkdir(path.join(childDir, 'inputs'), { recursive: true });
  await mkdir(path.join(parentDir, 'artifacts'), { recursive: true });
  await writeFile(
    path.join(childDir, 'inputs/worker-terminal-contract.json'),
    JSON.stringify({
      schemaVersion: 1,
      flowType: 'pr-complete',
      acceptance: { requireFresh },
    }),
  );
  const raw = JSON.stringify({ schemaVersion: 2, recipeRunId: 'original-execution', criteria: [] });
  if (!noLedger) await writeFile(path.join(parentDir, 'artifacts/acceptance-status.json'), raw);
  parent = makeRun({
    id: randomUUID(),
    flowType: 'dev',
    status: 'done',
    project: 'example',
    taskFile: path.join(parentDir, 'TASK.md'),
    ticketOrPr: 'owner/repo#210',
    prNumber: 210,
  });
  await retainFixtureTask(root, parent, await runBundleStore(true));
  const prepared = makeReadyGatePackage({
    headSha: 'a'.repeat(40),
    evidenceManifest: noLedger
      ? []
      : [{ path: 'artifacts/acceptance-status.json', purpose: 'json', sha256: sha256Text(raw) }],
  });
  prepared.artifactBundle = parent.artifactBundle;
  prepared.packageHash = computeReadyGatePackageHash(prepared);
  const decision: RunDecision = {
    id: 'approved',
    type: 'engine_human_gate',
    title: 'Publish',
    description: '',
    actions: [],
    createdAt: '2026-10-16T00:00:00Z',
    resolvedAt: '2026-10-16T00:01:00Z',
    resolvedAction: 'approve-publish',
    payload: {
      kind: 'ready',
      prNumber: null,
      repo: 'owner/repo',
      diffStat: { files: 1, additions: 1, deletions: 0 },
      workerReport: 'Report',
      branch: 'change',
      prPackage: prepared,
    },
  };
  parent.decisions = [decision];
  parent.engineState = {
    publishGate: {
      approvedPackageHash: prepared.packageHash,
      publicationStatus: 'published_ready',
      prNumber: 210,
    },
  };
  const child = makeRun({
    id: randomUUID(),
    flowType: 'pr-complete',
    status: 'completing',
    parentRunId: parent.id,
    project: 'example',
    ticketOrPr: 'owner/repo#210',
    prNumber: 210,
    taskFile: path.join(childDir, 'TASK.md'),
    ticketData: {
      source: 'manual',
      title: 'Follow-up',
      description: '',
      affectedArea: '',
      stepsToReproduce: [],
      screenshots: [],
      labels: [],
      comments: [],
      acceptanceCriteria: noLedger ? [] : ['The parent criterion.'],
    },
  });
  await writeFile(
    path.join(childDir, 'inputs/handoff.json'),
    JSON.stringify({
      attemptId: child.id,
      project: child.project,
      flow: child.flowType,
      task: { acceptanceCriteria: child.ticketData!.acceptanceCriteria },
    }),
  );
  await retainFixtureTask(root, child, await runBundleStore(true));
  return { child, prepared, raw };
}

test('PR completion selects the approved original parent and records its head and ledger bytes', async (t) => {
  const f = await fixture(t);
  const proof = await readInheritedAcceptanceSource(f.child);
  assert.ok(proof);
  assert.equal(proof.run.id, parent!.id);
  assert.deepEqual(proof.provenance, {
    source: 'parent-run',
    parentRunId: parent!.id,
    headSha: 'a'.repeat(40),
    ledgerHash: sha256Text(f.raw),
  });
  assert.deepEqual(proof.run.artifactBundle, f.prepared.artifactBundle);
  assert.equal(parent!.decisions[0]!.payload?.kind, 'ready');
  parent!.status = 'ci-watching';
  assert.ok(
    await readInheritedAcceptanceSource(f.child),
    'CI follow-up dispatch may overlap the parent settling',
  );
});

test('a published parent whose package omits its retained ledger leaves fresh acceptance to the child', async (t) => {
  const f = await fixture(t);
  assert.ok(parent);
  f.prepared.evidenceManifest = [];
  f.prepared.packageHash = computeReadyGatePackageHash(f.prepared);
  const gate = parent.engineState?.publishGate;
  assert.ok(gate);
  gate.approvedPackageHash = f.prepared.packageHash;
  assert.equal(
    await readRetainedRunText(parent, ACCEPTANCE_STATUS_ARTIFACT, f.prepared.artifactBundle),
    f.raw,
  );
  assert.equal(await readInheritedAcceptanceSource(f.child), null);
  assert.equal(await readQualifiedInheritedAcceptance(f.child), null);
});

test('a no-criteria child with a ledger-free parent remains ready without inherited provenance', async (t) => {
  const f = await fixture(t, false, true);
  assert.equal(await readInheritedAcceptanceSource(f.child), null);
  const { collectRunGateReadiness } = await import('../run-engine/gate-prerequisites.js');
  const readiness = await collectRunGateReadiness(f.child, null, {
    deterministic: async () => {},
    progress: async () => ({ kind: 'idle' as const }),
  });
  assert.equal(readiness.state, 'ready', JSON.stringify(readiness.reasons));
});

test('ordinary completion matches normalized registration when a ticket has a blank middle criterion', async (t) => {
  const f = await fixture(t, false, true);
  f.child.flowType = 'dev';
  await writeFile(
    path.join(path.dirname(f.child.taskFile!), 'inputs/worker-terminal-contract.json'),
    JSON.stringify({ schemaVersion: 1, flowType: 'dev', mode: f.child.mode }),
  );
  delete f.child.parentRunId;
  f.child.ticketData!.acceptanceCriteria = ['First criterion', '   ', 'Second criterion'];
  const taskDir = path.dirname(f.child.taskFile!);
  await writeFile(
    path.join(taskDir, 'inputs/handoff.json'),
    JSON.stringify({
      attemptId: f.child.id,
      project: f.child.project,
      flow: f.child.flowType,
      task: { acceptanceCriteria: ['First criterion', 'Second criterion'] },
    }),
  );
  await retainFixtureTask(path.dirname(taskDir), f.child, await runBundleStore(true));
  const { readGateAcceptance } = await import('../run-engine/gate-prerequisites.js');
  const acceptance = await readGateAcceptance(f.child);
  assert.equal(acceptance.error, undefined);
  assert.deepEqual(acceptance.criteria, [
    { id: 'AC-1', text: 'First criterion' },
    { id: 'AC-2', text: 'Second criterion' },
  ]);
});

test('a ledger-free parent cannot block fresh child acceptance or supply provenance', async (t) => {
  const f = await fixture(t, false, true);
  f.child.ticketData!.acceptanceCriteria = ['The follow-up must prove this.'];
  assert.equal(await readInheritedAcceptanceSource(f.child), null);
});

test('a project requiring fresh proof keeps completion on the follow-up task', async (t) => {
  const f = await fixture(t, true);
  assert.equal(await readInheritedAcceptanceSource(f.child), null);
});

test('foreign projects, different PRs and unapproved parents cannot grant inheritance', async (t) => {
  const f = await fixture(t);
  for (const patch of [
    { project: 'another-project' },
    { ticketOrPr: 'owner/other#210' },
    { ticketOrPr: 'owner/repo#211' },
    { flowType: 'dev' as const },
  ])
    assert.equal(await readInheritedAcceptanceSource({ ...f.child, ...patch }), null);
  parent!.engineState = {};
  assert.equal(await readInheritedAcceptanceSource(f.child), null);
});

test('changed captured package metadata fails instead of silently granting parent acceptance', async (t) => {
  const f = await fixture(t);
  f.prepared.headSha = 'b'.repeat(40);
  await assert.rejects(readInheritedAcceptanceSource(f.child), /package.*changed|hash|digest/i);
});

test('the normal PR comment boundary appends inherited provenance after report rendering', async (t) => {
  const f = await fixture(t);
  const proof = await readInheritedAcceptanceSource(f.child);
  assert.ok(proof);
  posted = '';
  const temporaryComment = `/tmp/farmslot-pr-comment-${f.child.id.slice(0, 8)}.md`;
  t.after(() => rm(temporaryComment, { force: true }));
  assert.equal(
    await postPRComment(f.child, 'Follow-up work completed.', 'owner/repo', 210, {
      failOnError: true,
      inheritedAcceptance: proof.provenance,
    }),
    true,
  );
  assert.ok(posted.includes('Acceptance proof inherited from parent run'));
  for (const identity of [parent!.id, 'a'.repeat(40), sha256Text(f.raw)])
    assert.ok(posted.includes(identity));
  assert.ok(posted.includes('Follow-up work completed.'));
});

test('a provenance-only comment does not disclose the optional worker report or metrics', async (t) => {
  const f = await fixture(t);
  const proof = await readInheritedAcceptanceSource(f.child);
  assert.ok(proof);
  t.after(() => rm(`/tmp/farmslot-pr-comment-${f.child.id.slice(0, 8)}.md`, { force: true }));
  assert.equal(
    await postPRComment(f.child, null, 'owner/repo', 210, {
      failOnError: true,
      inheritedAcceptance: proof.provenance,
    }),
    true,
  );
  assert.ok(posted.includes(proof.provenance.ledgerHash));
  assert.ok(!posted.includes('Worker report'));
  assert.ok(!posted.includes('| Model |'));
});

test('replay adds missing provenance to the existing run comment once and preserves its content', async (t) => {
  const f = await fixture(t);
  const proof = await readInheritedAcceptanceSource(f.child);
  assert.ok(proof);
  t.after(() => rm(`/tmp/farmslot-pr-comment-${f.child.id.slice(0, 8)}.md`, { force: true }));
  existingComment = JSON.stringify({
    id: 777,
    body: `<!-- farmslot-run:${f.child.id} -->\nEarlier approved report with image https://example.test/proof.png`,
  });
  const options = { failOnError: true, inheritedAcceptance: proof.provenance };
  assert.equal(await postPRComment(f.child, null, 'owner/repo', 210, options), true);
  assert.ok(posted.includes('Earlier approved report with image https://example.test/proof.png'));
  assert.ok(posted.includes(proof.provenance.ledgerHash));
  assert.equal(await postPRComment(f.child, null, 'owner/repo', 210, options), true);
  assert.equal(patchedComments, 1);
  assert.equal(createdComments, 0);
});

test('a required provenance comment refuses a write failure instead of claiming publication', async (t) => {
  const f = await fixture(t);
  const proof = await readInheritedAcceptanceSource(f.child);
  assert.ok(proof);
  t.after(() => rm(`/tmp/farmslot-pr-comment-${f.child.id.slice(0, 8)}.md`, { force: true }));
  refuseCommentWrite = true;
  await assert.rejects(
    postPRComment(f.child, null, 'owner/repo', 210, { inheritedAcceptance: proof.provenance }),
    /permission denied/,
  );
});

test('an inherited review claim needs a clean code review at the approved parent head', async (t) => {
  const f = await fixture(t);
  const parentDir = path.dirname(parent!.taskFile!);
  await mkdir(path.join(parentDir, 'artifacts/proof'), { recursive: true });
  await mkdir(path.join(parentDir, 'inputs'), { recursive: true });
  const { claims, files } = await writeReviewClaimPackage(path.join(parentDir, 'artifacts/proof'));
  const criteria = claims.criteria.map(({ text }) => text);
  const ledger = JSON.stringify(claims);
  await writeFile(path.join(parentDir, 'artifacts/acceptance-status.json'), ledger);
  await writeFile(
    path.join(parentDir, 'inputs/handoff.json'),
    JSON.stringify({ task: { acceptanceCriteria: criteria } }),
  );
  await retainFixtureTask(path.dirname(parentDir), parent!, await runBundleStore(true));
  // The approved parent package freezes the ledger and the recorded proof.
  f.prepared.reviewPolicy = { minimumReviews: 1, requestedBy: 'dispatch' };
  f.prepared.evidenceManifest = [
    { path: 'artifacts/acceptance-status.json', purpose: 'json', sha256: sha256Text(ledger) },
    ...files.map(({ file, sha256 }) => ({
      path: `artifacts/proof/${file}`,
      purpose: 'evidence',
      sha256,
    })),
  ];
  f.prepared.artifactBundle = parent!.artifactBundle;
  f.prepared.packageHash = computeReadyGatePackageHash(f.prepared);
  f.child.ticketData!.acceptanceCriteria = criteria;
  const inherit = (reviews: ReturnType<typeof certifyingReview>[]) => {
    parent!.engineState = {
      publishGate: {
        approvedPackageHash: f.prepared.packageHash,
        publicationStatus: 'published_ready',
        prNumber: 210,
        reviews,
      },
    };
    return readQualifiedInheritedAcceptance(f.child);
  };
  const proof = await inherit([certifyingReview(f.prepared)]);
  assert.equal(
    proof?.acceptance.ledger?.criteria.find(({ id }) => id === 'AC-2')?.verdict,
    'proven',
  );
  assert.equal(await inherit([certifyingReview(f.prepared), openFindingAtHead(f.prepared)]), null);
  assert.equal(await inherit([]), null);
});
