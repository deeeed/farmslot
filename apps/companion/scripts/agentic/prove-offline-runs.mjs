import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { createAgentDeviceClient } from 'agent-device';

import { automationGatewayTarget } from '../../../../scripts/lib/gateway-profile.mjs';
import { withOwnedGatewayOffline } from '../../../command-center/scripts/owned-gateway-outage.mjs';

import { waitForSimulatorRecipeBridge } from './simulator-dev-client.mjs';

const execute = promisify(execFile);
// adb shell joins argv into a remote shell command, so a URL's query separators
// must remain inside one quoted argument on Android too.
const androidShellArgument = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const root = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, '');
const phase = process.argv[2];
const contextPhases = [
  'prepare-context',
  'open-context',
  'workspace-context',
  'diff-context',
  'cold-diff-context',
  'artifacts-context',
  'cold-artifacts-context',
  'stale-artifacts-context',
  'stale-context',
  'cleanup-context',
];
const familyPhases = [
  'prepare-family',
  'family-default-route',
  'family-view',
  'family-cold',
  'cleanup-family',
];
assert(
  [
    'slot-context',
    'seed-inbox',
    'resolve-inbox',
    'open-detail',
    'cold-detail',
    ...contextPhases,
    ...familyPhases,
  ].includes(phase),
);
assert.equal(process.env.FARMSLOT_OFFLINE_PROOF, '1');
const metro = process.env.METRO_PORT;
const platform = process.env.PLATFORM;
assert(/^\d+$/.test(metro ?? ''));
assert(['ios', 'android'].includes(platform));
assert(
  process.env.FARMSLOT_HOME &&
    process.env.FARMSLOT_GATEWAY_PROFILE &&
    process.env.FARMSLOT_NATIVE_RUN_RECEIPT,
);
const home = await realpath(process.env.FARMSLOT_HOME);
const receipt = process.env.FARMSLOT_NATIVE_RUN_RECEIPT;
let proofRef = 'runs-cache:snapshot';
const selected = await automationGatewayTarget();
const gateway = new URL(selected.url);
assert(['localhost', '127.0.0.1', '[::1]'].includes(gateway.hostname));
assert.equal(gateway.port, process.env.GATEWAY_PORT);
const { stdout: pid } = await execute('lsof', ['-t', `-iTCP:${gateway.port}`, '-sTCP:LISTEN']);
assert(/^\d+$/.test(pid.trim()));
const { stdout: cwd } = await execute('lsof', ['-a', '-p', pid.trim(), '-d', 'cwd', '-Fn']);
assert(cwd.split('\n').includes(`n${root}/services/gateway`));

