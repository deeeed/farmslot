import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

import { Methods, type RunAdoptPublishedPrResult } from '@farmslot/protocol';

process.env.NODE_TEST_CONTEXT = '1';
await import('../../runtime/mock-pty.test-support.js');
let projectReadBarrier: (() => Promise<void>) | undefined;
const config = await import('../../core/config.js');
mock.module('../../core/config.js', {
  namedExports: {
    ...config,
    loadProjectVars: async () => {
      await projectReadBarrier?.();
      return { projectJson: { ci: { repo: 'owner/repo' } } };
    },
  },
});
const github = await import('../../integrations/github-client.js');
const reviewed = 'a'.repeat(40);
const observed = 'b'.repeat(40);
mock.module('../../integrations/github-client.js', {
  namedExports: {
    ...github,
    ghRequest: async (args: string[]) => ({
      stdout:
        args[0] === 'pr'
          ? '[{"number":192}]'
          : args.some((arg) => arg.endsWith('/commits'))
            ? `${reviewed}\n${observed}\n`
            : JSON.stringify({
                number: 192,
                html_url: 'https://github.com/owner/repo/pull/192',
                state: 'open',
                merged_at: null,
                draft: false,
                base: { repo: { full_name: 'owner/repo' } },
                head: { sha: observed, ref: 'fix/feature', repo: { full_name: 'owner/repo' } },
              }),
      stderr: '',
    }),
  },
});
const { createGatewayAuthRuntime, initializeGatewayIdentity } =
  await import('../../security/auth.js');
const { createWebSocketServer, resetServerGlobalsForTests } = await import('../../server.js');
const {
  archiveRun,
  createRun,
  getRun,
  getRunWithArchived,
  persistRunNow,
  runsDirectory,
  updateRun,
} = await import('../../runs/store.js');
const { deleteTestRunIfPresent, makeReadyGatePackage } =
  await import('../../run-engine/test-fixtures.js');
const { GatewayClient } = await import('../../../../../packages/cli/src/gateway-client.js');

test('production WebSocket route accepts only a fixture person, preserves archive and refuses unsafe active continuation', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'human-publication-rpc-'));
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
    { type: 'service', displayName: 'Fixture service' },
    roles,
  );
  const humanCredential = runtime.writer.issueCredential(
    person.id,
    'Fixture publication credential',
  );
  const serviceCredential = runtime.writer.issueCredential(
    service.id,
    'Fixture service credential',
  );
  const server = createServer();
  const wss = createWebSocketServer(server, runtime);
  t.after(async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve, reject) =>
      wss.close((error) => (error ? reject(error) : resolve())),
    );
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    resetServerGlobalsForTests();
    await rm(home, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const client = (secret: string) =>
    new GatewayClient({
      url: `ws://127.0.0.1:${address.port}`,
      timeout: 2000,
      credential: { token: secret },
    });
  const personGrant = runtime.writer.exchangePersonCredential(humanCredential.secret, {
    deviceName: 'Publication fixture',
    deviceKind: 'cli',
  });
  const personClient = client(personGrant.accessToken);
  const serviceClient = client(serviceCredential.secret);
  const archived = createRun({
    flowType: 'dev',
    project: 'fixture-project',
    ticketOrPr: 'PROJ-184',
    branch: 'fix/feature',
  });
  updateRun(archived.id, {
    status: 'cancelled',
    engineState: {
      generation: 2,
      publishGate: {
        packageId: 'original-package',
        packageHash: 'old-package',
        publicationStatus: 'not_published',
      },
    },
  });
  await persistRunNow(archived);
  await archiveRun(archived.id);
  const archive = path.join(runsDirectory(), 'archive', `${archived.id}.json`);
  t.after(() => rm(archive, { force: true }));
  const before = JSON.parse(await readFile(archive, 'utf8'));
  const params = {
    runId: archived.id,
    prRef: 'https://github.com/owner/repo/pull/192',
    headSha: reviewed,
    reason: 'Fixture exact-head review and human publication.',
    attestReviewedPublication: true,
  };
  await assert.rejects(
    serviceClient.call(Methods.RUN_ADOPT_PUBLISHED_PR, params),
    /active person device session/,
  );
  assert.deepEqual(JSON.parse(await readFile(archive, 'utf8')), before);
  const result = await personClient.call<RunAdoptPublishedPrResult>(
    Methods.RUN_ADOPT_PUBLISHED_PR,
    params,
  );
  assert.equal(result.archived, true);
  assert.equal(result.receipt.approver.principalId, person.id);
  assert.equal(result.receipt.approver.personSessionId, personGrant.session.id);
  assert.equal(result.receipt.approver.credentialId, undefined);
  assert.equal(result.receipt.headSha, reviewed);
  assert.equal(result.receipt.observedHeadSha, observed);
  assert.equal(getRun(archived.id), undefined);
  assert.equal(result.run.status, 'cancelled');
  assert.equal(result.run.engineState?.generation, 2);
  assert.deepEqual(result.run.decisions, before.decisions);
  assert.deepEqual(result.run.steps, before.steps);
  assert.equal(result.run.engineState?.publishGate?.packageHash, 'old-package');
  const retry = await personClient.call<RunAdoptPublishedPrResult>(
    Methods.RUN_ADOPT_PUBLISHED_PR,
    params,
  );
  assert.deepEqual(retry.receipt, result.receipt);
  assert.deepEqual(
    (await getRunWithArchived(archived.id))?.engineState?.publishGate?.humanPublicationAdoption,
    result.receipt,
  );

  const active = createRun({
    flowType: 'fix-bug',
    project: 'fixture-project',
    ticketOrPr: 'PROJ-185',
    branch: 'fix/feature',
  });
  t.after(() => deleteTestRunIfPresent(active.id));
  const prepared = makeReadyGatePackage({ headSha: 'c'.repeat(40) });
  updateRun(active.id, {
    status: 'blocked',
    engineState: {
      generation: 2,
      publishGate: {
        packageId: prepared.id,
        packageHash: prepared.packageHash,
        publicationStatus: 'not_published',
      },
    },
    decisions: [
      {
        id: 'publication',
        type: 'engine_human_gate',
        title: 'Publish',
        description: '',
        createdAt: new Date().toISOString(),
        actions: [{ id: 'approve-publish', label: 'Publish', style: 'primary' }],
        payload: {
          kind: 'ready',
          prNumber: null,
          repo: 'owner/repo',
          branch: 'fix/feature',
          diffStat: { files: 0, additions: 0, deletions: 0 },
          workerReport: '',
          prPackage: prepared,
        },
      },
    ],
  });
  const activeResult = await personClient.call<RunAdoptPublishedPrResult>(
    Methods.RUN_ADOPT_PUBLISHED_PR,
    { ...params, runId: active.id },
  );
  assert.equal(activeResult.continuation, 'refused');
  assert.ok(
    activeResult.refusals.some((reason) => reason.code === 'publication-continuation-not-owner'),
  );
  assert.equal(activeResult.run.decisions[0].resolvedAction, 'superseded-by-publication-adoption');
  assert.equal(activeResult.run.status, 'blocked');
  runtime.writer.revokeCredential(humanCredential.record.id);
  await assert.rejects(
    personClient.call(Methods.RUN_ADOPT_PUBLISHED_PR, params),
    /authentication|Authenticate|Denied/,
  );
});

