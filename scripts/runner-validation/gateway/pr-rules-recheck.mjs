// Isolated production PR intake, GitHub HTTP fixture and real resource-change/RPC readback.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mock } from 'node:test';
import { isDeepStrictEqual } from 'node:util';

const [input, output, mode] = process.argv.slice(2);
assert(input && output, 'Pass an operator-store copy and a new private evidence directory');
const evidence = path.resolve(output);
await mkdir(path.dirname(evidence), { recursive: true });
await mkdir(evidence, { mode: 0o700 });
const raw = await readFile(input),
  copied = JSON.parse(raw);
const owner = copied.teams.find((team) => (team.ownerGeneration ?? 0) === 0)?.ownerId;
assert(owner, 'The copy needs one generation-zero team owner for a synthetic credential');
const fixture = await mkdtemp(path.join(os.tmpdir(), 'pr-recheck-rpc-'));
for (const key of Object.keys(process.env))
  if (
    key.startsWith('FARMSLOT_') ||
    key.startsWith('GATEWAY_') ||
    ['TMUX', 'TMUX_PANE', 'GH_TOKEN', 'GITHUB_TOKEN'].includes(key)
  )
    delete process.env[key];
Object.assign(process.env, {
  FARMSLOT_ROOT: fixture,
  FARMSLOT_HOME: path.join(fixture, 'home'),
  FARMSLOT_POOL_DIR: path.join(fixture, 'pool'),
  FARMSLOT_PROJECTS_DIR: path.join(fixture, 'projects'),
  FARMSLOT_RUNS_DIR: path.join(fixture, 'runs'),
  FARMSLOT_DISPATCH_QUEUE_FILE: path.join(fixture, 'queue.json'),
  FARMSLOT_DISABLE_ORCHESTRATION: '1',
  FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
  GATEWAY_HOST: '127.0.0.1',
  TMUX_TMPDIR: path.join(fixture, 'tmux'),
});
let connection, wss, server, githubFixture, service, monitors, disposeObservations;
try {
  for (const dir of ['home', 'pool', 'projects', 'runs', 'tmux', 'scripts', 'services/gateway'])
    await mkdir(path.join(fixture, dir), { recursive: true });
  await writeFile(path.join(fixture, 'CLAUDE.md'), '# Isolated PR recheck proof\n');
  await writeFile(path.join(fixture, 'scripts/dev.sh'), '#!/bin/sh\n');
  await writeFile(path.join(fixture, 'services/gateway/package.json'), '{}');
  await writeFile(path.join(fixture, '.pr-rules.json'), raw, { mode: 0o600 });
  const { Methods } = await import('../../../packages/protocol/src/index.ts');
  const { startGitHubFixture } =
    await import('../../../services/gateway/src/integrations/github-test-fixtures.ts');
  let head = 'a'.repeat(40);
  githubFixture = await startGitHubFixture((request) => {
    if (request.path === '/user') return { body: { login: 'fixture' } };
    if (request.path === '/graphql' && request.json?.variables?.id)
      return { body: { data: { node: { headRefOid: head, baseRefOid: 'c'.repeat(40) } } } };
    if (request.path === '/graphql')
      return {
        body: {
          data: {
            repository: {
              pullRequest: {
                id: 'PR_recheck_proof',
                number: 999999,
                title: 'Observation proof',
                state: 'OPEN',
                updatedAt: '2026-01-01T00:00:00Z',
                reviewDecision: null,
                viewerLatestReview: null,
                viewerLatestReviewRequest: { id: 'requested' },
                isDraft: false,
                headRefOid: head,
                baseRefOid: 'c'.repeat(40),
                baseRefName: 'main',
                headRefName: 'proof',
                author: { login: 'author' },
                repository: { nameWithOwner: 'fixture/recheck-proof' },
                labels: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
              },
            },
          },
        },
      };
    return { status: 404, body: { message: 'Unconfigured fixture endpoint' } };
  });
  process.env.FARMSLOT_GITHUB_API_URL = githubFixture.origin;
  process.env.FARMSLOT_GITHUB_FIXTURE_TOKEN = 'fixture-only';
  const { createGatewayAuthRuntime } =
    await import('../../../services/gateway/src/security/auth.ts');
  const { initPRMonitoring } = await import('../../../services/gateway/src/methods/pr-watch.ts');
  const { initPRRules } = await import('../../../services/gateway/src/methods/pr-rules.ts');
  const { runWithPrincipalOwner } =
    await import('../../../services/gateway/src/security/work-originator.ts');
  const { createWebSocketServer, initServerGlobals, disposeServerResourceObservations } =
    await import('../../../services/gateway/src/server.ts');
  const { registerGatewayStatusProcess } =
    await import('../../../services/gateway/src/projects/repo-root.ts');
  registerGatewayStatusProcess();
  const { GatewayClient } = await import('../../../packages/cli/src/gateway-client.ts');
  const auth = createGatewayAuthRuntime({ FARMSLOT_HOME: process.env.FARMSLOT_HOME });
  const principal = auth.writer.createPrincipal(
    { type: 'service', displayName: 'Private proof owner' },
    [{ role: 'admin', scope: { kind: 'global' } }],
    owner,
  );
  const token = auth.writer.issueCredential(principal.id, 'Private proof').secret;
  monitors = await initPRMonitoring(auth, () => {}, false);
  service = await initPRRules(auth, () => {}, false, monitors);
  server = createServer();
  wss = createWebSocketServer(server, auth);
  initServerGlobals();
  disposeObservations = disposeServerResourceObservations;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  connection = await new GatewayClient({
    url: `ws://127.0.0.1:${address.port}`,
    timeout: 15_000,
    credential: { token },
  }).connect();
  const { team } = await connection.call(Methods.PR_TEAM_SAVE, {
    config: {
      name: 'Quiet observation proof',
      account: { host: 'github.com', login: 'fixture' },
      sources: [{ kind: 'repository', repo: 'fixture/recheck-proof' }],
      predicate: { kind: 'compare', field: 'state', operator: 'equals', value: 'open' },
      repositories: [],
      githubTeams: [],
      notificationPrincipalIds: [],
    },
  });
  const request = {
    teamId: team.id,
    pr: { host: 'github.com', repo: 'fixture/recheck-proof', number: 999999 },
    autoStart: false,
    idempotencyKey: 'quiet-observation-proof',
    review: { mode: 'cold' },
    source: { client: 'proof', reference: 'quiet-observation', requester: 'fixture' },
  };
  const first = await connection.call('prReview.submit', { request });
  const settle = () =>
    runWithPrincipalOwner({ ownerId: owner }, () =>
      service.refreshSubmission(owner, first.submission.id),
    );
  const setup = await settle();
  assert(setup.intentId, `Proof source setup failed: ${setup.error}`);
  let measuring = false,
    notices = 0,
    payloadBytes = 0;
  const pending = [];
  const unsubscribe = connection.onEvent((frame) => {
    if (
      measuring &&
      frame.event === 'resource.changed' &&
      frame.payload?.changes?.some((change) => change.key.family === 'pr-automation')
    ) {
      notices++;
      pending.push(
        connection.call('prRules.list', {}).then((value) => {
          payloadBytes += Buffer.byteLength(JSON.stringify(value));
        }),
      );
    }
  });
  await connection.call('gateway.ping', {});
  const storeFile = path.join(fixture, '.pr-rules.json');
  const baseline = await readFile(storeFile),
    published = await connection.call('prRules.list', {});
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  measuring = true;
  for (let i = 0; i < 5; i++) {
    mock.timers.tick(30_000);
    await connection.call('prReview.submit', { request });
    await settle();
  }
  await connection.call('gateway.ping', {});
  await Promise.all(pending);
  measuring = false;
  const after = await readFile(storeFile),
    readback = await connection.call('prRules.list', {});
  if (mode === 'baseline') {
    assert(notices > 0);
    assert.notEqual(after.toString(), baseline.toString());
  } else {
    assert(
      isDeepStrictEqual(readback, published),
      'quiet rechecks must preserve the published RPC view',
    );
    assert.equal(notices, 0);
    assert.equal(payloadBytes, 0);
    assert(after.equals(baseline), 'quiet rechecks must preserve disk bytes');
  }
  const quiet = {
    notices,
    invalidationDrivenPayloadBytes: payloadBytes,
    publishedPayloadBytes: Buffer.byteLength(JSON.stringify(published)),
    unchangedDisk: after.equals(baseline),
  };
  head = 'b'.repeat(40);
  mock.timers.tick(60_000);
  measuring = true;
  await connection.call('prReview.submit', { request });
  await settle();
  await connection.call('gateway.ping', {});
  await Promise.all(pending);
  measuring = false;
  const changed = await connection.call('prReview.get', { id: first.submission.id });
  assert(changed.intent, `Changed observation failed: ${changed.submission.error}`);
  assert.equal(changed.intent.headSha, head);
  assert(notices > quiet.notices, 'new facts must notify and re-read');
  unsubscribe();
  const result = {
    mode: mode ?? 'candidate',
    inputBytes: raw.length,
    inputDigest: createHash('sha256').update(raw).digest('hex'),
    quiet,
    realHeadChangePublished: true,
    finalNotices: notices,
    finalPayloadBytes: payloadBytes,
    providerRequests: githubFixture.requests.length,
    protocolActions: [Methods.PR_TEAM_SAVE, 'prReview.submit', 'prRules.list', 'prReview.get'],
    boundary:
      'Production RPC/service/store with a supported GitHub HTTP fixture; only the isolated store changes',
    operatorWrites: 0,
  };
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
} finally {
  connection?.close();
  service?.stop();
  monitors?.stop();
  disposeObservations?.();
  mock.timers.reset();
  if (wss) {
    for (const socket of wss.clients) socket.terminate();
    await new Promise((resolve) => wss.close(resolve));
  }
  if (server?.listening)
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  await githubFixture?.close();
  await rm(fixture, { recursive: true, force: true });
  await writeFile(
    path.join(evidence, 'cleanup.json'),
    JSON.stringify({ removed: true, fixture }) + '\n',
  );
}
process.exit(0);