async function snapshot() {
  const response = await fetch(`http://127.0.0.1:${metro}/farmslot-recipe/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      command: 'observeUi',
      nodeId: `native-runs-${phase}`,
      payload: { refs: [proofRef] },
      timeout_ms: 3000,
    }),
    signal: AbortSignal.timeout(5000),
  });
  // A deep link or cold launch can replace the app's Metro poll. The bounded
  // readiness loop waits for a native observation; a relay timeout is no sample.
  if (response.status === 504) return undefined;
  assert(response.ok, `Native relay HTTP ${response.status}`);
  const reply = await response.json();
  assert(reply.ok, reply.error);
  const state = reply.observations.runCollections;
  assert.equal(state.platform, platform, 'Use the explicitly selected native app');
  return state;
}
async function until(ready, label) {
  const deadline = Date.now() + 45000;
  let value;
  do {
    const observed = await snapshot();
    if (observed) {
      value = observed;
      if (ready(value)) return value;
    }
    await delay(100);
  } while (Date.now() < deadline);
  assert.fail(`${label}: ${JSON.stringify(value)}`);
}
async function inbox(route = 'inbox') {
  const url = `farmslot-development:///${route}`;
  if (platform === 'ios') {
    assert(process.env.IOS_SIMULATOR);
    await execute('xcrun', ['simctl', 'openurl', process.env.IOS_SIMULATOR, url]);
  } else {
    const serial = process.env.ADB_SERIAL ?? process.env.ANDROID_SERIAL;
    assert(serial?.startsWith('emulator-'));
    await execute('adb', [
      '-s',
      serial,
      'shell',
      'am',
      'start',
      '-a',
      'android.intent.action.VIEW',
      '-d',
      androidShellArgument(url),
      'net.siteed.farmslot.development',
    ]);
  }
}
async function rpc(method, params = {}) {
  const { stdout } = await execute(
    process.execPath,
    [
      path.join(root, 'apps/command-center/scripts/cdp.mjs'),
      'gateway',
      method,
      JSON.stringify(params),
    ],
    { timeout: 30000 },
  );
  return JSON.parse(stdout);
}
async function restartNative() {
  const bundle = 'net.siteed.farmslot.development';
  const link = `farmslot-development://expo-development-client/?url=${encodeURIComponent(`http://127.0.0.1:${metro}`)}`;
  if (platform === 'ios') {
    await execute('xcrun', ['simctl', 'terminate', process.env.IOS_SIMULATOR, bundle]);
    await execute('xcrun', ['simctl', 'openurl', process.env.IOS_SIMULATOR, link]);
  } else {
    const serial = process.env.ADB_SERIAL ?? process.env.ANDROID_SERIAL;
    assert(serial?.startsWith('emulator-'));
    await execute('adb', ['-s', serial, 'shell', 'am', 'force-stop', bundle]);
    await execute('adb', [
      '-s',
      serial,
      'shell',
      'am',
      'start',
      '-a',
      'android.intent.action.VIEW',
      '-d',
      androidShellArgument(link),
      bundle,
    ]);
  }
  await waitForSimulatorRecipeBridge({ platform });
}

if (phase === 'slot-context') {
  assert(process.env.FARMSLOT_RUN_PROOF_FIXTURE);
  const fixture = JSON.parse(await readFile(process.env.FARMSLOT_RUN_PROOF_FIXTURE, 'utf8'));
  assert.equal(fixture.home, home);
  assert.equal(fixture.runFile, path.join(home, 'runs', `${fixture.runId}.json`));
  const original = (await rpc('run.get', { runId: fixture.runId })).run;
  assert.equal(original.readOnly, false, 'Never mutate imported runs');
  assert.equal(original.slotId, fixture.slotId);
  assert.equal(original.taskFile, fixture.taskFile);
  const tag = `native-slot-${randomUUID().slice(0, 8)}`;
  const device = createAgentDeviceClient({ stateDir: process.env.FARMSLOT_AGENT_DEVICE_STATE_DIR });
  const deviceId = platform === 'ios' ? process.env.IOS_SIMULATOR : process.env.ADB_SERIAL;
  const sessions = (await device.sessions.list()).filter(
    (session) => session.device.id === deviceId,
  );
  assert.equal(sessions.length, 1);
  const selection = { session: sessions[0].name, platform, target: 'mobile' };
  const nativePhases = [];
  let phaseStart = Date.now();
  const capture = async (name) => {
    await device.capture.screenshot({
      ...selection,
      path: path.join(process.env.FARMSLOT_RECIPE_ARTIFACTS_DIR, 'screenshots', name),
      stabilize: true,
    });
    nativePhases.push({ name, startedAt: phaseStart, endedAt: Date.now() });
    phaseStart = Date.now();
  };
  const route = `workspace/slot/${fixture.slotId}/slot?runId=${fixture.runId}`;
  const current = (value) =>
    value.detail?.status === 'ready' &&
    value.slotProjectionMatches &&
    value.slotRecipesMatch &&
    value.slotRecipes?.status === 'ready';
  const historyId = randomUUID();
  const historyFile = path.join(home, 'runs', `${historyId}.json`);
  const historyTime = new Date(Date.now() - 60_000).toISOString();
  const historyRun = {
    id: historyId,
    familyId: original.familyId,
    parentRunId: fixture.runId,
    familyRootTicketOrPr: original.familyRootTicketOrPr,
    lane: 'validation',
    variant: null,
    flowType: 'dev',
    mode: 'interactive',
    status: 'done',
    project: original.project,
    ticketOrPr: 'Native slot history proof',
    slotId: fixture.slotId,
    branch: null,
    taskFile: null,
    completionPolicy: 'artifact-only',
    steps: [],
    decisions: [],
    agentContexts: [],
    readOnly: true,
    metrics: {
      nudgeCount: 0,
      runner: null,
      model: null,
      runnerSessionId: null,
      runnerSessionPath: null,
    },
    createdAt: historyTime,
    updatedAt: historyTime,
    startedAt: historyTime,
    completedAt: historyTime,
  };
  let seeded = false;
  let cold;
  let started;
  try {
    await withOwnedGatewayOffline(async () => {
      await writeFile(historyFile, JSON.stringify(historyRun), { flag: 'wx', mode: 0o600 });
      seeded = true;
    });
    proofRef = `runs-cache:slot:${fixture.runId}`;
    await inbox(route);
    const initial = await until(
      (value) =>
        current(value) &&
        value.slotHistory?.status === 'ready' &&
        value.slotHistory.data.runs.some((row) => row.runId === historyId) &&
        value.slotHistoryReadsReady &&
        value.slotHistoryReadCount > 0 &&
        value.slotHistoryDetailsMatch &&
        value.slotHistoryRecipesMatch,
      'The mounted slot workspace must use canonical run, history and recipe observations',
    );
    started = initial.startedAt;
    await rpc('run.tags.set', { runId: fixture.runId, tags: [...(original.tags ?? []), tag] });
    await until(
      (value) => current(value) && value.detail.data.run.tags?.includes(tag),
      'The real slot workspace run must follow an external write',
    );
    await capture('native-slot-current.png');
    proofRef = `runs-cache:slot-diff:${fixture.runId}`;
    await inbox(`workspace/slot/${fixture.slotId}/diff`);
    await until(current, 'The actual slot diff must share its full run and recipe observations');
    await capture('native-slot-diff-current.png');
    proofRef = `runs-cache:slot:${fixture.runId}`;
    await inbox(route);
    await until(current, 'Return to the canonical slot workspace before disconnect');
    await withOwnedGatewayOffline(async () => {
      const stale = await until(
        (value) => value.detail?.status === 'stale' && value.slotProjectionMatches,
        'The slot workspace must retain its actual shared run during an outage',
      );
      await restartNative();
      await inbox(route);
      cold = await until(
        (value) =>
          value.startedAt > started &&
          value.detail?.status === 'stale' &&
          value.detail.data?.run.id === fixture.runId &&
          value.slotProjectionMatches &&
          !value.slotRecipes?.data,
        'A cold slot workspace must render its saved full run without inventing fleet or recipe facts',
      );
      assert.equal(cold.detail.observedAt, stale.detail.observedAt);
      assert.equal(cold.diagnostics.integrity, 'ok');
      const screen = await device.capture.snapshot({
        ...selection,
        interactiveOnly: false,
        forceFull: true,
      });
      assert(
        screen.nodes.some((node) => node.label?.includes('Saved slot run')),
        'The actual cold slot workspace must show its saved run age',
      );
      assert(
        screen.nodes.some((node) => node.label?.includes(original.ticketOrPr)),
        'The actual cold slot workspace must render its saved run identity',
      );
      await capture('native-slot-cold.png');
    });
    await until(
      (value) => current(value) && value.slotHistory?.status === 'ready',
      'The slot workspace must recover its current history and recipe reads after reconnect',
    );
    console.log(
      JSON.stringify({
        result: 'PASS',
        phase,
        nativePhases,
        nativeSlotProjection: true,
        nativeSlotDiffProjection: true,
        nativeSlotExternalWrite: true,
        nativeHistoricalQueries: true,
        nativeSlotCold: true,
        observedAt: cold.detail.observedAt,
      }),
    );
  } finally {
    try {
      await rpc('run.tags.set', { runId: fixture.runId, tags: original.tags ?? [] });
      await inbox('runs');
    } finally {
      if (seeded)
        await withOwnedGatewayOffline(async () => {
          assert.equal(JSON.parse(await readFile(historyFile, 'utf8')).id, historyId);
          await rm(historyFile);
        });
    }
  }
  process.exit(0);
}

if (familyPhases.includes(phase)) {
  assert.equal(process.env.FARMSLOT_DISABLE_ORCHESTRATION, '1');
  assert.equal(process.env.FARMSLOT_RUNS_DIR, path.join(home, 'runs'));
  if (phase === 'prepare-family') {
    await assert.rejects(access(receipt), { code: 'ENOENT' });
    const runId = randomUUID();
    const siblingId = randomUUID();
    const files = [runId, siblingId].map((id) => path.join(home, 'runs', `${id}.json`));
    const now = new Date().toISOString();
    const rootRun = {
      id: runId,
      familyId: runId,
      parentRunId: null,
      familyRootTicketOrPr: 'Offline family proof',
      lane: 'validation',
      variant: null,
      flowType: 'dev',
      mode: 'interactive',
      status: 'monitoring',
      project: 'farmslot-farm',
      ticketOrPr: 'Offline family proof',
      slotId: null,
      taskFile: null,
      branch: null,
      readOnly: false,
      completionPolicy: 'artifact-only',
      steps: [],
      decisions: [],
      metrics: { nudgeCount: 0, runner: null, model: null },
      createdAt: now,
      startedAt: now,
      updatedAt: now,
    };
    await writeFile(receipt, JSON.stringify({ runId, siblingId, files, home, platform, metro }), {
      flag: 'wx',
      mode: 0o600,
    });
    await withOwnedGatewayOffline(async () => {
      await writeFile(files[0], JSON.stringify(rootRun), { flag: 'wx', mode: 0o600 });
      await writeFile(
        files[1],
        JSON.stringify({
          ...rootRun,
          id: siblingId,
          status: 'done',
          completedAt: now,
          ticketOrPr: 'Offline family sibling',
        }),
        { flag: 'wx', mode: 0o600 },
      );
    });
    console.log(JSON.stringify({ result: 'PASS', phase, runId, siblingId }));
    process.exit(0);
  }
  const fixture = JSON.parse(await readFile(receipt, 'utf8'));
  assert.equal(fixture.home, home);
  assert.equal(fixture.platform, platform);
  assert.equal(fixture.metro, metro);
  assert.match(fixture.runId, /^[a-f0-9-]{36}$/);
  assert.match(fixture.siblingId, /^[a-f0-9-]{36}$/);
  assert.deepEqual(
    fixture.files,
    [fixture.runId, fixture.siblingId].map((id) => path.join(home, 'runs', `${id}.json`)),
  );
  if (phase === 'cleanup-family') {
    await withOwnedGatewayOffline(async () => {
      for (const file of fixture.files) await rm(file);
    });
    await rm(receipt);
    console.log(JSON.stringify({ result: 'PASS', phase, nativeFamilyRemoved: true }));
    process.exit(0);
  }
  proofRef = `runs-cache:family:${fixture.runId}`;
  const route = `family/${fixture.runId}?runId=${fixture.runId}`;
  if (phase === 'family-default-route') {
    await inbox(`family/${fixture.runId}`);
    const opened = await until(
      (value) =>
        value.family?.status === 'ready' &&
        value.familySelected?.status === 'ready' &&
        value.familySelectionInRoute &&
        value.familyProjectionMatches &&
        value.selectedRunProjectionMatches,
      'A plain native family route must remember the run actually selected by its rendered view',
    );
    assert([fixture.runId, fixture.siblingId].includes(opened.familyRouteRunId));
    fixture.selectedRouteRunId = opened.familyRouteRunId;
    await writeFile(receipt, JSON.stringify(fixture));
    console.log(JSON.stringify({ result: 'PASS', phase, nativeFamilySelectionRouted: true }));
    process.exit(0);
  }
  if (phase === 'family-view') {
    await inbox(route);
    await until(
      (value) =>
        value.family?.status === 'ready' &&
        value.family.data.snapshot.workflowState === 'active' &&
        value.detail?.status === 'ready' &&
        value.familyRecipes?.length === 2 &&
        value.familyRecipes.every(({ status }) => status === 'ready') &&
        value.familyProjectionMatches &&
        value.selectedRunProjectionMatches &&
        value.familyRecipeProjectionMatches,
      'The native family must observe its full selected run and every family recipe group',
    );
    const cancelled = await rpc('run.cancel', { runId: fixture.runId });
    assert.equal(cancelled.run.status, 'cancelled');
    await until(
      (value) =>
        value.family?.status === 'ready' &&
        value.family.data.snapshot.workflowState === 'complete' &&
        value.familyProjectionMatches,
      'A second-client cancellation must update the native family without Refresh',
    );
    console.log(JSON.stringify({ result: 'PASS', phase, nativeFamilyNotification: true }));
    process.exit(0);
  }
  assert.match(fixture.selectedRouteRunId, /^[a-f0-9-]{36}$/);
  const savedRoute = `family/${fixture.runId}?runId=${fixture.selectedRouteRunId}`;
  await inbox(savedRoute);
  const before = await until(
    (value) =>
      value.family?.status === 'ready' &&
      value.familySelected?.status === 'ready' &&
      value.familySelected.data.run.id === fixture.selectedRouteRunId,
    'Family and selected run must be current before disconnect',
  );
  assert(process.env.FARMSLOT_AGENT_DEVICE_STATE_DIR);
  const device = createAgentDeviceClient({ stateDir: process.env.FARMSLOT_AGENT_DEVICE_STATE_DIR });
  const id = platform === 'ios' ? process.env.IOS_SIMULATOR : process.env.ADB_SERIAL;
  const sessions = (await device.sessions.list()).filter((session) => session.device.id === id);
  assert.equal(sessions.length, 1);
  const selection = { session: sessions[0].name, platform, target: 'mobile' };
  await withOwnedGatewayOffline(async () => {
    const stale = await until(
      (value) => value.family?.status === 'stale' && value.familySelected?.status === 'stale',
      'Family and full run must become stale together',
    );
    assert(stale.familySelected.observedAt >= before.familySelected.observedAt);
    await restartNative();
    await inbox(savedRoute);
    const cold = await until(
      (value) =>
        value.startedAt > before.startedAt &&
        value.familySelected?.status === 'stale' &&
        value.familySelected.data?.run.id === fixture.selectedRouteRunId &&
        !value.family?.data,
      'A cold family route must restore the selected full run without persisting its derived family snapshot',
    );
    assert.equal(cold.familySelected.observedAt, stale.familySelected.observedAt);
    assert.equal(cold.diagnostics.integrity, 'ok');
    const screen = await device.capture.snapshot({
      ...selection,
      interactiveOnly: false,
      forceFull: true,
    });
    const savedButton = screen.nodes.find(
      (node) => node.label?.includes('Open saved run') && node.rect,
    );
    assert(savedButton?.rect, 'The actual family view must expose its saved selected run');
    await device.capture.screenshot({
      ...selection,
      path: path.join(
        process.env.FARMSLOT_RECIPE_ARTIFACTS_DIR,
        'screenshots/native-family-cold.png',
      ),
      stabilize: true,
    });
    await device.interactions.press({
      ...selection,
      x: savedButton.rect.x + savedButton.rect.width / 2,
      y: savedButton.rect.y + savedButton.rect.height / 2,
    });
    const deadline = Date.now() + 30000;
    let detailScreen;
    do {
      detailScreen = await device.capture.snapshot({
        ...selection,
        interactiveOnly: false,
        forceFull: true,
      });
      if (detailScreen.nodes.some((node) => node.label === 'Run Detail')) break;
      await delay(100);
    } while (Date.now() < deadline);
    assert(
      detailScreen.nodes.some((node) => node.label === 'Run Detail'),
      'Open saved run must navigate to the actual native detail screen',
    );
    await device.capture.screenshot({
      ...selection,
      path: path.join(
        process.env.FARMSLOT_RECIPE_ARTIFACTS_DIR,
        'screenshots/native-family-opened-run.png',
      ),
      stabilize: true,
    });
    await inbox(savedRoute);
    await until(
      (value) =>
        value.familySelected?.status === 'stale' &&
        value.familySelected.data?.run.id === fixture.selectedRouteRunId,
      'Returning to the family must preserve the same selected run offline',
    );
  });
  await until(
    (value) =>
      value.family?.status === 'ready' &&
      value.familySelected?.status === 'ready' &&
      value.familyRecipes?.every(({ status }) => status === 'ready') &&
      value.familyProjectionMatches &&
      value.selectedRunProjectionMatches &&
      value.familyRecipeProjectionMatches,
    'Reconnect must restore current family and recipe observations',
  );
  console.log(JSON.stringify({ result: 'PASS', phase, nativeFamilyColdSelection: true }));
  process.exit(0);
}
if (contextPhases.includes(phase)) {
  assert.equal(process.env.FARMSLOT_DISABLE_ORCHESTRATION, '1');
  assert.equal(process.env.FARMSLOT_RUNS_DIR, path.join(home, 'runs'));
  if (phase === 'prepare-context') {
    await assert.rejects(access(receipt), { code: 'ENOENT' });
    const runId = randomUUID();
    const decisionId = randomUUID();
    const runFile = path.join(home, 'runs', `${runId}.json`);
    const now = new Date().toISOString();
    const run = {
      id: runId,
      familyId: runId,
      parentRunId: null,
      familyRootTicketOrPr: 'Offline shared gate',
      lane: 'validation',
      variant: null,
      flowType: 'dev',
      mode: 'interactive',
      status: 'human-gating',
      project: 'farmslot-farm',
      ticketOrPr: 'Offline shared gate',
      slotId: null,
      taskFile: null,
      branch: null,
      readOnly: false,
      completionPolicy: 'artifact-only',
      steps: [],
      metrics: { nudgeCount: 0, runner: null, model: null },
      createdAt: now,
      startedAt: now,
      updatedAt: now,
      reviewResult: {
        recommendation: 'APPROVE',
        lineComments: [],
        reviewMd: 'Saved offline review body.',
        reviewSnapshot: {
          source: 'github-pr',
          headSha: 'a'.repeat(40),
          baseSha: 'b'.repeat(40),
          capturedAt: now,
          diffHash: 'offline-gate-proof',
        },
      },
      decisions: [
        {
          id: decisionId,
          type: 'engine_human_gate',
          title: 'Offline shared gate',
          description: 'Private gate for shared observation and stale-action proof.',
          createdAt: now,
          actions: [
            { id: 'send-feedback', label: 'Send feedback' },
            { id: 'hold', label: 'Hold' },
          ],
          payload: {
            kind: 'ready',
            publicationTarget: 'ready',
            prNumber: null,
            repo: null,
            diffStat: { files: 0, additions: 0, deletions: 0 },
            currentDescription: { title: 'Offline shared gate', body: 'Private proof' },
            branch: 'proof',
            reviews: [],
            artifactManifest: [
              {
                path: 'artifacts/offline-store-proof.txt',
                type: 'file',
                purpose: 'evidence',
                label: 'Saved artifact inventory',
                mimeType: 'text/plain',
              },
            ],
            workerReport: 'Private proof report.',
          },
        },
      ],
    };
    await writeFile(
      receipt,
      JSON.stringify({ runId, decisionId, runFile, home, platform, metro }),
      { flag: 'wx', mode: 0o600 },
    );
    await withOwnedGatewayOffline(async () => {
      await writeFile(runFile, JSON.stringify(run), { flag: 'wx', mode: 0o600 });
    });
    assert((await rpc('decision.list')).decisions.some(({ id }) => id === decisionId));
    console.log(
      JSON.stringify({ result: 'PASS', phase, nativeGatePrepared: true, runId, decisionId }),
    );
    process.exit(0);
  }
  const fixture = JSON.parse(await readFile(receipt, 'utf8'));
  assert.equal(fixture.home, home);
  assert.equal(fixture.platform, platform);
  assert.equal(fixture.metro, metro);
  assert.match(fixture.runId, /^[a-f0-9-]{36}$/);
  assert.equal(fixture.runFile, path.join(home, 'runs', `${fixture.runId}.json`));
  if (phase === 'cleanup-context') {
    await withOwnedGatewayOffline(async () => {
      await rm(fixture.runFile);
    });
    await rm(receipt);
    console.log(JSON.stringify({ result: 'PASS', phase, nativeGateRemoved: true }));
    process.exit(0);
  }
  const diffContext = phase === 'diff-context' || phase === 'cold-diff-context';
  const artifactContext =
    phase === 'artifacts-context' ||
    phase === 'cold-artifacts-context' ||
    phase === 'stale-artifacts-context';
  proofRef = `runs-cache:${artifactContext ? 'artifacts' : diffContext ? 'diff' : 'detail'}:${fixture.runId}`;
  const route =
    phase === 'open-context'
      ? `workspace/run/${fixture.runId}/evidence`
      : phase === 'workspace-context'
        ? `workspace/run/${fixture.runId}/gate?decisionId=${fixture.decisionId}`
        : artifactContext
          ? `workspace/run/${fixture.runId}/files?recipeRun=decision-evidence&evidenceDecision=${fixture.decisionId}`
          : diffContext
            ? `workspace/run/${fixture.runId}/diff`
            : `gate-review/${fixture.decisionId}?runId=${fixture.runId}`;
  await inbox(route);
  const observed = await until(
    (value) =>
      value.detail?.status === 'ready' &&
      (!diffContext || (value.diffProjectionMatches && value.diffRecipes?.status === 'ready')) &&
      (!artifactContext ||
        (value.artifactProjectionMatches &&
          value.artifactRecipes?.status === 'ready' &&
          value.artifactPaths?.includes('artifacts/offline-store-proof.txt'))) &&
      value.decisionsStatus === 'ready' &&
      value.decisions.some(({ id }) => id === fixture.decisionId),
    'The selected native context must have current shared full detail and pending decision',
  );
  assert.equal(observed.detail.data.run.reviewResult.reviewMd, 'Saved offline review body.');
  if (artifactContext) {
    assert.equal(observed.artifactParams.runId, fixture.runId);
    assert.equal(observed.artifactParams.includeRecordedEvidence, true);
    assert.equal(
      observed.artifactParams.decisionId,
      fixture.decisionId,
      'Artifact reads must keep the selected frozen decision',
    );
    assert.equal(observed.artifactDecisionId, fixture.decisionId);
    assert(process.env.FARMSLOT_AGENT_DEVICE_STATE_DIR);
    const device = createAgentDeviceClient({
      stateDir: process.env.FARMSLOT_AGENT_DEVICE_STATE_DIR,
    });
    const id = platform === 'ios' ? process.env.IOS_SIMULATOR : process.env.ADB_SERIAL;
    const sessions = (await device.sessions.list()).filter((session) => session.device.id === id);
    assert.equal(sessions.length, 1);
    const selection = { session: sessions[0].name, platform, target: 'mobile' };
    const screen = () =>
      device.capture.snapshot({ ...selection, interactiveOnly: false, forceFull: true });
    const button = async (enabled) => {
      const deadline = Date.now() + 30000;
      let found;
      do {
        found = (await screen()).nodes.find(
          (node) => node.identifier === 'companion-artifacts-sync',
        );
        if (found?.enabled === enabled && found.rect) return found;
        await delay(100);
      } while (Date.now() < deadline);
      assert.fail(
        `The actual artifact sync button did not render enabled=${enabled}: ${JSON.stringify(found)}`,
      );
    };
    await button(true);
    if (phase === 'artifacts-context') {
      const sync = await button(true);
      await device.interactions.press({
        ...selection,
        x: sync.rect.x + sync.rect.width / 2,
        y: sync.rect.y + sync.rect.height / 2,
      });
      const deadline = Date.now() + 15000;
      let refused;
      do {
        refused = (await screen()).nodes.some((node) =>
          node.label?.includes('Run not attached to a slot'),
        );
        if (refused) break;
        await delay(50);
      } while (Date.now() < deadline);
      assert(
        refused,
        'The actual Sync artifacts command must show its physical missing-slot refusal',
      );
    } else {
      await withOwnedGatewayOffline(
        async () => {
          const stale = await until(
            (value) => value.detail?.status === 'stale' && value.artifactProjectionMatches,
            'The actual artifact view must retain its saved run after disconnect',
          );
          await until(
            (value) => value.artifactProjectionMatches && value.artifactSyncBusy === false,
            'An interrupted artifact sync must clear its current scope busy state',
          );
          await button(false);
          await restartNative();
          await inbox(route);
          const cold = await until(
            (value) =>
              value.startedAt > observed.startedAt &&
              value.detail?.status === 'stale' &&
              value.detail.data?.run.id === fixture.runId &&
              value.artifactProjectionMatches &&
              value.artifactPaths?.includes('artifacts/offline-store-proof.txt') &&
              !value.artifactRecipes?.data,
            'A cold artifact view must restore its frozen manifest from the saved full run',
          );
          assert.equal(cold.detail.observedAt, stale.detail.observedAt);
          assert.equal(cold.diagnostics.integrity, 'ok');
          await button(false);
          assert(
            (await screen()).nodes.some((node) => node.label?.includes('Saved run artifacts')),
            'The actual cold artifact view must show its saved age',
          );
          await device.capture.screenshot({
            ...selection,
            path: path.join(
              process.env.FARMSLOT_RECIPE_ARTIFACTS_DIR,
              'screenshots/native-artifacts-cold.png',
            ),
            stabilize: true,
          });
        },
        phase === 'stale-artifacts-context'
          ? {}
          : {
              beforeStop: async () => {
                const sync = await button(true);
                await device.interactions.press({
                  ...selection,
                  x: sync.rect.x + sync.rect.width / 2,
                  y: sync.rect.y + sync.rect.height / 2,
                });
                await until(
                  (value) => value.artifactSyncBusy === true,
                  'The artifact sync command must be pending while the owned gateway is stopped',
                );
                await button(false);
              },
            },
      );
      await until(
        (value) =>
          value.detail?.status === 'ready' &&
          value.artifactProjectionMatches &&
          value.artifactRecipes?.status === 'ready',
        'Reconnect must restore current artifact and frozen evidence observations',
      );
      await button(true);
    }
  }
  if (phase === 'cold-diff-context') {
    await withOwnedGatewayOffline(async () => {
      const stale = await until(
        (value) => value.detail?.status === 'stale' && value.diffProjectionMatches,
        'The actual diff render must retain its stale shared run',
      );
      await restartNative();
      await inbox(route);
      const cold = await until(
        (value) =>
          value.startedAt > observed.startedAt &&
          value.detail?.status === 'stale' &&
          value.detail.data?.run.id === fixture.runId &&
          value.diffProjectionMatches &&
          !value.diffRecipes?.data,
        'A cold diff must restore its actual full run without inventing persisted recipe data',
      );
      assert.equal(cold.detail.observedAt, stale.detail.observedAt);
      assert.equal(cold.diagnostics.integrity, 'ok');
      assert(process.env.FARMSLOT_AGENT_DEVICE_STATE_DIR);
      const device = createAgentDeviceClient({
        stateDir: process.env.FARMSLOT_AGENT_DEVICE_STATE_DIR,
      });
      const id = platform === 'ios' ? process.env.IOS_SIMULATOR : process.env.ADB_SERIAL;
      const sessions = (await device.sessions.list()).filter((session) => session.device.id === id);
      assert.equal(sessions.length, 1);
      const selection = { session: sessions[0].name, platform, target: 'mobile' };
      const screen = await device.capture.snapshot({
        ...selection,
        interactiveOnly: false,
        forceFull: true,
      });
      assert(
        screen.nodes.some((node) => node.label?.includes('Saved run diff')),
        'The actual cold diff must display its saved age',
      );
      await device.capture.screenshot({
        ...selection,
        path: path.join(
          process.env.FARMSLOT_RECIPE_ARTIFACTS_DIR,
          'screenshots/native-diff-cold.png',
        ),
        stabilize: true,
      });
    });
    await until(
      (value) =>
        value.detail?.status === 'ready' &&
        value.diffProjectionMatches &&
        value.diffRecipes?.status === 'ready',
      'Reconnect must refresh the actual diff render and recipe inputs',
    );
  }
  if (phase === 'stale-context') {
    assert(process.env.FARMSLOT_AGENT_DEVICE_STATE_DIR);
    const device = createAgentDeviceClient({
      stateDir: process.env.FARMSLOT_AGENT_DEVICE_STATE_DIR,
    });
    const id = platform === 'ios' ? process.env.IOS_SIMULATOR : process.env.ADB_SERIAL;
    const sessions = (await device.sessions.list()).filter((session) => session.device.id === id);
    assert.equal(sessions.length, 1);
    const selection = { session: sessions[0].name, platform, target: 'mobile' };
    const button = async () => {
      const screen = await device.capture.snapshot({
        ...selection,
        interactiveOnly: false,
        forceFull: true,
      });
      return screen.nodes.find(
        (node) => node.identifier === 'companion-gate-review-action-send-feedback',
      );
    };
    const renderedButton = async (enabled) => {
      const deadline = Date.now() + 30000;
      let rendered;
      do {
        rendered = await button();
        if (rendered?.enabled === enabled) return rendered;
        await delay(100);
      } while (Date.now() < deadline);
      assert.fail(`The native gate did not render enabled=${enabled}: ${JSON.stringify(rendered)}`);
    };
    const current = await renderedButton(true);
    assert.equal(
      current?.enabled,
      true,
      'The actual current gate must enable its send-feedback action',
    );
    const before = JSON.parse(await readFile(fixture.runFile, 'utf8')).decisions[0];
    await withOwnedGatewayOffline(async () => {
      await until(
        (value) => value.detail?.status === 'stale' && value.decisionsStatus === 'stale',
        'Both gate inputs must become stale',
      );
      const stale = await renderedButton(false);
      assert.equal(stale?.enabled, false, 'The actual saved gate action must be disabled');
      await device.capture.screenshot({
        ...selection,
        path: path.join(
          process.env.FARMSLOT_RECIPE_ARTIFACTS_DIR,
          'screenshots/native-gate-stale.png',
        ),
        stabilize: true,
      });
      assert.deepEqual(JSON.parse(await readFile(fixture.runFile, 'utf8')).decisions[0], before);
    });
    await until(
      (value) => value.detail?.status === 'ready' && value.decisionsStatus === 'ready',
      'Reconnect must reauthorize both gate inputs',
    );
    // Native rendering follows the cache publication; observe the actual button
    // rather than treating a ready store snapshot as a synchronous React commit.
    assert.equal(
      (await renderedButton(true))?.enabled,
      true,
      'Reconnect enables the still-pending gate after current reads',
    );
  }
  console.log(
    JSON.stringify({
      result: 'PASS',
      phase,
      nativeContextReady: true,
      ...(artifactContext
        ? {
            nativeArtifactProjection: true,
            nativeArtifactCold:
              phase === 'cold-artifacts-context' || phase === 'stale-artifacts-context',
          }
        : {}),
      ...(diffContext
        ? { nativeDiffProjection: true, nativeDiffCold: phase === 'cold-diff-context' }
        : {}),
      nativeGateStaleActions: phase === 'stale-context',
      runId: fixture.runId,
    }),
  );
  process.exit(0);
}
if (phase === 'seed-inbox') {
  await assert.rejects(access(receipt), { code: 'ENOENT' });
  await inbox();
  const initial = await until(
    (value) =>
      value.online &&
      value.runsStatus === 'ready' &&
      value.decisionsStatus === 'ready' &&
      value.decisionProjectionMatches,
    'Production native collections must be current before the external writer',
  );
  assert.equal(initial.diagnostics.integrity, 'ok');
  assert(/\/caches?\//i.test(initial.diagnostics.directory));
  const id = randomUUID();
  const project = path.join(home, 'projects', `offline-native-inbox-${id}`);
  const task = path.join(project, 'tasks', 'decision');
  const file = path.join(task, '.pending_decision.json');
  await mkdir(task, { recursive: true });
  await writeFile(receipt, JSON.stringify({ id, home, project, file, platform, metro }), {
    flag: 'wx',
    mode: 0o600,
  });
  try {
    await writeFile(
      file,
      JSON.stringify({
        id,
        type: 'blocked_alert',
        title: 'Offline native inbox proof',
        description: 'A worker file must reach the real native inbox without Refresh.',
        actions: [{ id: 'acknowledge', label: 'Acknowledge' }],
        created_at: new Date().toISOString(),
      }),
      { flag: 'wx' },
    );
    const arrived = await until(
      (value) =>
        value.decisionsStatus === 'ready' &&
        value.decisionProjectionMatches &&
        value.decisions.some((decision) => decision.id === id),
      'A worker-created decision must reach the native cache observation without Refresh',
    );
    console.log(
      JSON.stringify({
        result: 'PASS',
        phase,
        platform,
        id,
        nativeDecisionArrival: true,
        observedAt: arrived.decisionsObservedAt,
        runs: arrived.runs.length,
        sqliteIntegrity: arrived.diagnostics.integrity,
      }),
    );
  } catch (error) {
    await rm(project, { recursive: true });
    await rm(receipt);
    throw error;
  }
} else if (phase === 'resolve-inbox') {
  const fixture = JSON.parse(await readFile(receipt, 'utf8'));
  assert.equal(fixture.home, home);
  assert.equal(fixture.platform, platform);
  assert.equal(fixture.metro, metro);
  assert.match(fixture.id, /^[a-f0-9-]{36}$/);
  assert.equal(fixture.project, path.join(home, 'projects', `offline-native-inbox-${fixture.id}`));
  assert.equal(
    fixture.file,
    path.join(fixture.project, 'tasks', 'decision', '.pending_decision.json'),
  );
  try {
    await rpc('decision.resolve', { decisionId: fixture.id, actionId: 'acknowledge' });
    await assert.rejects(access(fixture.file), { code: 'ENOENT' });
    await until(
      (value) =>
        value.decisionsStatus === 'ready' &&
        value.decisionProjectionMatches &&
        !value.decisions.some((decision) => decision.id === fixture.id),
      'External resolution must remove the native decision through its current cache observation',
    );
    console.log(
      JSON.stringify({
        result: 'PASS',
        phase,
        platform,
        id: fixture.id,
        nativeDecisionRemoval: true,
        sourceRemoved: true,
      }),
    );
  } finally {
    await rm(fixture.project, { recursive: true });
    await rm(receipt);
  }
} else {
  assert(process.env.FARMSLOT_RUN_PROOF_FIXTURE);
  const fixture = JSON.parse(await readFile(process.env.FARMSLOT_RUN_PROOF_FIXTURE, 'utf8'));
  assert.equal(fixture.home, home);
  assert.match(fixture.runId, /^[a-f0-9-]{36}$/);
  assert.equal(fixture.runFile, path.join(home, 'runs', `${fixture.runId}.json`));
  const owned = JSON.parse(await readFile(fixture.runFile, 'utf8'));
  assert.equal(owned.readOnly, false, 'Use an owned run rather than an imported baseline row');
  proofRef = `runs-cache:detail:${fixture.runId}`;
  if (phase === 'open-detail') await inbox(`workspace/run/${fixture.runId}/evidence`);
  const observed = await until(
    (value) => value.detail?.status === 'ready' && value.recipes?.status === 'ready',
    'The real run screen must observe full detail and recipe groups through the shared cache',
  );
  const expected = await rpc('run.get', { runId: fixture.runId });
  assert.equal(observed.detail.data.run.id, fixture.runId);
  assert.deepEqual(observed.detail.data.run.output, expected.run.output);
  assert.deepEqual(observed.detail.data.run.decisions, expected.run.decisions);
  assert.equal(observed.diagnostics.integrity, 'ok');
  if (phase === 'cold-detail') {
    assert(process.env.FARMSLOT_AGENT_DEVICE_STATE_DIR, 'Reuse the recipe-owned device daemon');
    assert(process.env.FARMSLOT_RECIPE_ARTIFACTS_DIR);
    const device = createAgentDeviceClient({
      stateDir: process.env.FARMSLOT_AGENT_DEVICE_STATE_DIR,
    });
    const id = platform === 'ios' ? process.env.IOS_SIMULATOR : process.env.ADB_SERIAL;
    const sessions = (await device.sessions.list()).filter((session) => session.device.id === id);
    assert.equal(sessions.length, 1, 'Use the active recipe session on the owned device');
    const selection = { session: sessions[0].name, platform, target: 'mobile' };
    let cold;
    await withOwnedGatewayOffline(async () => {
      const stale = await until(
        (value) => value.detail?.status === 'stale' && value.detail.data?.run.id === fixture.runId,
        'Disconnect must retain the full run as stale',
      );
      assert(stale.detail.observedAt >= observed.detail.observedAt);
      const bundle = 'net.siteed.farmslot.development';
      const link = `farmslot-development://expo-development-client/?url=${encodeURIComponent(`http://127.0.0.1:${metro}`)}`;
      if (platform === 'ios') {
        await execute('xcrun', ['simctl', 'terminate', id, bundle]);
        await execute('xcrun', ['simctl', 'openurl', id, link]);
      } else {
        await execute('adb', ['-s', id, 'shell', 'am', 'force-stop', bundle]);
        await execute('adb', [
          '-s',
          id,
          'shell',
          'am',
          'start',
          '-a',
          'android.intent.action.VIEW',
          '-d',
          link,
          bundle,
        ]);
      }
      await waitForSimulatorRecipeBridge({ platform });
      await inbox(`workspace/run/${fixture.runId}/evidence`);
      cold = await until(
        (value) => value.detail?.status === 'stale' && value.detail.data?.run.id === fixture.runId,
        'A new offline JS runtime must restore the saved full-run observation',
      );
      assert(cold.startedAt > observed.startedAt, 'Require an actual cold app runtime');
      assert.equal(cold.detail.observedAt, stale.detail.observedAt);
      assert.deepEqual(cold.detail.data.run, stale.detail.data.run);
      assert.equal(cold.diagnostics.integrity, 'ok');
      const screen = await device.capture.snapshot({
        ...selection,
        interactiveOnly: false,
        forceFull: true,
      });
      assert(
        screen.nodes.some((node) => node.label?.startsWith('Saved run,')),
        'Render the actual saved-run age banner',
      );
      assert(
        screen.nodes.some((node) => node.label?.includes(expected.run.ticketOrPr)),
        'Render the owned run after the cold offline restart',
      );
      await device.capture.screenshot({
        ...selection,
        path: path.join(
          process.env.FARMSLOT_RECIPE_ARTIFACTS_DIR,
          'screenshots/native-run-cold.png',
        ),
        stabilize: true,
      });
    });
    await until(
      (value) =>
        value.detail?.status === 'ready' && value.detail.observedAt >= cold.detail.observedAt,
      'Reconnect must replace stale authority with a current full-run observation',
    );
    console.log(
      JSON.stringify({
        result: 'PASS',
        phase,
        platform,
        runId: fixture.runId,
        nativeColdRunDetail: true,
        observedAt: cold.detail.observedAt,
      }),
    );
    process.exit(0);
  }
  console.log(
    JSON.stringify({
      result: 'PASS',
      phase,
      platform,
      runId: fixture.runId,
      nativeRunDetail: true,
      observedAt: observed.detail.observedAt,
      recipeGroups: observed.recipes.data.recipeRuns.length,
      sqliteIntegrity: observed.diagnostics.integrity,
    }),
  );
}