test('in-flight package preparation holds the lifecycle owner until its final package write', async (t) => {
  const { prepareCompletionPackage } = await import('../../run-completion/orchestrator.js');
  const { runAdoptPublishedPr } = await import('./adopt-published-pr.js');
  const run = createRun({
    flowType: 'dev',
    project: 'fixture-project',
    ticketOrPr: 'PROJ-186',
    branch: 'fix/feature',
  });
  const task = await mkdtemp(path.join(os.tmpdir(), 'publication-package-race-'));
  t.after(async () => {
    await deleteTestRunIfPresent(run.id);
    await rm(task, { recursive: true, force: true });
  });
  await mkdir(path.join(task, 'artifacts'));
  await writeFile(path.join(task, 'TASK.md'), '# Fixture publication task\n');
  await writeFile(
    path.join(task, 'artifacts/pr-description.md'),
    '## Summary\nFixture publication proof.\n',
  );

  updateRun(run.id, {
    status: 'blocked',
    taskFile: path.join(task, 'TASK.md'),
    engineState: {
      generation: 2,
      publishGate: {
        packageId: 'original-package',
        packageHash: 'old-package',
        publicationStatus: 'not_published',
      },
    },
  });
  let entered!: () => void;
  let release!: () => void;
  let verified!: () => void;
  const reading = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const verifying = new Promise<void>((resolve) => {
    verified = resolve;
  });
  projectReadBarrier = async () => {
    entered();
    await barrier;
  };
  t.after(() => {
    release();
    projectReadBarrier = undefined;
  });
  const preparation = prepareCompletionPackage(run.id, { headSha: 'c'.repeat(40) });
  await reading;
  const adoption = runAdoptPublishedPr(
    {
      runId: run.id,
      prRef: 'https://github.com/owner/repo/pull/192',
      headSha: reviewed,
      reason: 'Fixture reviewed publication',
      attestReviewedPublication: true,
    },
    () => {},
    {
      authorizeEvidenceAttestation: () => ({
        principalId: 'fixture-person',
        credentialId: 'fixture-credential',
        displayName: 'Fixture person',
      }),
      repository: async () => 'owner/repo',
      discover: async () => {
        verified();
        return 192;
      },
    },
  );
  const settledAdoption = Promise.allSettled([adoption]);
  await verifying;
  assert.equal(run.engineState?.publishGate?.humanPublicationAdoption, undefined);
  release();
  const prepared = await preparation;
  const [stale] = await settledAdoption;
  assert.equal(stale.status, 'rejected');
  if (stale.status === 'rejected')
    assert.match(stale.reason.message, /changed during verification/);
  assert.equal(run.engineState?.publishGate?.packageHash, prepared.prPackage.packageHash);
  assert.equal(run.engineState?.publishGate?.publicationStatus, 'not_published');
});
