// Extend the existing real account lifecycle with memory-only domain assertions.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export function createDomainAuthorityProof({
  kind,
  root,
  fixture,
  evidence,
  claims,
  execute,
  cdp,
  getTab,
  navigate,
  until,
  screenshot,
  authState,
  signOut,
  reconnect,
  rpc,
  originalProfile,
  createActor,
  getActor,
  allowBrowserRestore,
}) {
  assert(['assessment', 'analytics'].includes(kind));
  const method = kind === 'assessment' ? 'assessment.summary' : 'analytics.query';
  const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const inspect = () =>
    cdp([
      'eval',
      getTab(),
      '--file',
      path.join(root, 'apps/command-center/scripts/probes/offline-domains.js'),
    ]);
  const setup = () => readFile(process.env.FARMSLOT_TRIAGE_PROOF_SETUP, 'utf8').then(JSON.parse);
  let pending = false;
  let proxy;
  async function proxyStatus() {
    const state = await (await fetch('http://127.0.0.1:7915/planning-race-status')).json();
    assert.equal(state.startId, proxy.startId);
    assert(!state.failure && !state.stopped);
    return state;
  }
  async function control(action) {
    const response = await fetch('http://127.0.0.1:7915/api/planning-race-control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-proof-owner': proxy.owner },
      body: JSON.stringify({ action }),
      signal: AbortSignal.timeout(3000),
    });
    assert(response.ok, `Owned ${action} control failed`);
    assert.equal((await response.json()).startId, proxy.startId);
  }
  async function releasePending() {
    if (!pending) return;
    await control('release');
    pending = false;
  }
  async function seed(profile) {
    const { stdout } = await execute(
      process.execPath,
      [
        '--import',
        'tsx',
        'apps/command-center/scripts/assessment-observation-fixture.mjs',
        'authority-seed',
      ],
      {
        timeout: 30000,
        env: { ...process.env, FARMSLOT_GATEWAY_PROFILE: profile },
      },
    );
    const source = JSON.parse(stdout);
    assert(source.authoritySeeded && source.assessmentId && source.ownerId);
    return source;
  }
  function route(source) {
    return kind === 'assessment'
      ? `intelligence?tab=assessments&assessment=${source.assessmentId}&projects=${encodeURIComponent(fixture.project)}`
      : `analytics?project=${encodeURIComponent(fixture.project)}&projects=${encodeURIComponent(fixture.project)}`;
  }
  function warm(value, principal, source) {
    const state = value.observations?.[method];
    if (value.principalId !== principal || !state?.ready || state.persisted || !state.data)
      return false;
    if (kind === 'assessment') {
      return (
        value.assessment?.records.some(
          (row) =>
            row.id === source.assessmentId &&
            row.ownerId === source.ownerId &&
            (row.ownerGeneration ?? 0) === source.ownerGeneration,
        ) &&
        value.assessment.articleIds.includes(source.assessmentId) &&
        value.assessment.historyReady &&
        value.assessment.outcomes.some(
          (row) =>
            row.id === source.assessmentId && row.ready && row.data?.run?.id === source.runId,
        ) &&
        value.assessment.canonicalReads.history.dataPresent &&
        value.assessment.canonicalReads.selected?.dataPresent
      );
    }
    return (
      value.analytics?.result?.matchedRuns > 0 &&
      value.analytics.statLineCount > 0 &&
      state.params.project === fixture.project
    );
  }
  function cleared(value) {
    const state = value.observations?.[method];
    if (!state || state.canonicalDataPresent || state.data !== undefined) return false;
    return kind === 'assessment'
      ? value.assessment.records.length === 0 &&
          value.assessment.summary === null &&
          value.assessment.cursor === undefined &&
          value.assessment.outcomeCount === 0 &&
          value.assessment.articleIds.length === 0 &&
          !value.assessment.canonicalReads.history.dataPresent &&
          !value.assessment.canonicalReads.selected?.dataPresent
      : value.analytics.result === null &&
          value.analytics.statLineCount === 0 &&
          value.analytics.chartCount === 0 &&
          value.analytics.buttons.some(
            (button) => button.label === 'Backfill from runs' && button.disabled,
          );
  }
  async function bindReply(view) {
    const wire = await proxyStatus();
    const replies = kind === 'assessment' ? wire.assessmentReplies : wire.analyticsReplies;
    const state = view.observations[method];
    const reply = replies.findLast(
      (row) =>
        row.connection === view.connectionId &&
        row.ok &&
        (!row.method || row.method === method) &&
        row.payloadSha256 === digest(state.data),
    );
    assert(reply, 'Canonical domain data must match an actual observed wire reply');
    return reply;
  }
  async function run() {
    proxy = JSON.parse(
      await readFile(
        path.join(process.env.FARMSLOT_PLANNING_RACE_PROXY_DIR, 'proxy-ready.json'),
        'utf8',
      ),
    );
    assert.equal(proxy.method, method);
    const sources = kind === 'assessment' ? { original: await seed(originalProfile) } : {};
    evidence.domainSources = sources;
    await navigate(route(sources.original));
    evidence.domainOriginal = await until(
      inspect,
      (value) => warm(value, fixture.ownerId, sources.original),
      'Warm nonempty original domain',
    );
    evidence.domainOriginalReply = await bindReply(evidence.domainOriginal);
    await screenshot(`${kind}-original`);
    await createActor();
    const actor = getActor();
    if (kind === 'assessment') {
      sources.actor = await seed(actor.profile);
      assert.equal(sources.actor.ownerId, actor.principalId);
    }
    allowBrowserRestore();
    await signOut();
    if (kind === 'analytics') await control('arm');
    await cdp(['login', getTab()], actor.profile);
    await until(
      authState,
      (value) => value.principalId === actor.principalId && value.connection === 'connected',
      'Actual domain account switch',
    );
    if (kind === 'analytics') {
      const held = await until(
        proxyStatus,
        (value) =>
          value.held?.authentication.principalId === actor.principalId && !value.held.releasedAt,
        'Hold the new admin actual analytics reply',
      );
      pending = true;
      evidence.domainSwitchHeld = held.held;
      evidence.domainSwitchCleared = await until(
        inspect,
        cleared,
        'The original analytics projection must clear before the new admin reply',
      );
      await screenshot('analytics-new-admin-before-reply');
      await releasePending();
    } else {
      evidence.domainSwitchCleared = await until(
        inspect,
        (value) =>
          value.principalId === actor.principalId &&
          !value.assessment?.records.some((row) => row.id === sources.original.assessmentId) &&
          !value.assessment?.articleIds.includes(sources.original.assessmentId) &&
          !value.assessment?.canonicalReads.selected?.dataPresent,
        'The old assessment owner must disappear after account switch',
      );
      await navigate(route(sources.actor));
    }
    claims.domainPrincipalClears = true;
    evidence.domainWarm = await until(
      inspect,
      (value) => warm(value, actor.principalId, sources.actor),
      'Warm the new admin actual domain',
    );
    evidence.domainWarmReply = await bindReply(evidence.domainWarm);
    assert.equal(evidence.domainWarm.timeOrigin, evidence.domainOriginal.timeOrigin);
    if (kind === 'analytics')
      assert.equal(
        digest(evidence.domainWarm.observations[method].data),
        evidence.domainSwitchHeld.payloadSha256,
      );
    await screenshot(`${kind}-before-downgrade`);
    await rpc('principal.revokeRole', {
      principalId: actor.principalId,
      role: 'admin',
      scope: { kind: 'global' },
    });
    await reconnect();
    evidence.operatorAuthentication = await until(
      authState,
      (value) =>
        value.principalId === actor.principalId &&
        value.connection === 'connected' &&
        value.workspaceAccess === 'farm' &&
        value.roles?.length === 1 &&
        value.roles[0].role === 'operator',
      'Actual domain downgrade keeps operator farm access',
    );
    evidence.domainDenied = await until(
      inspect,
      (value) =>
        value.principalId === actor.principalId &&
        value.workspaceAccess === 'farm' &&
        value.observations?.[method]?.error?.code === 'AUTH_FORBIDDEN' &&
        cleared(value),
      'Domain role loss must clear canonical and rendered facts',
    );
    assert.equal(evidence.domainDenied.timeOrigin, evidence.domainWarm.timeOrigin);
    assert.notEqual(evidence.domainDenied.connectionId, evidence.domainWarm.connectionId);
    await screenshot(`${kind}-forbidden`);
    claims.domainRoleClears = true;
    if (kind === 'assessment') {
      const { stdout } = await execute(
        process.execPath,
        [
          '--import',
          'tsx',
          'apps/command-center/scripts/assessment-observation-fixture.mjs',
          'authority-feedback',
          sources.actor.assessmentId,
        ],
        { timeout: 30000, env: process.env },
      );
      evidence.domainChangedSource = JSON.parse(stdout);
      assert.equal(evidence.domainChangedSource.ownerId, actor.principalId);
    } else {
      const fixtureState = await setup();
      assert(fixtureState.pendingRunId);
      const before = await readFile(fixtureState.pendingRunFile);
      assert.equal(JSON.parse(before).id, fixtureState.pendingRunId);
      assert((await rpc('run.delete', { runId: fixtureState.pendingRunId })).ok);
      const now = new Date().toISOString().slice(0, 7);
      const bytes = await readFile(
        path.join(fixtureState.analytics.directory, `events-${now}.ndjson`),
      );
      const rows = bytes.toString().split('\n').filter(Boolean).map(JSON.parse);
      assert.equal(
        rows.filter(
          (row) => row.runId === fixtureState.pendingRunId && row.project === fixture.project,
        ).length,
        1,
      );
      evidence.domainChangedSource = {
        runId: fixtureState.pendingRunId,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        committedAt: Date.now(),
      };
    }
    await rpc('principal.grant', {
      principalId: actor.principalId,
      role: 'admin',
      scope: { kind: 'global' },
    });
    await reconnect();
    evidence.domainRecovered = await until(
      inspect,
      (value) => {
        if (
          !warm(value, actor.principalId, sources.actor) ||
          value.observations[method].observedAt <= evidence.domainChangedSource.committedAt
        )
          return false;
        if (kind === 'analytics')
          return (
            value.analytics.result.matchedRuns ===
            evidence.domainWarm.analytics.result.matchedRuns + 1
          );
        return (
          value.assessment.records.find((row) => row.id === sources.actor.assessmentId)?.feedback
            .length === evidence.domainChangedSource.feedbackRevision &&
          value.assessment.text.includes('Synthetic D07 authority source change')
        );
      },
      'Domain recovery must render the actual source changed while forbidden',
    );
    evidence.domainRecoveredReply = await bindReply(evidence.domainRecovered);
    assert.equal(evidence.domainRecovered.timeOrigin, evidence.domainWarm.timeOrigin);
    const wire = await proxyStatus();
    assert(
      Object.values(wire.commands).every((count) => count === 0),
      'Browser domain authority checks must issue no commands',
    );
    evidence.domainProxy = wire;
    await screenshot(`${kind}-recovered`);
    claims.domainRecoveryReadsNewSource = true;
  }
  return { run, inspect, releasePending };
}
