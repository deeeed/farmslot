// Manual protocol proof. Every identity and credential belongs to an isolated home.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = await mkdtemp(join(tmpdir(), 'identity-credentials-proof-'));
let cleanupServer: (() => Promise<void>) | undefined;
let releasePresence: (() => void) | undefined;
try {
  process.env.FARMSLOT_HOME = join(scratch, 'home');
  process.env.FARMSLOT_ROOT = scratch;
  await mkdir(join(scratch, 'projects', 'proof'), { recursive: true });
  await writeFile(
    join(scratch, 'projects', 'proof', 'project.json'),
    JSON.stringify({
      name: 'proof',
      qa: {
        default_profile: 'changes',
        profiles: [{ id: 'changes', title: 'Changes', template_id: 'validation/shared' }],
      },
    }),
  );
  for (const marker of ['CLAUDE.md', 'scripts/dev.sh', 'services/gateway/package.json']) {
    const file = join(scratch, marker);
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, marker.endsWith('json') ? '{}' : '');
  }
  await mkdir(join(scratch, 'bin'), { recursive: true });
  await writeFile(join(scratch, 'bin', 'tmux'), '#!/bin/sh\nexit 77\n', { mode: 0o700 });
  await writeFile(
    join(scratch, 'bin', 'gh'),
    `#!${process.execPath}\n${await readFile(new URL('./identity-pr-upstream.mjs', import.meta.url), 'utf8')}`,
    { mode: 0o700 },
  );
  process.env.PATH = `${join(scratch, 'bin')}:${process.env.PATH}`;
  process.env.GATEWAY_HOST = '127.0.0.1';
  // A synthetic obsolete value must neither create identity nor authenticate.
  process.env.FARMSLOT_GATEWAY_TOKEN = 'obsolete-proof-value';
  delete process.env.FARMSLOT_GATEWAY_PASSWORD;

  const {
    CredentialStoreRuntime,
    CredentialStoreWriter,
    registerGatewayPresence,
    retirePrincipalsOffline,
  } = await import('@farmslot/credential-store');
  const { GatewayClient } = await import('../../packages/cli/src/gateway-client.js');
  const { createGatewayAuthRuntime, initializeGatewayIdentity, authorizeHttpRequest } =
    await import('../../services/gateway/src/security/auth.js');
  await writeFile(
    join(scratch, '.farm-status.json'),
    JSON.stringify({
      checkedAt: new Date().toISOString(),
      slots: [],
      summary: {
        total: 0,
        ready: 0,
        busy: 0,
        held: 0,
        manual: 0,
        disabled: 0,
        blocked: 0,
        warmCount: 0,
      },
    }),
  );
  const { createWebSocketServer } = await import('../../services/gateway/src/server.js');
  const { queueRecordOriginator, persistQueueNow, loadQueue } =
    await import('../../services/gateway/src/backlog/dispatch-queue.js');
  const { resolveWorkOriginator, runWithPrincipalOwner } =
    await import('../../services/gateway/src/security/work-originator.js');
  const { authorizeStoredRunEffect } =
    await import('../../services/gateway/src/security/authorization.js');

  const store = new CredentialStoreRuntime();
  const writer = new CredentialStoreWriter(store, true);
  writer.createPrincipal({ type: 'service', displayName: 'farm-automation' }, [
    { role: 'admin', scope: { kind: 'global' } },
  ]);
  const admin = writer.issueCredential('farm-automation', 'test-automation');
  const paired = writer.issueCredential('farm-automation', 'test-paired-device', 'paired');
  const revoked = writer.issueCredential('farm-automation', 'test-revoked-legacy');
  writer.revokeCredential(revoked.record.id);
  const expectedStore = structuredClone(store.snapshot());
  const historicalStore = {
    ...expectedStore,
    credentials: expectedStore.credentials.map((record) => ({
      ...record,
      origin:
        record.id === admin.record.id || record.id === revoked.record.id
          ? 'env-migrated'
          : record.origin,
    })),
  };
  await writeFile(store.path, JSON.stringify(historicalStore));
  const runtime = createGatewayAuthRuntime();
  assert.deepEqual(runtime.store.snapshot(), expectedStore);
  assert.deepEqual(JSON.parse(await readFile(store.path, 'utf8')), expectedStore);
  const migratedBytes = await readFile(store.path);
  const migratedStamp = await stat(store.path);
  createGatewayAuthRuntime();
  assert.deepEqual(await readFile(store.path), migratedBytes);
  assert.equal((await stat(store.path)).ino, migratedStamp.ino);
  assert.equal((await stat(store.path)).mtimeMs, migratedStamp.mtimeMs);
  initializeGatewayIdentity(runtime, { host: '127.0.0.1' });
  const { Methods } = await import('@farmslot/protocol');
  const { initPRMonitoring } = await import('../../services/gateway/src/methods/pr-watch.js');
  const { initPRRules } = await import('../../services/gateway/src/methods/pr-rules.js');
  const { initPRPush } = await import('../../services/gateway/src/methods/pr-push.js');
  const { broadcastPrincipalEvent } = await import('../../services/gateway/src/server.js');
  const monitoring = await initPRMonitoring(runtime, broadcastPrincipalEvent, false);
  const rules = await initPRRules(runtime, broadcastPrincipalEvent, false, monitoring);
  await initPRPush(runtime, monitoring, rules, false, broadcastPrincipalEvent);

  const httpServer = createServer((req, res) => {
    if (authorizeHttpRequest({ runtime, req, res, resource: 'file' })) {
      res.writeHead(204);
      res.end();
    }
  });
  const wss = createWebSocketServer(httpServer, runtime);
  cleanupServer = async () => {
    for (const connection of wss.clients) connection.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    if (httpServer.listening)
      await new Promise<void>((resolve, reject) =>
        httpServer.close((error) => (error ? reject(error) : resolve())),
      );
  };
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  assert.ok(address && typeof address !== 'string');
  const url = `ws://127.0.0.1:${address.port}`;
  releasePresence = registerGatewayPresence({
    pid: process.pid,
    farmslotRoot: scratch,
    port: address.port,
  });
  const client = new GatewayClient({ url, timeout: 5000, credential: { token: admin.secret } });
  const claims: string[] = [
    'historical origins migrate at boot with every other field preserved; repeat boot does not rewrite',
  ];
  const pairedClient = new GatewayClient({
    url,
    timeout: 5000,
    credential: { token: paired.secret },
  });
  await pairedClient.call('principal.list', {});
  const revokedClient = new GatewayClient({
    url,
    timeout: 5000,
    credential: { token: revoked.secret },
  });
  await assert.rejects(revokedClient.call('principal.list', {}));
  const rawHistorical = new GatewayClient({
    url,
    timeout: 5000,
    credential: { token: admin.secret.slice(admin.secret.indexOf('_', 3) + 1) },
  });
  await assert.rejects(rawHistorical.call('principal.list', {}));
  claims.push(
    'paired device credential survives; migrated revocations and raw-secret denial remain enforced',
  );
  const started = performance.now();

  const listed = await client.call<{ principals: Array<{ id: string }> }>('principal.list', {});
  assert.deepEqual(
    listed.principals.map((principal) => principal.id),
    ['farm-automation'],
  );
  claims.push('environment value creates no identity');
  await assert.rejects(
    client.call('run.adoptPublishedPr', {
      runId: 'absent-proof-run',
      prRef: 'https://github.com/example/proof/pull/1',
      headSha: 'a'.repeat(40),
      attestReviewedPublication: true,
      reason: 'service must not attest',
    }),
    { code: 'AUTH_FORBIDDEN' },
  );
  claims.push('service admin cannot attest to publication');
  const raw = new GatewayClient({
    url,
    timeout: 5000,
    credential: { token: 'obsolete-proof-value' },
  });
  await assert.rejects(raw.call('principal.list', {}));
  claims.push('raw environment-secret presentation denied');
  const missing = new GatewayClient({ url, timeout: 5000 });
  await assert.rejects(missing.call('principal.list', {}));
  claims.push('uncredentialed client does not discover environment secrets');

  const created = await client.call<{ principal: { id: string } }>('principal.create', {
    subject: { type: 'node', displayName: 'proof-node', machine: 'proof-machine' },
    roles: [],
  });
  const issued = await client.call<{ credential: { id: string }; secret: string }>(
    'credential.issue',
    {
      principalId: created.principal.id,
      displayName: 'proof-machine',
    },
  );
  const node = new GatewayClient({ url, timeout: 5000, credential: { token: issued.secret } });
  await assert.rejects(node.call('principal.list', {}), { code: 'AUTH_FORBIDDEN' });
  await assert.rejects(
    node.call('principal.reuseRetiredId', {
      principalId: 'absent-proof-id',
      subject: { type: 'person', displayName: 'replacement' },
      roles: [],
    }),
    { code: 'AUTH_FORBIDDEN' },
  );
  const deniedHttp = await fetch(`http://127.0.0.1:${address.port}/api/file`, {
    headers: { Authorization: `Bearer ${issued.secret}` },
  });
  assert.equal(deniedHttp.status, 403);
  claims.push('node credential cannot use person/service RPCs or HTTP files');
  await assert.rejects(client.call('principal.retire', { principalIds: [created.principal.id] }));
  claims.push('active credential prevents retirement');
  await client.call('credential.revoke', { credentialId: issued.credential.id });
  const retired = await client.call('principal.retire', { principalIds: [created.principal.id] });
  assert.deepEqual(retired, {
    principalIds: [created.principal.id],
    credentialIds: [issued.credential.id],
  });
  await assert.rejects(node.call('principal.list', {}));
  const replacement = await client.call<{ principal: { id: string } }>('principal.create', {
    subject: { type: 'node', displayName: 'proof-node', machine: 'proof-machine' },
    roles: [],
  });
  assert.notEqual(replacement.principal.id, created.principal.id);
  assert.ok(runtime.store.snapshot().activatedAt);
  claims.push('revocation and retirement take effect; ids and activation remain reserved');
  const obsolete = await client.call<{ principal: { id: string } }>('principal.create', {
    subject: { type: 'service', displayName: 'replacement-person' },
    roles: [{ role: 'admin', scope: { kind: 'global' } }],
  });
  const oldCredential = await client.call<{ credential: { id: string }; secret: string }>(
    'credential.issue',
    { principalId: obsolete.principal.id, displayName: 'obsolete service device' },
  );
  const oldClient = new GatewayClient({
    url,
    timeout: 5000,
    credential: { token: oldCredential.secret },
  });
  await oldClient.call('principal.list', {});
  const monitorConfig = {
    pr: { host: 'github.com', repo: 'example/proof', number: 1 },
    account: { host: 'github.com', login: 'reader' },
    policy: { mode: 'notify-only' },
    pollIntervalMs: 60_000,
    watchedChecks: [],
    automaticAttemptLimit: 1,
    cooldownMs: 60_000,
  };
  const teamConfig = {
    name: 'Proof team',
    account: monitorConfig.account,
    sources: [{ kind: 'repository', repo: 'example/proof' }],
    predicate: { kind: 'compare', field: 'state', operator: 'equals', value: 'open' },
    repositories: [
      { repo: 'example/proof', project: 'proof', reviewProfile: 'standard', excludedLabels: [] },
    ],
    githubTeams: [],
    notificationPrincipalIds: [],
  };
  const oldMonitor = await oldClient.call<{ monitor: { id: string; revision: number } }>(
    Methods.PR_WATCH_SUBSCRIBE,
    { config: monitorConfig },
  );
  const oldTeam = await oldClient.call<{ team: { id: string; revision: number } }>(
    Methods.PR_TEAM_SAVE,
    { config: teamConfig },
  );
  const pushConfig = {
    installationId: 'phone',
    profileId: 'proof',
    platform: 'ios',
    token: 'ExpoPushToken[old]',
    enabled: true,
    sound: false,
  };
  await oldClient.call(Methods.PR_PUSH_REGISTER, pushConfig);

  const staleInvitation = await client.call<{ code: string }>('pairing.create', {
    gatewayUrl: url,
    authority: { kind: 'existing-principal', principalId: obsolete.principal.id },
  });
  const queueParams = {
    flowType: 'dev',
    project: 'proof',
    ticketOrPr: 'MANUAL-000001',
    autoDispatch: false,
  };
  const oldQueue = await oldClient.call<{ item: { id: string } }>(
    'dispatch.queue.add',
    queueParams,
  );
  await persistQueueNow();
  const oldOriginator = queueRecordOriginator(oldQueue.item.id);
  assert.equal(
    authorizeStoredRunEffect(
      resolveWorkOriginator(runtime, oldOriginator),
      'old proof work',
      undefined,
    ).id,
    obsolete.principal.id,
  );
  await client.call('credential.revoke', { credentialId: oldCredential.credential.id });
  await client.call('principal.retire', { principalIds: [obsolete.principal.id] });
  const beforeReuse = structuredClone(runtime.store.snapshot());
  const reuseParams = {
    principalId: obsolete.principal.id,
    subject: { type: 'person', displayName: 'Replacement person' },
    roles: [{ role: 'admin', scope: { kind: 'global' } }],
  };
  assert.throws(
    () =>
      runtime.writer.createPrincipal(
        reuseParams.subject as { type: 'person'; displayName: string },
        [],
        obsolete.principal.id,
      ),
    /has been retired/,
  );
  const reused = await client.call<{ principal: { id: string; subject: { type: string } } }>(
    'principal.reuseRetiredId',
    reuseParams,
  );
  assert.equal(reused.principal.id, obsolete.principal.id);
  assert.equal(reused.principal.subject.type, 'person');
  const afterReuse = runtime.store.snapshot();
  assert.deepEqual(afterReuse.credentials, beforeReuse.credentials);
  assert.deepEqual(afterReuse.retiredCredentialIds, beforeReuse.retiredCredentialIds);
  assert.ok(afterReuse.retiredPrincipalIds?.includes(created.principal.id));
  assert.equal(afterReuse.principalIdReuses?.at(-1)?.principalId, obsolete.principal.id);
  assert.deepEqual(
    new CredentialStoreRuntime().snapshot().principalIdReuses,
    afterReuse.principalIdReuses,
  );
  assert.equal(resolveWorkOriginator(runtime, oldOriginator), null);
  assert.throws(
    () =>
      authorizeStoredRunEffect(
        resolveWorkOriginator(runtime, oldOriginator),
        'retired proof work',
        undefined,
      ),
    /cannot be resolved/,
  );
  await assert.rejects(oldClient.call('principal.list', {}));
  // Persons sign in through person-device sessions, from a pairing code or a credential.
  const personClient = async (
    exchange: { code: string } | { credential: string },
    deviceName: string,
  ) => {
    const grant = await client.call<{ accessToken: string }>(Methods.AUTH_SESSION_EXCHANGE, {
      ...exchange,
      deviceName,
      deviceKind: 'cli',
    });
    return new GatewayClient({ url, timeout: 5000, credential: { token: grant.accessToken } });
  };
  const beforeStaleExchange = await readFile(runtime.store.path);
  await assert.rejects(personClient({ code: staleInvitation.code }, 'stale invitation'), {
    code: 'PAIRING_FAILED',
  });
  assert.deepEqual(await readFile(runtime.store.path), beforeStaleExchange);
  const freshInvitation = await client.call<{ code: string }>('pairing.create', {
    gatewayUrl: url,
    authority: { kind: 'existing-principal', principalId: reused.principal.id },
  });
  const replacementPairedClient = await personClient(
    { code: freshInvitation.code },
    'replacement pairing',
  );
  await replacementPairedClient.call('principal.list', {});
  claims.push(
    'an old pairing invitation fails after reuse without a store write; a new invitation authenticates as the replacement',
  );
  const fresh = await client.call<{ credential: { id: string }; secret: string }>(
    'credential.issue',
    {
      principalId: reused.principal.id,
      displayName: 'replacement person device',
    },
  );
  assert.notEqual(fresh.credential.id, oldCredential.credential.id);
  const freshClient = await personClient({ credential: fresh.secret }, 'replacement person device');
  await freshClient.call('principal.list', {});
  assert.equal(
    (await freshClient.call<{ devices: unknown[] }>(Methods.PR_PUSH_LIST, {})).devices.length,
    0,
  );
  await freshClient.call(Methods.PR_PUSH_REGISTER, pushConfig);
  assert.equal(
    (await freshClient.call<{ devices: unknown[] }>(Methods.PR_PUSH_LIST, {})).devices.length,
    1,
  );
  const beforeMonitors = await freshClient.call<{ monitors: unknown[] }>(Methods.PR_WATCH_LIST, {});
  assert.equal(beforeMonitors.monitors.length, 0);
  await assert.rejects(freshClient.call(Methods.PR_WATCH_GET, { id: oldMonitor.monitor.id }));
  await assert.rejects(
    freshClient.call(Methods.PR_TEAM_SAVE, {
      id: oldTeam.team.id,
      revision: oldTeam.team.revision,
      config: teamConfig,
    }),
  );
  const freshMonitor = await freshClient.call<{ monitor: { id: string; ownerGeneration: number } }>(
    Methods.PR_WATCH_SUBSCRIBE,
    { config: monitorConfig },
  );
  assert.notEqual(freshMonitor.monitor.id, oldMonitor.monitor.id);
  assert.equal(freshMonitor.monitor.ownerGeneration, 1);
  const freshTeam = await freshClient.call<{ team: { id: string; ownerGeneration: number } }>(
    Methods.PR_TEAM_SAVE,
    { config: teamConfig },
  );
  assert.equal(freshTeam.team.ownerGeneration, 1);
  const freshRule = await freshClient.call<{
    rule: { id: string; revision: number; ownerGeneration: number };
  }>(Methods.PR_RULE_SAVE, {
    config: {
      name: 'Proof notification',
      teamId: freshTeam.team.id,
      predicate: teamConfig.predicate,
      actions: [{ kind: 'notify' }],
      pollIntervalMs: 60_000,
      maxAdmissionsPerScan: 1,
      rereviewOnHeadChange: false,
    },
  });
  assert.equal(freshRule.rule.ownerGeneration, 1);
  await freshClient.call(Methods.PR_RULE_SET_ENABLED, {
    id: freshRule.rule.id,
    revision: freshRule.rule.revision,
    enabled: true,
    backfill: true,
  });
  const oldObservation = monitoring.store
    .snapshot()
    .monitors.find((m) => m.id === oldMonitor.monitor.id)?.observation;
  const previousRuleCheck = rules.store.snapshot().rules.find((r) => r.id === freshRule.rule.id)
    ?.scan.checkedAt;
  await monitoring.tick(Date.now() + 60_001);
  await rules.tick(Date.now() + 60_001);
  assert.notEqual(
    rules.store.snapshot().rules.find((r) => r.id === freshRule.rule.id)?.scan.checkedAt,
    previousRuleCheck,
    'background rule tick must persist a new observation under its stored generation',
  );
  const afterMonitors = await freshClient.call<{
    monitors: Array<{ id: string; observation?: unknown; observationError?: string }>;
  }>(Methods.PR_WATCH_LIST, {});
  assert.deepEqual(
    afterMonitors.monitors.map((m) => m.id),
    [freshMonitor.monitor.id],
  );
  assert.equal(afterMonitors.monitors[0].observationError, undefined);
  assert.ok(afterMonitors.monitors[0].observation);
  assert.deepEqual(
    monitoring.store.snapshot().monitors.find((m) => m.id === oldMonitor.monitor.id)?.observation,
    oldObservation,
  );
  const ruleState = await freshClient.call<{
    actions: Array<{ ownerGeneration: number }>;
    notifications: unknown[];
  }>(Methods.PR_RULES_LIST, {});
  assert.equal(
    rules.store.snapshot().rules.find((r) => r.id === freshRule.rule.id)?.scan.error,
    undefined,
  );
  assert.equal(ruleState.actions.length, 1);
  assert.equal(ruleState.actions[0].ownerGeneration, 1);
  assert.equal(ruleState.notifications.length, 1);
  claims.push(
    'fresh PR push reuses the same phone installation and token; monitors, teams and rules work for the replacement; background collectors retain generation one and old records stay isolated',
  );

  // Seed completed static reviews as setup. All ownership decisions use the public QA RPC.
  // A replacement cannot create a static review it owns (its direct requests are
  // delegated to the generation-zero native owner), so the generation-one record
  // only exercises the source-review generation backstop.
  const { createRun } = await import('../../services/gateway/src/runs/store.js');
  const sourceReviews = [undefined, 1].map((generation) => {
    const run = createRun(
      { flowType: 'review-pr', project: 'proof', ticketOrPr: 'example/proof#1' },
      {
        deferBackgroundPersist: true,
        createdByPrincipalId: obsolete.principal.id,
        createdByPrincipalGeneration: generation,
      },
    );
    run.status = 'done';
    run.nativeOwnerPrincipalId = obsolete.principal.id;
    if (generation === undefined) delete run.createdByPrincipalId;
    run.reviewResult = {
      recommendation: 'REQUEST_CHANGES',
      reviewMd: 'Confirmed isolated static review',
      lineComments: [],
      reviewSnapshot: {
        source: 'github-pr',
        headSha: 'a'.repeat(40),
        capturedAt: new Date().toISOString(),
      },
    };
    return run;
  });
  const qaRequest = {
    teamId: freshTeam.team.id,
    pr: monitorConfig.pr,
    autoStart: false,
    review: { mode: 'cold', workflow: 'qa' },
    source: { client: 'identity-proof' },
  };
  await assert.rejects(
    freshClient.call(Methods.PR_REVIEW_REQUEST, {
      request: {
        ...qaRequest,
        sourceReviewRunId: sourceReviews[0].id,
        idempotencyKey: 'old-source',
      },
    }),
    /not owned by this principal/,
  );
  const freshSubmission = await freshClient.call<{
    submission: { id: string; ownerGeneration: number };
  }>(Methods.PR_REVIEW_REQUEST, {
    request: {
      ...qaRequest,
      sourceReviewRunId: sourceReviews[1].id,
      idempotencyKey: 'fresh-source',
    },
  });
  assert.equal(freshSubmission.submission.ownerGeneration, 1);
  await runWithPrincipalOwner({ ownerId: obsolete.principal.id, ownerGeneration: 1 }, () =>
    rules.refreshSubmission(obsolete.principal.id, freshSubmission.submission.id),
  );
  const refreshedSubmission = await freshClient.call<{
    submission: { error?: string; intentId?: string };
  }>(Methods.PR_REVIEW_REQUEST_GET, { id: freshSubmission.submission.id });
  assert.equal(refreshedSubmission.submission.error, undefined);
  const qaIntent = rules.store.intent(refreshedSubmission.submission.intentId!);
  assert.equal(qaIntent?.contributions[0].ownerGeneration, 1);
  claims.push(
    'public linked QA refuses native-only legacy reviews; its source-review backstop admits only a seeded record of the same generation, with matching persisted contributions',
  );

  const newQueue = await freshClient.call<{ item: { id: string } }>('dispatch.queue.add', {
    ...queueParams,
    ticketOrPr: 'MANUAL-000002',
  });
  await persistQueueNow();
  await loadQueue();
  const newOriginator = queueRecordOriginator(newQueue.item.id);
  assert.deepEqual(newOriginator, {
    kind: 'principal',
    principalId: reused.principal.id,
    principalGeneration: 1,
  });
  assert.equal(
    authorizeStoredRunEffect(
      resolveWorkOriginator(runtime, newOriginator),
      'new proof work',
      undefined,
    ).id,
    reused.principal.id,
  );
  assert.equal(resolveWorkOriginator(runtime, queueRecordOriginator(oldQueue.item.id)), null);
  await freshClient.call('dispatch.queue.update', {
    itemId: oldQueue.item.id,
    label: 'explicitly re-authored proof',
  });
  await persistQueueNow();
  await loadQueue();
  assert.deepEqual(queueRecordOriginator(oldQueue.item.id), newOriginator);
  assert.equal(
    authorizeStoredRunEffect(
      resolveWorkOriginator(runtime, queueRecordOriginator(oldQueue.item.id)),
      're-authored proof work',
      undefined,
    ).id,
    reused.principal.id,
  );
  claims.push(
    'public queue writes persist the replacement generation; old work fails fire-time authorization until a public edit explicitly re-authors it',
  );
  await assert.rejects(oldClient.call('principal.list', {}));
  await assert.rejects(client.call('principal.reuseRetiredId', reuseParams), {
    code: 'CREDENTIAL_STORE_REFUSED',
  });
  const operator = await client.call<{ principal: { id: string } }>('principal.create', {
    subject: { type: 'person', displayName: 'operator' },
    roles: [{ role: 'operator', scope: { kind: 'global' } }],
  });
  const operatorIssue = await client.call<{ secret: string }>('credential.issue', {
    principalId: operator.principal.id,
    displayName: 'operator device',
  });
  const operatorClient = await personClient(
    { credential: operatorIssue.secret },
    'operator device',
  );
  const refusedBytes = await readFile(runtime.store.path);
  await assert.rejects(operatorClient.call('principal.reuseRetiredId', reuseParams), {
    code: 'AUTH_FORBIDDEN',
  });
  assert.deepEqual(await readFile(runtime.store.path), refusedBytes);
  claims.push(
    'explicit admin reuse replaces a service with a person at the exact id; old secrets stay denied, history reloads, tombstones survive, and operator/node callers are refused',
  );
  await client.call('credential.revoke', { credentialId: fresh.credential.id });
  await client.call('credential.revoke', { credentialId: paired.record.id });
  await assert.rejects(client.call('credential.revoke', { credentialId: admin.record.id }));
  assert.throws(() => retirePrincipalsOffline([replacement.principal.id]), /gateway|stopped/i);
  claims.push('last admin and live-gateway offline guards refuse unsafe writes');
  const survivor = runtime.store.findCredential(admin.record.id);
  assert.equal(survivor?.revokedAt, null);
  console.log(
    JSON.stringify({ ok: true, claims, elapsedMs: performance.now() - started }, null, 2),
  );
} finally {
  releasePresence?.();
  try {
    await cleanupServer?.();
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
