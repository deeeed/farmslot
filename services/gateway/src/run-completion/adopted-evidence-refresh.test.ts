import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

import {
  type HumanPublicationAdoptionReceipt,
  Methods,
  PUBLICATION_ADOPTION_ACTION,
  type Run,
} from '@farmslot/protocol';

process.env.NODE_TEST_CONTEXT = '1';
await import('../runtime/mock-pty.test-support.js');
const config = await import('../core/config.js');
mock.module('../core/config.js', {
  namedExports: {
    ...config,
    loadProjectVars: async () => ({
      projectJson: { ci: { repo: 'owner/repo' }, artifacts_repo: 'owner/media' },
    }),
  },
});
const head = 'a'.repeat(40);
const oldHead = 'b'.repeat(40);
const original =
  'Human summary\r\n\r\n## **Screenshots/Recordings**\r\n![Human](https://example.com/human.png)\r\n[Relative](../guide.md)\r\n- [ ] Human checklist\r\n';
const initialPr = () => ({
  number: 193,
  url: 'https://github.com/owner/repo/pull/193',
  headRepository: { nameWithOwner: 'owner/repo' },
  body: original,
  title: 'Human title',
  headRefName: 'fix/fixture',
  headRefOid: head,
  state: 'MERGED',
});
let pr = initialPr();
let writes: string[] = [];
let uploads: string[][] = [];
let onUpload: (() => void | Promise<void>) | undefined;
const github = await import('../integrations/github-client.js');
mock.module('../integrations/github-client.js', {
  namedExports: {
    ...github,
    ghRequest: async (args: string[]) => {
      if (args[0] === 'api')
        return {
          stdout: JSON.stringify({
            number: pr.number,
            html_url: pr.url,
            state: 'closed',
            merged_at: new Date().toISOString(),
            draft: false,
            base: { repo: { full_name: 'owner/repo' } },
            head: { sha: pr.headRefOid, ref: pr.headRefName, repo: { full_name: 'owner/repo' } },
          }),
          stderr: '',
        };
      if (args[0] === 'pr' && args[1] === 'list') return { stdout: '[{"number":193}]', stderr: '' };
      if (args[0] === 'pr' && args[1] === 'view') return { stdout: JSON.stringify(pr), stderr: '' };
      if (args[0] === 'pr' && args[1] === 'edit') {
        pr.body = await readFile(args[args.indexOf('--body-file') + 1], 'utf8');
        writes.push(pr.body);
        return { stdout: '', stderr: '' };
      }
      throw new Error(`Unexpected GitHub operation: ${args.slice(0, 2).join(' ')}`);
    },
  },
});
const artifacts = await import('./publication-artifacts.js');
mock.module('./publication-artifacts.js', {
  namedExports: {
    ...artifacts,
    publishSelectedEvidence: async (
      _run: Run,
      _number: number,
      selection: { selectedEvidenceKeys: string[] },
    ) => {
      uploads.push(selection.selectedEvidenceKeys);
      await onUpload?.();
      return {
        selectedEvidenceKeys: selection.selectedEvidenceKeys,
        artifactUrls: new Map(
          selection.selectedEvidenceKeys.map((key) => [
            key,
            `https://example.com/${path.basename(key)}`,
          ]),
        ),
      };
    },
  },
});
const { refreshPublishedEvidence } = await import('./published-evidence-refresh.js');
const {
  createRun,
  commitRunPublication,
  getRun,
  updateRun,
  archiveRun,
  getRunWithArchived,
  runsDirectory,
} = await import('../runs/store.js');
const { makeReadyGatePackage, retainRunFixture, overwriteRetainedFixture, deleteTestRunIfPresent } =
  await import('../run-engine/test-fixtures.js');
const { sha256Text } = await import('./ready-gate-package.js');

