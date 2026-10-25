// D07 Boot 1: real existing consumers and private owning writers, without a cold restart.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import {
  digest,
  exclusiveJson,
  forbiddenPlanningMethods,
  resolveNativePlanningInputs,
  verifyNativePlanningSource,
} from './native-planning-fixture.mjs';
import { assertObservedMemoryQueries } from './prove-native-planning.mjs';

const source = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, '');

export function assertNativeIntegrationRead(initial, state, counts, method) {
  for (const key of ['startedAt', 'workspaceKey', 'connectionProfileId'])
    assert.equal(state[key], initial[key], `Foreign native runtime: ${key}`);
  const query = state.domainObservations[method];
  assert(query.status === 'ready' && query.hasData && query.persisted === false);
  const read = counts.lastObservedReads[method];
  assert(read.completedAt >= initial.startedAt, 'A pre-app reply is not native evidence');
  assert.equal(
    digest(JSON.stringify(query.data)),
    read.payloadSha256,
    'Canonical data must match the actual reply',
  );
  assert.deepEqual(query.resourceState, read.resourceState);
  assertObservedMemoryQueries(state, counts, [method]);
}

async function prove() {
  const authorization = JSON.parse(await readFile(process.env.FARMSLOT_D07_NATIVE_AUTHORIZATION));
  assert(authorization.executionAuthorized && authorization.oneBoot);
  assert.equal(authorization.budgetCase, 'D07-GO-Boot-1');
  assert.equal(authorization.deliberateColdRestart, false);
  await verifyNativePlanningSource(source, authorization.sourceHead);
  for (const relative of [
    'apps/companion/scripts/agentic/prove-native-planning-integration.mjs',
    'apps/companion/scripts/agentic/recipe/recipes/offline-native-integration.recipe.json',
    'apps/companion/src/farmslot/run-collections-proof.ts',
  ])
    assert.equal(
      digest(await readFile(path.join(source, relative))),
      authorization.driverHashes[relative],
    );
  const configFile = await realpath(process.env.FARMSLOT_D07_INTEGRATION_CONFIG);
  assert.equal(digest(await readFile(configFile)), authorization.configSha256);
  const config = JSON.parse(await readFile(configFile));
  assert.equal(config.sourceRoot, source);
  const plan = await resolveNativePlanningInputs(process.env, source);
  const saved = JSON.parse(await readFile(process.env.FARMSLOT_D07_NATIVE_PLAN));
  assert.equal(plan.inputHash, saved.inputHash);
  const artifacts = await realpath(process.env.FARMSLOT_RECIPE_ARTIFACTS_DIR);
  const save = (name, value) => exclusiveJson(path.join(artifacts, name), value);
  await save('d07-integration-consumed.json', { inputHash: plan.inputHash, at: Date.now() });
  const execute = promisify(execFile);
  const helper = path.join(path.dirname(configFile), 'source-runtime.mjs');
  assert.equal(digest(await readFile(helper)), authorization.driverHashes['source-runtime.mjs']);
  const writer = async (kind) => {
    const result = await execute(
      process.execPath,
      ['--import', 'tsx', helper, `integration-write:${kind}`, configFile],
      {
        cwd: source,
        env: process.env,
        timeout: 30000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    const receipt = JSON.parse(result.stdout);
    await save(`d07-integration-${kind}.json`, receipt);
    return receipt;
  };
  const { createAgentDeviceClient } = await import('agent-device');
  const { confirmSimulatorURLPrompt } = await import('./simulator-dev-client.mjs');
  const device = createAgentDeviceClient({ stateDir: process.env.FARMSLOT_AGENT_DEVICE_STATE_DIR });
  const sessions = (await device.sessions.list()).filter(
    (session) => session.device.id === config.deviceUuid,
  );
  assert.equal(sessions.length, 1, 'Reuse exactly the recipe-owned SDK session');
  const selection = { session: sessions[0].name, platform: 'ios', target: 'mobile' };
  const proxy = JSON.parse(
    await readFile(path.join(process.env.FARMSLOT_NATIVE_STORE_PROXY_DIR, 'ready.json')),
  );
  let sample = 0;
  const wire = async () => {
    const response = await fetch('http://127.0.0.1:7917/native-store-proof-counts', {
      signal: AbortSignal.timeout(3000),
    });
    assert(response.ok);
    const value = await response.json();
    assert.equal(value.startId, proxy.startId);
    assert(!value.failure && !value.stopped);
    return value;
  };
  const observe = async () => {
    const response = await fetch('http://127.0.0.1:8194/farmslot-recipe/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command: 'observeUi',
        nodeId: 'd07-integration',
        payload: { refs: ['runs-cache:snapshot'] },
        timeout_ms: 3000,
      }),
      signal: AbortSignal.timeout(6000),
    });
    assert(response.ok);
    const reply = await response.json();
    assert(reply.ok && reply.observations?.runCollections);
    const value = reply.observations.runCollections;
    assert.equal(value.platform, 'ios');
    await save(`d07-integration-observe-${++sample}.json`, value);
    return value;
  };
  const initial = await observe();
  const sameRuntime = (value) => {
    for (const key of ['startedAt', 'workspaceKey', 'connectionProfileId'])
      assert.equal(value[key], initial[key], `Boot 1 must retain ${key}`);
    assert.deepEqual(value.planningFilters, { projects: [plan.project], machines: [] });
  };
  let initialWire;
  async function until(read, accepts, label) {
    const deadline = Date.now() + 15000;
    do {
      const value = await read();
      if (accepts(value)) return value;
      await delay(100);
    } while (Date.now() < deadline);
    assert.fail(label);
  }
  const open = async (route) => {
    await execute(
      'xcrun',
      ['simctl', 'openurl', config.deviceUuid, `${config.scheme}:///${route}`],
      { timeout: 15000 },
    );
    await confirmSimulatorURLPrompt(config.deviceUuid);
    sameRuntime(await observe());
  };
  async function capture(name) {
    const snapshot = await device.capture.snapshot({
      ...selection,
      interactiveOnly: false,
      forceFull: true,
    });
    await save(`${name}.snapshot.json`, snapshot);
    await device.capture.screenshot({
      ...selection,
      path: path.join(artifacts, `${name}.png`),
      stabilize: true,
    });
    return snapshot;
  }
  const visible = (snapshot, node) => {
    const viewport = snapshot.nodes.find(
      (row) => ['Application', 'Window'].includes(row.type) && row.rect?.width > 0,
    )?.rect;
    const r = node.rect;
    return (
      viewport &&
      node.visibleToUser !== false &&
      r?.width > 0 &&
      r.height > 0 &&
      r.x >= viewport.x &&
      r.y >= viewport.y &&
      r.x + r.width <= viewport.x + viewport.width &&
      r.y + r.height <= viewport.y + viewport.height
    );
  };
  const text = (snapshot, label) =>
    snapshot.nodes.some(
      (node) =>
        visible(snapshot, node) && `${node.label ?? ''} ${node.value ?? ''}`.includes(label),
    );
  async function view(name, present, absent = []) {
    for (let i = 0; i < 10; i++) {
      const screen = await capture(`${name}-${i}`);
      if (
        present.every((label) => text(screen, label)) &&
        absent.every((label) => !text(screen, label))
      )
        return screen;
      await delay(150);
    }
    assert.fail(`Current native view missing ${name}; no Refresh or relaunch fallback`);
  }
  async function press(name, matches) {
    const screen = await capture(name);
    const candidates = screen.nodes.filter(
      (node) => matches(node) && node.enabled !== false && visible(screen, node),
    );
    assert.equal(candidates.length, 1, 'Require one visible current enabled target');
    const target = candidates[0];
    const point = {
      x: target.rect.x + target.rect.width / 2,
      y: target.rect.y + target.rect.height / 2,
    };
    const receipt = { target, point, startedAt: Date.now() };
    receipt.result = await device.interactions.press({ ...selection, ...point });
    receipt.completedAt = Date.now();
    await save(`${name}.press.json`, receipt);
  }
  async function currentMemory(method, accepts = () => true, after = 0) {
    return until(
      async () => {
        const [state, counts] = await Promise.all([observe(), wire()]);
        sameRuntime(state);
        const query = state.domainObservations[method];
        const read = counts.lastObservedReads?.[method];
        if (
          query?.status !== 'ready' ||
          !query.data ||
          !read ||
          read.completedAt < after ||
          !accepts(query.data)
        )
          return null;
        if (
          digest(JSON.stringify(query.data)) !== read.payloadSha256 ||
          JSON.stringify(query.resourceState) !== JSON.stringify(read.resourceState)
        )
          return null;
        assertNativeIntegrationRead(initial, state, counts, method);
        return { state, counts };
      },
      Boolean,
      `Current observed ${method} must match actual canonical data and its wire reply`,
    );
  }
  const claims = {};
  try {
    await open('backlog');
    await view('filtered-original', [plan.expected.backlog.before]);
    initialWire = await wire();
    assert(initialWire.lastObservedReads['backlog.list']);
    for (const method of [...forbiddenPlanningMethods, 'prRules.ruleSave'])
      assert.equal(initialWire.counts[method] ?? 0, 0, `No bootstrap app command: ${method}`);
    const outside = await writer('filter-create');
    const label = outside.facts.item.title;
    await view('filtered-outside', [plan.expected.backlog.before], [label]);
    await writer('filter-enter');
    await view('filtered-enter', [label]);
    await writer('filter-leave');
    await view('filtered-leave', [plan.expected.backlog.before], [label]);
    const filteredFinal = await observe();
    const filteredWire = await wire();
    const canonicalBacklog = filteredFinal.backlogObservation;
    assert.equal(canonicalBacklog.status, 'ready');
    assert.equal(
      canonicalBacklog.data.items.find((item) => item.id === outside.facts.item.id).project,
      outside.facts.item.project,
    );
    assert.equal(
      digest(JSON.stringify(canonicalBacklog.data)),
      filteredWire.lastObservedReads['backlog.list'].payloadSha256,
    );
    assert.deepEqual(
      canonicalBacklog.resourceState,
      filteredWire.lastObservedReads['backlog.list'].resourceState,
    );
    await save('d07-filtered-membership.json', {
      initial,
      final: await observe(),
      wire: await wire(),
      item: outside.facts.item,
    });
    claims.d07FilteredMembership = true;

    await open('pr-automation');
    await press('pr-rules-tab', (node) => node.identifier === 'companion-pr-tab-rules');
    await view('pr-rule-before', ['D07 private rule before', 'Disabled']);
    const prBefore = await currentMemory('prRules.list');
    const prWriter = await writer('pr-write');
    await view(
      'pr-rule-after',
      ['D07 private rule after', 'Disabled'],
      ['D07 private rule before'],
    );
    const prAfter = await currentMemory(
      'prRules.list',
      (data) =>
        data.rules.some(
          (rule) =>
            rule.id === prWriter.facts.rule.id && rule.config.name === 'D07 private rule after',
        ),
      prWriter.requestedAt,
    );
    assert(
      prAfter.state.domainObservations['prRules.list'].observedAt >
        prBefore.state.domainObservations['prRules.list'].observedAt,
    );
    await save('d07-pr-owning-writer.json', { before: prBefore, writer: prWriter, after: prAfter });
    claims.d07PRWriter = true;

    async function errorAndRetry(kind, method, button, healthyLabel) {
      const healthy = await currentMemory(method);
      await writer(`${kind}-error`);
      const failed = await until(
        observe,
        (state) => !!state.domainObservations[method]?.errorCode,
        `Real ${method} source failure must reach its canonical query`,
      );
      sameRuntime(failed);
      const query = failed.domainObservations[method];
      assert(
        query.hasData && query.observedAt === healthy.state.domainObservations[method].observedAt,
        'Source failure must retain the last facts and original age',
      );
      assert(query.errorMessage);
      await view(`${kind}-error-visible`, [healthyLabel, query.errorMessage.split('\n')[0]]);
      const before = await wire();
      await press(
        `${kind}-actual-retry`,
        (node) => node.type === 'Button' && node.label === button,
      );
      const retried = await until(
        async () => ({ state: await observe(), counts: await wire() }),
        (value) =>
          value.counts.counts[method] > before.counts[method] &&
          !!value.state.domainObservations[method]?.errorCode,
        'Actual Retry must issue its failed read while the source is still malformed',
      );
      await writer(`${kind}-repair`);
      const recovered = await currentMemory(method);
      await view(`${kind}-recovered`, [healthyLabel], [query.errorMessage.split('\n')[0]]);
      await save(`d07-${kind}-error-retry.json`, { healthy, failed, before, retried, recovered });
    }
    await errorAndRetry('pr', 'prRules.list', 'Refresh queue', 'D07 private rule after');

    await open('copilot');
    await view('copilot-before', ['Operator Co-Pilot', 'Co-Pilot is stopped']);
    const copilotBefore = await currentMemory('copilot.status');
    const copilotWriter = await writer('copilot-write');
    const copilotAfter = await currentMemory(
      'copilot.status',
      (data) =>
        data.session.effort === copilotWriter.facts.session.effort &&
        data.session.autostart === false &&
        data.session.status === 'stopped',
      copilotWriter.requestedAt,
    );
    assert.notEqual(
      copilotAfter.state.domainObservations['copilot.status'].data.session.effort,
      copilotBefore.state.domainObservations['copilot.status'].data.session.effort,
    );
    await view('copilot-after', ['Operator Co-Pilot', 'Co-Pilot is stopped']);
    await save('d07-copilot-owning-writer.json', {
      before: copilotBefore,
      writer: copilotWriter,
      after: copilotAfter,
      visualModelChange: false,
    });
    claims.d07CopilotWriter = true;
    await errorAndRetry('copilot', 'copilot.status', 'Refresh status', 'Co-Pilot is stopped');
    claims.d07NativeErrorsRetry = true;

    await open('backlog');
    const foreground = await observe();
    const backgroundStartedAt = Date.now();
    await execute('xcrun', ['simctl', 'launch', config.deviceUuid, 'com.apple.Preferences'], {
      timeout: 15000,
    });
    await execute(
      'xcrun',
      [
        'simctl',
        'io',
        config.deviceUuid,
        'screenshot',
        path.join(artifacts, 'actual-system-background.png'),
      ],
      { timeout: 15000 },
    );
    const backgroundClosed = await until(
      wire,
      (counts) => counts.connections === 0,
      'Actual background must close the app transport before the source write',
    );
    await save('d07-background-closed.json', { at: Date.now(), backgroundClosed });
    const backgroundWriter = await writer('backlog-background');
    await open('backlog');
    const resumed = await until(
      observe,
      (state) =>
        state.online &&
        state.appStateHistory.some(
          (event) =>
            event.state === 'background' &&
            event.at >= backgroundStartedAt &&
            event.at <= backgroundWriter.requestedAt,
        ) &&
        state.appStateHistory.some(
          (event) => event.state === 'active' && event.at >= backgroundWriter.requestedAt,
        ),
      'Actual native background and foreground lifecycle events must be retained',
    );
    sameRuntime(resumed);
    assert(
      resumed.connectionGeneration > foreground.connectionGeneration,
      'Foreground must reconnect the same process',
    );
    await view('foreground-current-backlog', [backgroundWriter.facts.item.title]);
    const finalWire = await wire();
    assert.equal(
      finalWire.lastObservedReads['backlog.list'].resourceState.epoch,
      initialWire.lastObservedReads['backlog.list'].resourceState.epoch,
      'Background recovery keeps the same gateway epoch',
    );
    for (const method of [...forbiddenPlanningMethods, 'prRules.ruleSave'])
      assert.equal(
        finalWire.counts[method] ?? 0,
        initialWire.counts[method] ?? 0,
        `No app command or replay: ${method}`,
      );
    await save('d07-native-background.json', {
      foreground,
      backgroundStartedAt,
      backgroundWriter,
      resumed,
      finalWire,
    });
    claims.d07NativeBackground = true;
    await save('d07-integration-result.json', {
      status: 'pass',
      claims,
      inputHash: plan.inputHash,
      startedAt: initial.startedAt,
      sourceHead: plan.sourceHead,
      coldRestarts: 0,
    });
    process.stdout.write(JSON.stringify(claims) + '\n');
  } catch (error) {
    await save('d07-integration-first-failure.json', {
      name: error.name,
      message: error.message,
      claims,
      at: Date.now(),
    });
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === 'check-import')
    process.stdout.write('D07_INTEGRATION_IMPORT_ONLY_PASS zero device/session/service calls\n');
  else if (process.argv[2] === 'prove') await prove();
  else throw new Error('Use check-import or prove; no phase boots a simulator.');
}
