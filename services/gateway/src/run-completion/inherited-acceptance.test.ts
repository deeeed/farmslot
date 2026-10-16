import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mock, test, type TestContext } from 'node:test';

import type { Run, RunDecision } from '@farmslot/protocol';

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
mock.module('../integrations/github-client.js', {
  namedExports: {
    ...github,
    ghRequest: async (args: string[]) => {
      if (args[0] === 'pr' && args[1] === 'comment') {
        posted = await readFile(args[args.indexOf('--body-file') + 1]!, 'utf8');
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
const { runBundleStore } = await import('./retained-artifacts.js');
const { computeReadyGatePackageHash, sha256Text } = await import('./ready-gate-package.js');
const { readInheritedAcceptanceSource } = await import('./inherited-acceptance.js');
const { postPRComment } = await import('./pr-publication.js');

async function fixture(t: TestContext, requireFresh = false) {
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
  await writeFile(path.join(parentDir, 'artifacts/acceptance-status.json'), raw);
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
    evidenceManifest: [
      { path: 'artifacts/acceptance-status.json', purpose: 'json', sha256: sha256Text(raw) },
    ],
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
      prNumber: 210,
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
  });
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
  assert.ok(posted.includes('Acceptance proof inherited from run'));
  for (const identity of [parent!.id, 'a'.repeat(40), sha256Text(f.raw)])
    assert.ok(posted.includes(identity));
  assert.ok(posted.includes('Follow-up work completed.'));
});