async function fixture(t: test.TestContext, evidenceHead = head, withReceipt = true) {
  pr = initialPr();
  writes = [];
  uploads = [];
  onUpload = undefined;
  const root = await mkdtemp(path.join(os.tmpdir(), 'adopted-evidence-'));
  const run = createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: 'PROJ-193',
    branch: 'fix/fixture',
  });
  t.after(async () => {
    await deleteTestRunIfPresent(run.id);
    await rm(path.join(runsDirectory(), 'archive', `${run.id}.json`), { force: true });
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(path.join(root, 'artifacts'));
  const manifest = JSON.stringify({
    version: 1,
    standalone: ['approved', 'second', 'unselected'].map((label) => ({
      label,
      file: `${label}.png`,
    })),
  });
  await writeFile(path.join(root, 'artifacts/evidence-manifest.json'), manifest);
  for (const name of ['approved', 'second', 'unselected'])
    await writeFile(path.join(root, `artifacts/${name}.png`), name);
  const prepared = makeReadyGatePackage({
    headSha: evidenceHead,
    reviewPolicy: { minimumReviews: 1, requestedBy: 'dispatch' },
    packageInputHash: sha256Text('fixture-input'),
    selectedEvidenceKeys: ['artifacts/approved.png', 'artifacts/second.png'],
    evidenceManifest: [
      ...['approved', 'second', 'unselected'].map((name) => ({
        path: `artifacts/${name}.png`,
        purpose: 'screenshot',
        sha256: sha256Text(name),
      })),
      {
        path: 'artifacts/evidence-manifest.json',
        purpose: 'evidence-manifest',
        sha256: sha256Text(manifest),
      },
    ],
  });
  updateRun(run.id, {
    recordedEvidenceContractVersion: 0,
    status: withReceipt ? 'done' : 'failed',
    slotId: null,
    prNumber: 193,
    taskFile: path.join(root, 'TASK.md'),
    engineState: {
      generation: 0,
      publishGate: {
        packageId: prepared.id,
        packageHash: prepared.packageHash,
        publicationStatus: withReceipt ? 'published_ready' : 'not_published',
      },
    },
    decisions: [
      {
        id: 'gate',
        type: 'engine_human_gate',
        title: 'Publication',
        description: '',
        actions: [],
        createdAt: new Date().toISOString(),
        ...(withReceipt
          ? { resolvedAt: new Date().toISOString(), resolvedAction: PUBLICATION_ADOPTION_ACTION }
          : {}),
        payload: {
          kind: 'ready',
          prNumber: 193,
          repo: 'owner/repo',
          diffStat: { files: 0, additions: 0, deletions: 0 },
          workerReport: '',
          branch: 'fix/fixture',
          prPackage: prepared,
        },
      },
    ],
  });
  await retainRunFixture(getRun(run.id)!, prepared);
  const receipt: HumanPublicationAdoptionReceipt = {
    schemaVersion: 1,
    id: 'fixture-adoption',
    runId: run.id,
    generation: 0,
    approver: {
      principalId: 'fixture-person',
      credentialId: 'fixture-credential',
      displayName: 'Fixture reviewer',
    },
    reason: 'Fixture reviewed publication',
    adoptedAt: new Date().toISOString(),
    repository: 'owner/repo',
    prNumber: 193,
    prUrl: pr.url,
    headSha: head,
    observedHeadSha: head,
    observedBranch: 'fix/fixture',
    observedDraft: false,
    observedState: 'merged',
    publicationStatus: 'published_ready',
    priorGate: {
      decisionId: 'gate',
      packageId: prepared.id,
      packageHash: prepared.packageHash,
      headSha: evidenceHead,
      unmetPrerequisites: [],
    },
  };
  const ready = getRun(run.id)!;
  if (withReceipt)
    await commitRunPublication(run.id, (current) => ({
      prNumber: 193,
      links: current.links,
      prPublications: current.prPublications,
      publishGate: { ...ready.engineState?.publishGate, humanPublicationAdoption: receipt },
    }));
  return { run: getRun(run.id)!, prepared, receipt };
}

for (const historical of [false, true]) {
  test(`adopted evidence preserves human bytes and ${historical ? 'historical' : 'exact-head'} identity`, async (t) => {
    const f = await fixture(t, historical ? oldHead : head);
    const before = structuredClone(f.run);
    const result = await refreshPublishedEvidence({ runId: f.run.id }, () => {});
    assert.deepEqual(result.selectedEvidenceKeys, f.prepared.selectedEvidenceKeys);
    assert.ok(pr.body.startsWith(original));
    assert.ok(pr.body.includes(head));
    assert.ok(pr.body.includes(historical ? oldHead : head));
    assert.match(pr.body, /no new current-head claim/);
    assert.ok(!pr.body.includes('unselected.png'));
    const first = pr.body;
    await refreshPublishedEvidence({ runId: f.run.id }, () => {});
    assert.equal(pr.body, first, 'repeated delivery replaces one identical owned block');
    pr.body += '\nHuman follow-up [link](../other.md)\n';
    await refreshPublishedEvidence(
      { runId: f.run.id, selectedEvidenceKeys: ['artifacts/approved.png'] },
      () => {},
    );
    assert.ok(pr.body.startsWith(original));
    assert.ok(pr.body.endsWith('\nHuman follow-up [link](../other.md)\n'));
    assert.equal(pr.body.split(`<!-- farmslot-evidence:${f.run.id}:start -->`).length, 2);
    assert.ok(!pr.body.includes('second.png'));
    const current = getRun(f.run.id)!;
    assert.deepEqual(current.engineState, before.engineState);
    assert.deepEqual(
      current.decisions[0].payload?.kind === 'ready' && current.decisions[0].payload.prPackage,
      f.prepared,
    );
    assert.equal(current.status, 'done');
    assert.equal(result.bodyHash, sha256Text(first));
  });
}

for (const mutation of ['head', 'repository', 'branch', 'closed'] as const) {
  test(`adopted evidence refuses a foreign or advanced ${mutation} before upload`, async (t) => {
    const { run, receipt } = await fixture(t);
    if (mutation === 'head') {
      pr.headRefOid = oldHead;
      await commitRunPublication(run.id, (current) => ({
        prNumber: 193,
        links: current.links,
        prPublications: current.prPublications,
        publishGate: {
          ...current.engineState?.publishGate,
          humanPublicationAdoption: { ...receipt, observedHeadSha: oldHead },
        },
      }));
    }
    if (mutation === 'repository') pr.headRepository.nameWithOwner = 'foreign/repo';
    if (mutation === 'branch') pr.headRefName = 'foreign';
    if (mutation === 'closed') pr.state = 'CLOSED';
    await assert.rejects(
      refreshPublishedEvidence({ runId: run.id }, () => {}),
      /matches|match/,
    );
    assert.equal(uploads.length, 0);
    assert.equal(writes.length, 0);
  });
}

for (const mutation of ['body', 'head', 'generation', 'archive'] as const) {
  test(`adopted evidence refuses concurrent ${mutation} changes before editing`, async (t) => {
    const { run } = await fixture(t);
    onUpload = async () => {
      if (mutation === 'body') pr.body += '\nConcurrent human edit';
      if (mutation === 'head') pr.headRefOid = oldHead;
      if (mutation === 'generation')
        updateRun(run.id, { engineState: { ...run.engineState, generation: 1 } });
      if (mutation === 'archive') await archiveRun(run.id);
    };
    await assert.rejects(
      refreshPublishedEvidence({ runId: run.id }, () => {}),
      /changed|attested/,
    );
    assert.equal(writes.length, 0);
  });
}

test('edited or unproven markers refuse without replacing human content', async (t) => {
  const { run } = await fixture(t);
  const unproven = `<!-- farmslot-evidence:${run.id}:start -->\nHuman text\n<!-- farmslot-evidence:${run.id}:end -->`;
  pr.body += unproven;
  await assert.rejects(
    refreshPublishedEvidence({ runId: run.id }, () => {}),
    /no recorded delivery/,
  );
  assert.equal(writes.length, 0);
  pr.body = original;
  await refreshPublishedEvidence({ runId: run.id }, () => {});
  pr.body = pr.body.replace('## Farm evidence', '## Human edited evidence');
  const edited = pr.body;
  await assert.rejects(
    refreshPublishedEvidence({ runId: run.id }, () => {}),
    /edited/,
  );
  assert.equal(pr.body, edited);
  assert.equal(writes.length, 1);
});

test('unselected and corrupted frozen media refuse before upload', async (t) => {
  const { run } = await fixture(t);
  await assert.rejects(
    refreshPublishedEvidence(
      { runId: run.id, selectedEvidenceKeys: ['artifacts/unselected.png'] },
      () => {},
    ),
    /not approved/,
  );
  await overwriteRetainedFixture(run, 'artifacts/approved.png', 'changed');
  await assert.rejects(
    refreshPublishedEvidence({ runId: run.id }, () => {}),
    /mismatch|changed/,
  );
  assert.equal(uploads.length, 0);
  assert.equal(writes.length, 0);
});

test('archived delivery persists only description and never restores execution', async (t) => {
  const { run } = await fixture(t);
  await archiveRun(run.id);
  const file = path.join(runsDirectory(), 'archive', `${run.id}.json`);
  const before: Run = JSON.parse(await readFile(file, 'utf8'));
  const events: string[] = [];
  await refreshPublishedEvidence({ runId: run.id }, (event) => {
    events.push(event);
  });
  assert.deepEqual(events, [], 'historical delivery must not recreate a live run in clients');
  assert.equal(getRun(run.id), undefined);
  const after: Run = JSON.parse(await readFile(file, 'utf8'));
  const beforeReady = before.decisions[0].payload;
  const afterReady = after.decisions[0].payload;
  assert.ok(beforeReady?.kind === 'ready' && afterReady?.kind === 'ready');
  assert.equal(afterReady.currentDescription?.body, pr.body);
  delete afterReady.currentDescription;
  assert.deepEqual(after, before);
  assert.equal((await getRunWithArchived(run.id))?.archivedAt, before.archivedAt);
});

test('adoption cannot waive a missing frozen recipe contract or package identity', async (t) => {
  const f = await fixture(t);
  updateRun(f.run.id, { recordedEvidenceContractVersion: 1 });
  await assert.rejects(
    refreshPublishedEvidence({ runId: f.run.id }, () => {}),
    /frozen selected recipe/,
  );
  updateRun(f.run.id, { recordedEvidenceContractVersion: 0 });
  const { priorGate: _priorGate, ...withoutPackage } = f.receipt;
  await commitRunPublication(f.run.id, (run) => ({
    prNumber: 193,
    links: run.links,
    prPublications: run.prPublications,
    publishGate: { ...run.engineState?.publishGate, humanPublicationAdoption: withoutPackage },
  }));
  await assert.rejects(
    refreshPublishedEvidence({ runId: f.run.id }, () => {}),
    /recorded publication package/,
  );
  assert.equal(uploads.length, 0);
  assert.equal(writes.length, 0);
});

test('simultaneous refresh requests share the lifecycle owner and preserve one farm block', async (t) => {
  const { run } = await fixture(t);
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const uploading = new Promise<void>((resolve) => {
    entered = resolve;
  });
  onUpload = async () => {
    if (uploads.length === 1) {
      entered();
      await held;
    }
  };
  const first = refreshPublishedEvidence({ runId: run.id }, () => {});
  await Promise.race([uploading, first]);
  const second = refreshPublishedEvidence({ runId: run.id }, () => {});
  release();
  const results = await Promise.all([first, second]);
  assert.equal(results[0].bodyHash, results[1].bodyHash);
  assert.equal(pr.body.split(`<!-- farmslot-evidence:${run.id}:start -->`).length, 2);
  assert.equal(writes.length, 2);
});

const { createServer } = await import('node:http');
const { createGatewayAuthRuntime, initializeGatewayIdentity } = await import('../security/auth.js');
const { createWebSocketServer, resetServerGlobalsForTests } = await import('../server.js');
const { GatewayClient } = await import('../../../../packages/cli/src/gateway-client.js');

test('public RPC preserves historical task pointers and adopted generations in archived delivery', async (t) => {
  const f = await fixture(t, oldHead, false);
  const home = await mkdtemp(path.join(os.tmpdir(), 'adopted-evidence-rpc-'));
  const server = createServer();
  let wss: ReturnType<typeof createWebSocketServer> | undefined;
  t.after(async () => {
    try {
      if (wss) {
        for (const client of wss.clients) client.terminate();
        await new Promise<void>((resolve, reject) =>
          wss!.close((error) => (error ? reject(error) : resolve())),
        );
      }
    } finally {
      try {
        if (server.listening)
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
      } finally {
        resetServerGlobalsForTests();
        await rm(home, { recursive: true, force: true });
      }
    }
  });
  resetServerGlobalsForTests();
  const runtime = createGatewayAuthRuntime({
    FARMSLOT_HOME: home,
    FARMSLOT_GATEWAY_AUTH_MODE: 'none',
  });
  initializeGatewayIdentity(runtime, { host: '127.0.0.1' });
  const roles = [{ role: 'admin' as const, scope: { kind: 'global' as const } }];
  const person = runtime.writer.createPrincipal(
    { type: 'person', displayName: 'Fixture publication reviewer' },
    roles,
  );
  const service = runtime.writer.createPrincipal(
    { type: 'service', displayName: 'Fixture evidence operator' },
    roles,
  );
  const personCredential = runtime.writer.issueCredential(person.id, 'Fixture adoption credential');
  const serviceCredential = runtime.writer.issueCredential(
    service.id,
    'Fixture evidence credential',
  );
  wss = createWebSocketServer(server, runtime);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const personGrant = runtime.writer.exchangePersonCredential(personCredential.secret, {
    deviceName: 'Publication fixture',
    deviceKind: 'cli',
  });
  const personClient = new GatewayClient({
    url: `ws://127.0.0.1:${address.port}`,
    timeout: 2000,
    credential: { token: personGrant.accessToken },
  });
  const serviceClient = new GatewayClient({
    url: `ws://127.0.0.1:${address.port}`,
    timeout: 2000,
    credential: { token: serviceCredential.secret },
  });
  const adoption = await personClient.call<import('@farmslot/protocol').RunAdoptPublishedPrResult>(
    Methods.RUN_ADOPT_PUBLISHED_PR,
    {
      runId: f.run.id,
      prRef: pr.url,
      headSha: head,
      reason: 'Fixture exact-head reviewed publication',
      attestReviewedPublication: true,
    },
  );
  assert.equal(adoption.receipt.approver.principalId, person.id);
  assert.equal(adoption.run.status, 'failed');
  const replayedGeneration = adoption.receipt.generation + 1;
  const historicalTaskFile = 'temp/tasks/fixture/REVIEW-FIX.md';
  updateRun(f.run.id, {
    engineState: { ...adoption.run.engineState, generation: replayedGeneration },
    activeTaskFile: historicalTaskFile,
  });
  await assert.rejects(
    serviceClient.call(Methods.RUN_REFRESH_PUBLISHED_EVIDENCE, { runId: f.run.id }),
    /Wait for the published run to finish/,
  );
  assert.equal(uploads.length, 0);
  assert.equal(writes.length, 0);
  await archiveRun(f.run.id);
  const before = await getRunWithArchived(f.run.id);
  const delivered = await serviceClient.call<
    import('@farmslot/protocol').RunRefreshPublishedEvidenceResult
  >(Methods.RUN_REFRESH_PUBLISHED_EVIDENCE, { runId: f.run.id });
  assert.equal(delivered.bodyHash, sha256Text(pr.body));
  assert.ok(pr.body.startsWith(original));
  assert.ok(pr.body.includes(oldHead) && pr.body.includes(head));
  assert.equal(getRun(f.run.id), undefined);
  const after = await getRunWithArchived(f.run.id);
  assert.deepEqual(after?.engineState, before?.engineState);
  assert.equal(after?.engineState?.generation, replayedGeneration);
  assert.deepEqual(after?.engineState?.publishGate?.humanPublicationAdoption, adoption.receipt);
  assert.equal(after?.status, 'failed');
  assert.equal(after?.archivedAt, before?.archivedAt);
  assert.equal(after?.activeTaskFile, historicalTaskFile);
  assert.equal(writes.length, 1);
});
