import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  access,
  chmod,
  cp,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  consumeD05Plan,
  D05FixtureOwner,
  d05InboxBody,
  d05NativeControl,
  resolveD05Inputs,
} from './d05-fixture.mjs';
import {
  draftRestored,
  openedNative,
  openOnSlot,
  sentThroughRunner,
  sentWhereShown,
  sessionRecreated,
  typedOnce,
} from './one-terminal-claims.mjs';

const execute = promisify(execFile);
// adb shell joins argv into a remote shell command, so a URL's query separators
// must remain inside one quoted argument on Android too.
const androidShellArgument = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const root = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, '');
const phase = process.argv[2];
if (phase === 'dry-preflight') {
  try {
    const plan = await resolveD05Inputs(process.env, root);
    await new Promise((resolve, reject) =>
      process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`, (error) =>
        error ? reject(error) : resolve(),
      ),
    );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
  process.exit(process.exitCode ?? 0);
}
// Native imports and subprocess work are unreachable from the headless dry phase.
const d05Phases = [
  'recorded-visual-context',
  'seed-inbox',
  'resolve-inbox',
  'open-detail',
  'cold-detail',
];
const d05 = d05Phases.includes(phase) ? await consumeD05Plan(process.env, root) : undefined;
const { createAgentDeviceClient } = await import('agent-device');
const { automationGatewayTarget } = await import('../../../../scripts/lib/gateway-profile.mjs');
const { createRunReplyProxy, createVisualReplyProxy } =
  await import('../../../../services/gateway/scripts/visual-reply-proxy.mjs');
const { withOwnedGatewayOffline } =
  await import('../../../command-center/scripts/owned-gateway-outage.mjs');
const { seedIOSGatewayProfile } = await import('./seed-ios-gateway-profile.mjs');
const { openAndroidDevClient, waitForSimulatorRecipeBridge } =
  await import('./simulator-dev-client.mjs');
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
    'unbound-slot-diff',
    'retry-artifacts',
    'retry-diff',
    'recorded-visual-context',
    'visual-context',
    'visual-wire-context',
    'terminal-context',
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
// Android proofs run on an emulator. A physical phone is used only when explicitly named, and
// every command still targets the development bundle alone.
const assertProofDevice = (serial) =>
  assert(
    serial?.startsWith('emulator-') ||
      (Boolean(serial) && serial === process.env.FARMSLOT_PROOF_PHYSICAL_SERIAL),
    'Use an emulator, or name the physical device in FARMSLOT_PROOF_PHYSICAL_SERIAL',
  );
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
    assertProofDevice(serial);
    await execute('adb', ['-s', serial, 'wait-for-device'], { timeout: 15000 });
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
    assertProofDevice(serial);
    // A cold launch needs the owned Metro tunnel as well as the selected gateway route.
    // Keep the gateway mapping intact: the wire proof temporarily routes it through its proxy.
    await execute('adb', ['-s', serial, 'reverse', `tcp:${metro}`, `tcp:${metro}`]);
    await execute('adb', ['-s', serial, 'shell', 'am', 'force-stop', bundle]);
    await openAndroidDevClient(serial, bundle, { waitForBridge: false });
  }
  await waitForSimulatorRecipeBridge({ platform });
}

if (phase === 'recorded-visual-context') {
  const { assertNativeVisualReceipt, nativeVisualSupportFiles, prepareNativeVisualFixture } =
    await import('./native-visual-fixture.mjs');
  // Reuse the same byte-preserving transport on iOS loopback or Android reverse routing.
  assert.equal(process.env.FARMSLOT_DISABLE_ORCHESTRATION, '1');
  assert(process.env.FARMSLOT_RUN_PROOF_FIXTURE && process.env.FARMSLOT_AGENT_DEVICE_STATE_DIR);
  assert(
    process.env.FARMSLOT_NATIVE_VISUAL_SOURCE,
    'Set the real retained media directory explicitly',
  );
  assert(process.env.FARMSLOT_RECIPE_ARTIFACTS_DIR);
  const baseline = d05.baseline;
  const template = JSON.parse(await readFile(baseline.runFile, 'utf8'));
  const runId = d05.visual.id;
  const project = d05.visual.project;
  const { projectsDir, declaredProjectNames } = await import('@farmslot/slot-config');
  assert.equal(projectsDir, d05.runtime.projectsDir);
  assert.equal(declaredProjectNames(), undefined, 'Use the isolated legacy project registry');
  const projectDir = d05.visual.projectDir;
  const directory = d05.visual.directory;
  const runFile = d05.visual.runFile;
  const owner = new D05FixtureOwner([projectDir, path.join(home, 'projects', project), runFile]);
  const deviceId = platform === 'ios' ? process.env.IOS_SIMULATOR : process.env.ADB_SERIAL;
  assert(deviceId, 'Select the single owned native device');
  if (platform === 'android') assertProofDevice(deviceId);
  let originalIOSProfile;
  if (platform === 'ios') {
    assert(
      process.env.FARMSLOT_NATIVE_VISUAL_IOS_PROFILE,
      'Provide the original isolated iOS profile JSON for setup and restoration',
    );
    originalIOSProfile = JSON.parse(
      await readFile(process.env.FARMSLOT_NATIVE_VISUAL_IOS_PROFILE, 'utf8'),
    );
    assert.equal(originalIOSProfile.authMode, 'token');
    assert(originalIOSProfile.presetSecret, 'Use the existing isolated service profile');
    assert(
      originalIOSProfile.presetSecret === selected.credential.token,
      'Native and independent reads must use the same isolated service credential',
    );
    assert.equal(new URL(originalIOSProfile.url).port, gateway.port);
    assert(['localhost', '127.0.0.1', '[::1]'].includes(new URL(originalIOSProfile.url).hostname));
  }
  const device = createAgentDeviceClient({ stateDir: process.env.FARMSLOT_AGENT_DEVICE_STATE_DIR });
  const sessions = (await device.sessions.list()).filter(
    (session) => session.device.id === deviceId,
  );
  assert.equal(sessions.length, 1);
  const selection = { session: sessions[0].name, platform, target: 'mobile' };
  const screen = async () => {
    const observed = await device.capture.snapshot({
      ...selection,
      interactiveOnly: false,
      forceFull: true,
    });
    await writeFile(
      path.join(process.env.FARMSLOT_RECIPE_ARTIFACTS_DIR, 'native-last-screen.json'),
      JSON.stringify(observed, null, 2),
    );
    return observed;
  };
  const find = async (label, enabled) => {
    const deadline = Date.now() + 10000;
    do {
      const node = d05NativeControl((await screen()).nodes, label);
      if (node?.rect && node.rect.y >= 0 && (enabled === undefined || node.enabled === enabled))
        return node;
      await device.interactions.scroll({ ...selection, direction: 'down', pixels: 240 });
      await delay(50);
    } while (Date.now() < deadline);
    await capture('native-missing-control.png');
    assert.fail(`Missing actual native control: ${label}, enabled=${enabled}`);
  };
  const pressNode = (node) =>
    device.interactions.press({
      ...selection,
      x: node.rect.x + node.rect.width / 2,
      y: node.rect.y + node.rect.height / 2,
    });
  const press = async (label) => pressNode(await find(label, true));
  const capture = (name) =>
    device.capture.screenshot({
      ...selection,
      path: path.join(process.env.FARMSLOT_RECIPE_ARTIFACTS_DIR, 'screenshots', name),
      stabilize: true,
    });
  let proxy;
  let seeded = false;
  let delegatorId;
  let iosProfileSeeded = false;
  try {
    await owner.directory(projectDir);
    await owner.directory(path.join(directory, 'artifacts'));
    const fixture = await prepareNativeVisualFixture({
      sourceRoot: root,
      sourceDirectory: d05.visual.media.source,
      taskDir: directory,
      runId,
      rpc,
      owner,
    });
    delegatorId = fixture.delegatorId;
    await owner.write(
      path.join(projectDir, 'project.json'),
      JSON.stringify({ name: project, visual_claim_review: fixture.projectPolicy }),
    );
    const taskFile = path.join(directory, 'TASK.md');
    await owner.write(taskFile, nativeVisualSupportFiles['TASK.md']);
    const now = new Date().toISOString();
    const run = {
      ...template,
      id: runId,
      familyId: runId,
      parentRunId: null,
      project,
      slotId: template.slotId,
      taskFile,
      activeTaskFile: taskFile,
      status: 'monitoring',
      ticketOrPr: 'Owned retained visual judgment proof',
      readOnly: false,
      steps: [],
      agentContexts: [],
      tags: [],
      artifactBundle: undefined,
      engineState: undefined,
      output: fixture.output,
      decisions: [fixture.decision],
      visualJudgmentReceipts: [],
      createdAt: now,
      updatedAt: now,
      completedAt: undefined,
    };
    await withOwnedGatewayOffline(async () => {
      await owner.write(runFile, JSON.stringify(run));
      seeded = owner.journal.files.some((entry) => entry.path === runFile);
    });
    await cp(
      path.join(directory, 'artifacts'),
      path.join(process.env.FARMSLOT_RECIPE_ARTIFACTS_DIR, 'retained-native-visual-fixture'),
      { recursive: true, errorOnExist: true, force: false },
    );
    const retained = await rpc('run.bundle.retain', { runId });
    assert(
      retained.ref && retained.missingData.length === 0,
      'Admit every byte through actual retention',
    );
    await writeFile(
      path.join(process.env.FARMSLOT_RECIPE_ARTIFACTS_DIR, 'native-visual-admission.json'),
      JSON.stringify(
        {
          runId,
          retained,
          sourceDirectory: fixture.sourceDirectory,
          closureIdentity: fixture.closureIdentity,
          manifestDigest: fixture.output.manifestDigest,
          inventory: fixture.inventory,
        },
        null,
        2,
      ),
      { flag: 'wx', mode: 0o600 },
    );
    const admitted = await rpc('run.recipeRunsForRun', {
      runId,
      includeRecordedEvidence: true,
      decisionId: fixture.decisionId,
      evidenceSnapshotHash: fixture.output.manifestDigest,
      recordedRecipeRunId: fixture.recipeRunId,
    });
    assert.deepEqual(admitted.recordedEvidence.errors, []);
    assert.equal(admitted.recordedEvidence.visualReviewContext.decisionId, fixture.decisionId);
    assert.deepEqual(
      admitted.recordedEvidence.visualReviewAuthority.projectPolicy,
      fixture.projectPolicy,
    );
    const progressParams = { slotId: template.slotId, runId };
    const progress = await rpc('task.progress', progressParams);
    assert.equal(progress.slotId, template.slotId, 'Require the actual owned progress endpoint');
    // Lead prerequisite: the shared proxy must admit task.progress in its method allowlist.
    // Its existing runId match scopes the default request; optional context selectors are absent.
    proxy = await createRunReplyProxy({
      upstreamPort: Number(gateway.port),
      runId,
      method: 'task.progress',
      armed: false,
    });
    if (platform === 'ios') {
      const proxyUrl = new URL(originalIOSProfile.url);
      proxyUrl.port = String(proxy.port);
      // Setup only, while stopped: keep the original service identity and credential.
      // No evidence, result, receipt or cache state is written to the app.
      iosProfileSeeded = true;
      seedIOSGatewayProfile({
        simulator: deviceId,
        bundleId: 'net.siteed.farmslot.development',
        profile: { ...originalIOSProfile, url: proxyUrl.href },
      });
      await execute('xcrun', [
        'simctl',
        'openurl',
        deviceId,
        `farmslot-development://expo-development-client/?url=${encodeURIComponent(`http://127.0.0.1:${metro}`)}`,
      ]);
      await waitForSimulatorRecipeBridge({ platform });
    } else {
      await execute('adb', ['-s', deviceId, 'reverse', `tcp:${gateway.port}`, `tcp:${proxy.port}`]);
      await restartNative();
    }
    proofRef = `runs-cache:detail:${runId}`;
    await inbox(`workspace/run/${runId}/evidence`);
    await until(
      (value) => value.detail?.status === 'ready' && value.detail.data.run.id === runId,
      'The real run detail must become current',
    );
    await press('Read report');
    await screen();
    await capture('native-after-read-report.png');
    const reason = `Review unchanged retained media ${runId}`;
    const fillReason = async () => {
      const input = await find(`Issue reason for ${fixture.claimId}`);
      await device.interactions.fill({
        ...selection,
        x: input.rect.x + 8,
        y: input.rect.y + 8,
        text: reason,
        verify: true,
      });
    };
    await fillReason();
    if (platform === 'android')
      await execute('adb', ['-s', deviceId, 'shell', 'input', 'keyevent', 'KEYCODE_BACK']);
    // A native tap on inert report text lets the ScrollView dismiss its keyboard.
    else await pressNode(await find('Recipe evidence is machine-checkable'));
    await find(`Looks right for ${fixture.claimId}`, true);
    await find(`Issue for ${fixture.claimId}`, true);
    await capture('native-recorded-visual-ready.png');
    proxy.arm();
    await rpc('run.tags.set', { runId, tags: ['held-current-read'] });
    const deadline = Date.now() + 10000;
    while (!proxy.state().held && Date.now() < deadline) await delay(20);
    assert.equal(proxy.state().held, true, 'Hold the actual default task.progress read');
    await find(`Issue for ${fixture.claimId}`, false);
    const disabled = await find(`Looks right for ${fixture.claimId}`, false);
    const before = proxy.state().counts['run.reviewVisualClaim'] ?? 0;
    await pressNode(disabled); // A real tap, never direct invocation of a private handler.
    await screen(); // Process a subsequent native observation before counting command attempts.
    await capture('native-recorded-visual-stale-tap.png');
    assert.equal(
      proxy.state().expired,
      false,
      'The stale tap must finish before the held response deadline',
    );
    assert.equal(
      proxy.state().counts['run.reviewVisualClaim'] ?? 0,
      before,
      'A stale tap sends zero judgment commands',
    );
    assert.deepEqual((await rpc('run.get', { runId })).run.visualJudgmentReceipts, []);
    proxy.release();
    // The confirmed receipt below must retain this exact typed reason after release.
    await find(`Looks right for ${fixture.claimId}`, true);
    await press(`Looks right for ${fixture.claimId}`);
    const receipt = async (verdict, count) => {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        if ((await rpc('run.get', { runId })).run.visualJudgmentReceipts.length === count + 1)
          return assertNativeVisualReceipt({
            rpc,
            runId,
            fixture,
            verdict,
            reason,
            previousReceiptCount: count,
          });
        await delay(50);
      }
      assert.fail(`No receipt for actual UI ${verdict}`);
    };
    const confirmed = await receipt('confirmed', 0);
    // Delegated reviews require prose for both verdicts; they remain editable.
    const change = (await screen()).nodes.find(
      (node) => node.label === `Change judgment for ${fixture.claimId}`,
    );
    if (change) await pressNode(change);
    await press(`Issue for ${fixture.claimId}`);
    await fillReason();
    if (platform === 'android')
      await execute('adb', ['-s', deviceId, 'shell', 'input', 'keyevent', 'KEYCODE_BACK']);
    // A native tap on inert report text lets the ScrollView dismiss its keyboard.
    else await pressNode(await find('Recipe evidence is machine-checkable'));
    await press('Record issue');
    const rejected = await receipt('rejected', 1);
    await capture('native-recorded-visual-rejected.png');
    const transport = proxy.state();
    assert.equal(
      transport.counts['run.reviewVisualClaim'],
      2,
      'Only two deliberate current submissions reach the gateway',
    );
    await writeFile(
      path.join(process.env.FARMSLOT_RECIPE_ARTIFACTS_DIR, 'native-visual-receipts.json'),
      JSON.stringify({ confirmed, rejected, transport }, null, 2),
      { flag: 'wx', mode: 0o600 },
    );
    console.log(
      JSON.stringify({
        result: 'PASS',
        nativeRecordedVisualJudgments: true,
        nativeRecordedVisualStaleZeroCommands: true,
        runId,
        confirmed,
        rejected,
      }),
    );
  } finally {
    try {
      if (proxy) {
        proxy.release();
        if (platform === 'ios' && iosProfileSeeded) {
          seedIOSGatewayProfile({
            simulator: deviceId,
            bundleId: 'net.siteed.farmslot.development',
            profile: originalIOSProfile,
          });
          await execute('xcrun', [
            'simctl',
            'openurl',
            deviceId,
            `farmslot-development://expo-development-client/?url=${encodeURIComponent(`http://127.0.0.1:${metro}`)}`,
          ]);
          await waitForSimulatorRecipeBridge({ platform });
        } else if (platform === 'android') {
          await execute('adb', [
            '-s',
            deviceId,
            'reverse',
            `tcp:${gateway.port}`,
            `tcp:${gateway.port}`,
          ]);
          await restartNative();
        }
      }
    } finally {
      try {
        await proxy?.close();
      } finally {
        try {
          if (seeded) {
            const expectedRun = (await rpc('run.get', { runId })).run;
            await withOwnedGatewayOffline(async () => {
              await owner.followRunWrites(runFile, expectedRun);
              await owner.cleanup();
            });
          } else await owner.cleanup();
          // Gateway cleanup can restart the service after profile restoration.
          // Await readiness without launching another app runtime.
          await waitForSimulatorRecipeBridge({ platform });
          await inbox();
          await until(
            (value) => value.online && value.runsStatus === 'ready',
            'Restored native profile must be current before the following cold recipe',
          );
        } finally {
          if (delegatorId) await rpc('principal.retire', { principalIds: [delegatorId] });
        }
      }
    }
  }
  process.exit(0);
}

if (phase === 'visual-context' || phase === 'visual-wire-context') {
  const wire = phase === 'visual-wire-context';
  if (wire)
    assert.equal(platform, 'android', 'The wire proof uses only the owned emulator reverse tunnel');
  assert.equal(process.env.FARMSLOT_DISABLE_ORCHESTRATION, '1');
  assert(process.env.FARMSLOT_RUN_PROOF_FIXTURE && process.env.FARMSLOT_AGENT_DEVICE_STATE_DIR);
  const fixture = JSON.parse(await readFile(process.env.FARMSLOT_RUN_PROOF_FIXTURE, 'utf8'));
  assert.equal(fixture.home, home);
  const template = JSON.parse(await readFile(fixture.runFile, 'utf8'));
  assert.equal(template.readOnly, false);
  const runId = randomUUID();
  const folder = `visual-store-${runId}`;
  const directory = path.join(home, 'projects/farmslot-farm/tasks', runId);
  const runFile = path.join(home, 'runs', `${runId}.json`);
  const taskFile = path.join(directory, 'TASK.md');
  await mkdir(path.join(directory, 'artifacts'), { recursive: true });
  const sourcePath = 'artifacts/visual-review-source.json';
  const sourceFile = path.join(directory, sourcePath);
  let seeded = false;
  let proxy;
  let proofFailure;
  let cleanupFailure;
  const device = createAgentDeviceClient({ stateDir: process.env.FARMSLOT_AGENT_DEVICE_STATE_DIR });
  const deviceId = platform === 'ios' ? process.env.IOS_SIMULATOR : process.env.ADB_SERIAL;
  const sessions = (await device.sessions.list()).filter(
    (session) => session.device.id === deviceId,
  );
  assert.equal(sessions.length, 1);
  const selection = { session: sessions[0].name, platform, target: 'mobile' };
  const screen = async () => {
    const observed = await device.capture.snapshot({
      ...selection,
      interactiveOnly: false,
      forceFull: true,
    });
    await writeFile(
      path.join(process.env.FARMSLOT_RECIPE_ARTIFACTS_DIR, 'native-last-screen.json'),
      JSON.stringify(observed, null, 2),
    );
    return observed;
  };
  const reveal = async (identifier, direction = 'down') => {
    for (let at = 0; at < 9; at++) {
      const node = (await screen()).nodes.find((node) => node.identifier === identifier);
      if (node?.rect && node.rect.y >= 0) return node;
      await device.interactions.scroll({ ...selection, direction, pixels: 320 });
    }
    assert.fail(`The actual visual-review control must be visible: ${identifier}`);
  };
  const press = async (identifier) => {
    const node = await reveal(identifier);
    await device.interactions.press({
      ...selection,
      x: node.rect.x + node.rect.width / 2,
      y: node.rect.y + node.rect.height / 2,
    });
  };
  const sendButton = async (enabled) => {
    const deadline = Date.now() + 20000;
    let button;
    do {
      button = await reveal('visual-review-send');
      if (button.enabled === enabled) return button;
      await delay(100);
    } while (Date.now() < deadline);
    assert.fail(
      `The actual visual Send button must become enabled=${enabled}: ${JSON.stringify(button)}`,
    );
  };
  const nativePhases = [];
  let startedAt = Date.now();
  const capture = async (name) => {
    await device.capture.screenshot({
      ...selection,
      path: path.join(process.env.FARMSLOT_RECIPE_ARTIFACTS_DIR, 'screenshots', name),
      stabilize: true,
    });
    nativePhases.push({ name, startedAt, endedAt: Date.now() });
    startedAt = Date.now();
  };
  const note = `Keep this visual draft ${randomUUID().slice(0, 8)}`;
  const tag = `native-visual-${randomUUID().slice(0, 8)}`;
  const draft = (value) =>
    value.visualState?.status === 'ready' && value.visualState.draft.surfaceNotes.proof === note;
  const canonical = (value) =>
    value.visualState?.status === 'ready' &&
    value.visualRunCanonical &&
    value.visualRecipesCanonical &&
    value.visualCommandsReady;
  proofRef = `runs-cache:visual:${runId}`;
  try {
    await inbox();
    const imageFile = path.join(directory, 'artifacts/screen.png');
    await device.capture.screenshot({ ...selection, path: imageFile, stabilize: true });
    // The source uses an actual square crop of the private app, keeping the note visible on a phone.
    await execute('sips', ['--cropToHeightWidth', '200', '200', imageFile]);
    const source = {
      version: 1,
      kind: 'visual-review-source',
      id: folder,
      title: 'Private visual store proof',
      capturedAt: new Date().toISOString(),
      runId: runId,
      surfaces: [
        {
          id: 'proof',
          title: 'Private app capture',
          captures: [
            { id: platform, platform, image: { path: 'screen.png', width: 200, height: 200 } },
          ],
        },
      ],
    };
    await writeFile(sourceFile, JSON.stringify(source), { flag: 'wx' });
    await writeFile(taskFile, 'Private visual-review store proof. No worker is launched.\n', {
      flag: 'wx',
    });
    const artifactManifest = await Promise.all(
      [sourceFile, imageFile].map(async (file) => {
        const bytes = await readFile(file);
        return {
          path: path.relative(directory, file),
          purpose: file === imageFile ? 'image' : 'json',
          sizeBytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        };
      }),
    );
    const now = new Date().toISOString();
    const run = {
      ...template,
      id: runId,
      familyId: runId,
      parentRunId: null,
      slotId: wire ? `offline-visual-unavailable-${runId}` : null,
      status: wire ? 'monitoring' : 'done',
      taskFile,
      ticketOrPr: 'Visual review shared store proof',
      steps: [],
      decisions: [],
      agentContexts: [],
      tags: [],
      readOnly: false,
      artifactBundle: undefined,
      engineState: undefined,
      createdAt: now,
      updatedAt: now,
      completedAt: now,
      output: {
        workerFinished: true,
        capturedAt: now,
        artifactManifest,
        manifestDigest: createHash('sha256').update(JSON.stringify(artifactManifest)).digest('hex'),
      },
    };
    await withOwnedGatewayOffline(async () => {
      await writeFile(runFile, JSON.stringify(run), { flag: 'wx', mode: 0o600 });
      seeded = true;
    });
    const retained = await rpc('run.bundle.retain', { runId });
    assert(
      retained.ref && retained.missingData.length === 0,
      'The real retention endpoint must capture every source/image byte',
    );
    if (wire) {
      assert.equal(
        (await rpc('fleet.status')).fleet.slots.some((slot) => slot.slot === run.slotId),
        false,
        'The wire target must not name any live slot',
      );
      proxy = await createVisualReplyProxy({ upstreamPort: Number(gateway.port), runId });
      await execute('adb', ['-s', deviceId, 'reverse', `tcp:${gateway.port}`, `tcp:${proxy.port}`]);
      await restartNative();
    }
    const route = `visual-review/${runId}?source=${encodeURIComponent(sourcePath)}`;
    await inbox(route);
    const initial = await until(
      (value) => canonical(value) && value.visualState.source.id === folder,
      'The actual visual review must use canonical full run and recipe observations',
    );
    await reveal('visual-review-surface-note');
    await device.interactions.fill({
      ...selection,
      selector: 'id="visual-review-surface-note"',
      text: note,
      verify: true,
    });
    if (platform === 'android')
      await execute('adb', ['-s', deviceId, 'shell', 'input', 'keyevent', 'KEYCODE_BACK']);
    else await device.command.keyboard({ ...selection, action: 'dismiss' });
    await until(draft, 'The note must come from the actual native input');
    await until(
      (value) => canonical(value) && draft(value),
      'Wait for current visual inputs after native note entry',
    );
    const send = await sendButton(true);
    assert.equal(send.enabled, true, 'Current visual-review inputs must allow explicit delivery');
    await capture('native-visual-current.png');
    await rpc('run.tags.set', { runId: runId, tags: [tag] });
    const updated = await until(
      (value) => canonical(value) && draft(value) && value.detail.data.run.tags?.includes(tag),
      'External run changes must update the visual-review observation without resetting its draft',
    );
    assert.deepEqual(updated.visualState.source, initial.visualState.source);
    assert.equal(updated.visualState.delivery.status, 'idle');
    await press('visual-review-send');
    if (wire) {
      const deadline = Date.now() + 10000;
      while (!proxy.state().held && Date.now() < deadline) await delay(20);
      assert.equal(
        proxy.state().held,
        true,
        'Hold an actual terminal.send reply from the real gateway',
      );
      assert.equal(
        proxy.state().responseOk,
        false,
        'The deliberately absent private slot must refuse delivery',
      );
      const wireTag = `native-visual-wire-${randomUUID().slice(0, 8)}`;
      await rpc('run.tags.set', { runId, tags: [tag, wireTag] });
      const refreshed = await until(
        (value) => canonical(value) && value.detail.data.run.tags?.includes(wireTag),
        'A same-socket external notification must revalidate the real visual observations',
      );
      assert(draft(refreshed));
      assert.equal(refreshed.connectionGeneration, initial.connectionGeneration);
      const pendingTransport = proxy.state();
      assert.equal(
        pendingTransport.expired,
        false,
        `The proof must observe pending before its reply deadline: ${JSON.stringify({ transport: pendingTransport, delivery: refreshed.visualState.delivery })}`,
      );
      assert.equal(
        refreshed.visualState.delivery.status,
        'pending',
        `Ordinary invalidation must not retire an on-wire visual acknowledgement: ${JSON.stringify({ transport: pendingTransport, delivery: refreshed.visualState.delivery })}`,
      );
      assert.equal(
        (await sendButton(false)).enabled,
        false,
        'The actual Send button must remain disabled while its wire reply is pending',
      );
      assert.equal(
        proxy.state().expired,
        false,
        'Release the held reply before the fixture deadline',
      );
      proxy.release();
      const settled = await until(
        (value) => draft(value) && value.visualState.delivery.status === 'failed',
        'The actual gateway refusal must settle the retained pending delivery',
      );
      assert.equal(settled.visualState.delivery.message, proxy.state().errorMessage);
      assert.equal(settled.connectionGeneration, initial.connectionGeneration);
      assert.equal(settled.startedAt, initial.startedAt);
      const transport = proxy.state();
      assert.equal(transport.requests, 1, 'Invalidation must never replay the terminal command');
      assert.equal(transport.responseDigest, transport.deliveredDigest);
      await capture('native-visual-wire-settled.png');
      assert.deepEqual((await rpc('run.get', { runId })).run.decisions, []);
      console.log(
        JSON.stringify({
          result: 'PASS',
          nativeVisualPendingReply: true,
          nativeVisualPendingDisabled: true,
          nativeVisualReplySettled: true,
          nativeVisualWireNoReplay: true,
          runId,
          nativePhases,
          transport,
          acceptedWorkerDeliveryProven: false,
          offlineContentBytesProven: false,
        }),
      );
    } else {
      const refused = await until(
        (value) =>
          draft(value) &&
          value.visualState.delivery.status === 'failed' &&
          value.visualState.delivery.message.includes('not attached'),
        'Finished private runs must refuse feedback before any terminal command',
      );
      await capture('native-visual-refused.png');
      let stale;
      await withOwnedGatewayOffline(async () => {
        stale = await until(
          (value) => draft(value) && value.detail?.status === 'stale' && !value.visualCommandsReady,
          'Disconnect must preserve the actual visual draft and pause delivery',
        );
        const disabled = await sendButton(false);
        assert.equal(
          disabled.enabled,
          false,
          'The actual visual feedback button must be disabled offline',
        );
        await device.interactions.scroll({ ...selection, direction: 'up', pixels: 1400 });
        const age = await screen();
        assert(
          age.nodes.some((node) => node.label?.startsWith('Saved visual review run,')),
          'The actual visual review must show saved run age',
        );
        await capture('native-visual-stale.png');
      });
      const recovered = await until(
        (value) =>
          canonical(value) && draft(value) && value.detail.observedAt >= stale.detail.observedAt,
        'Reconnect must revalidate visual context without replaying the refused feedback',
      );
      assert.deepEqual(recovered.visualState.delivery, refused.visualState.delivery);
      assert.equal(recovered.startedAt, initial.startedAt);
      await reveal('visual-review-send');
      await capture('native-visual-recovered.png');
      const after = (await rpc('run.get', { runId: runId })).run;
      assert.deepEqual(after.decisions, [], 'Visual feedback must resolve no gate');
      assert.equal(after.status, 'done');
      console.log(
        JSON.stringify({
          result: 'PASS',
          nativeVisualShared: true,
          nativeVisualDraft: true,
          nativeVisualStale: true,
          nativeVisualNoReplay: true,
          runId: runId,
          nativePhases,
          offlineContentBytesProven: false,
        }),
      );
    }
  } catch (error) {
    proofFailure = error;
  } finally {
    try {
      try {
        await inbox();
      } finally {
        try {
          if (proxy) {
            await execute('adb', ['-s', deviceId, 'wait-for-device'], { timeout: 15000 });
            await execute('adb', [
              '-s',
              deviceId,
              'reverse',
              `tcp:${gateway.port}`,
              `tcp:${gateway.port}`,
            ]);
            await restartNative();
          }
        } finally {
          await proxy?.close();
          if (seeded)
            await withOwnedGatewayOffline(async () => {
              await rm(runFile);
            });
          await rm(directory, { recursive: true });
        }
      }
    } catch (error) {
      cleanupFailure = error;
    }
  }
  if (proofFailure && cleanupFailure)
    throw new AggregateError(
      [proofFailure, cleanupFailure],
      'Visual proof and cleanup both failed',
    );
  if (proofFailure) throw proofFailure;
  if (cleanupFailure) throw cleanupFailure;
  process.exit(0);
}

if (['unbound-slot-diff', 'retry-artifacts', 'retry-diff'].includes(phase)) {
  assert.equal(process.env.FARMSLOT_DISABLE_ORCHESTRATION, '1');
  assert(process.env.FARMSLOT_AGENT_DEVICE_STATE_DIR);
  const device = createAgentDeviceClient({ stateDir: process.env.FARMSLOT_AGENT_DEVICE_STATE_DIR });
  const deviceId = platform === 'ios' ? process.env.IOS_SIMULATOR : process.env.ADB_SERIAL;
  const sessions = (await device.sessions.list()).filter(
    (session) => session.device.id === deviceId,
  );
  assert.equal(sessions.length, 1);
  const selection = { session: sessions[0].name, platform, target: 'mobile' };
  const screen = async () => {
    const observed = await device.capture.snapshot({
      ...selection,
      interactiveOnly: false,
      forceFull: true,
    });
    await writeFile(
      path.join(process.env.FARMSLOT_RECIPE_ARTIFACTS_DIR, 'native-last-screen.json'),
      JSON.stringify(observed, null, 2),
    );
    return observed;
  };
  const nativePhases = [];
  let startedAt = Date.now();
  const capture = async (name) => {
    await device.capture.screenshot({
      ...selection,
      path: path.join(process.env.FARMSLOT_RECIPE_ARTIFACTS_DIR, 'screenshots', name),
      stabilize: true,
    });
    nativePhases.push({ name, startedAt, endedAt: Date.now() });
    startedAt = Date.now();
  };
  if (phase === 'unbound-slot-diff') {
    const slotId = `offline-idle-diff-${randomUUID().slice(0, 8)}`;
    const repo = path.join(home, 'native-review-fixes', slotId);
    const poolFile = path.join(home, 'pool', `${slotId}.json`);
    await mkdir(repo, { recursive: true });
    const git = (...args) => execute('git', ['-C', repo, ...args]);
    try {
      await git('init');
      await writeFile(path.join(repo, 'proof.txt'), 'Initial idle slot content\n');
      await git('add', '--', 'proof.txt');
      await git(
        '-c',
        'commit.gpgsign=false',
        '-c',
        'user.name=Farmslot Proof',
        '-c',
        'user.email=proof@invalid',
        'commit',
        '-m',
        'test: seed idle diff fixture',
      );
      const marker = `UNBOUND_DIFF_${randomUUID().replaceAll('-', '')}`;
      await writeFile(path.join(repo, 'proof.txt'), `${marker}\n`);
      await writeFile(
        poolFile,
        JSON.stringify({
          machine: slotId,
          project: 'farmslot-farm',
          platform: 'cli',
          host: 'localhost',
          ssh_user: process.env.USER,
          os: 'darwin',
          slots: [{ id: slotId, enabled: false, repo, session: `${slotId}-unused`, resources: {} }],
        }),
        { flag: 'wx' },
      );
      const binding = await rpc('run.forSlot', { slotId });
      assert.equal(
        binding.run,
        null,
        'This configured idle slot must have no current or retained run',
      );
      const backend = await rpc('git.diff', { slotId });
      assert(
        backend.diff.includes(marker),
        'The real Git endpoint must report the working-tree edit',
      );
      await inbox(`workspace/slot/${slotId}/diff?path=proof.txt`);
      const deadline = Date.now() + 20000;
      let visible;
      do {
        const observed = await screen();
        visible = observed.nodes.some((node) => node.label?.includes(marker));
        if (visible) break;
        await delay(200);
      } while (Date.now() < deadline);
      await capture('native-unbound-slot-diff.png');
      assert(visible, 'An unbound slot must render its actual working-tree diff');
      assert.equal((await rpc('run.forSlot', { slotId })).run, null);
      console.log(
        JSON.stringify({
          result: 'PASS',
          nativeUnboundSlotDiff: true,
          slotId,
          marker,
          nativePhases,
        }),
      );
    } finally {
      await inbox();
      await rm(poolFile, { force: true });
      assert((await realpath(repo)).startsWith(`${home}/native-review-fixes/`));
      await rm(repo, { recursive: true });
    }
  } else {
    const diff = phase === 'retry-diff';
    const kind = diff ? 'diff' : 'artifact';
    const projection = (value) =>
      diff ? value.diffProjectionMatches : value.artifactProjectionMatches;
    const recipes = (value) => (diff ? value.diffRecipes : value.artifactRecipes);
    assert(process.env.FARMSLOT_RUN_PROOF_FIXTURE);
    const fixture = JSON.parse(await readFile(process.env.FARMSLOT_RUN_PROOF_FIXTURE, 'utf8'));
    assert.equal(fixture.home, home);
    const original = (await rpc('run.get', { runId: fixture.runId })).run;
    assert.equal(original.readOnly, false, 'Never fault an imported run');
    assert.equal(original.taskFile, fixture.taskFile);
    const ref = original.artifactBundle;
    assert(ref && /^[a-f0-9]{64}$/.test(ref.bundleDigest));
    const manifestFile = path.join(
      home,
      'run-bundles',
      'sha256',
      ref.bundleDigest,
      'manifest.json',
    );
    assert.equal(await realpath(manifestFile), manifestFile);
    const originalManifest = await readFile(manifestFile, 'utf8');
    const originalMode = (await stat(manifestFile)).mode & 0o777;
    const manifest = JSON.parse(originalManifest);
    assert(
      manifest.runs.length && manifest.runs.every((run) => run.originalRunId === fixture.runId),
    );
    const faultyManifest = `${originalManifest} `;
    const tag = `native-${kind}-retry-${randomUUID().slice(0, 8)}`;
    let faultActive = false;
    proofRef = `runs-cache:${diff ? 'diff' : 'artifacts'}:${fixture.runId}`;
    try {
      await inbox(`workspace/run/${fixture.runId}/${diff ? 'diff' : 'files'}`);
      const initial = await until(
        (value) =>
          projection(value) &&
          value.detail?.status === 'ready' &&
          recipes(value)?.status === 'ready',
        `The actual ${kind} view must first read current shared run and recipe data`,
      );
      assert(Number.isSafeInteger(initial.connectionGeneration));
      await capture(`native-${kind}-retry-current.png`);
      // Fault only this owned run's immutable metadata. The actual gateway refuses its digest.
      await chmod(manifestFile, originalMode | 0o200);
      faultActive = true;
      await writeFile(manifestFile, faultyManifest);
      await rpc('run.tags.set', { runId: fixture.runId, tags: [...(original.tags ?? []), tag] });
      const stale = await until(
        (value) =>
          projection(value) &&
          value.detail?.status === 'stale' &&
          value.detail.error &&
          recipes(value)?.status === 'stale' &&
          recipes(value).error,
        `A real failed refresh must retain ${kind} inputs as stale with an error`,
      );
      assert.equal(stale.detail.observedAt, initial.detail.observedAt);
      assert.equal(recipes(stale).observedAt, recipes(initial).observedAt);
      assert.equal(stale.connectionGeneration, initial.connectionGeneration);
      assert.equal(await readFile(manifestFile, 'utf8'), faultyManifest);
      await writeFile(manifestFile, originalManifest);
      await chmod(manifestFile, originalMode);
      faultActive = false;
      await capture(`native-${kind}-retry-error.png`);
      let retry;
      const deadline = Date.now() + 15000;
      do {
        retry = (await screen()).nodes.find(
          (node) =>
            node.label === (diff ? 'Retry diff' : 'Retry artifacts') || node.label === 'Retry',
        );
        if (retry?.rect) break;
        await delay(100);
      } while (Date.now() < deadline);
      assert(retry?.rect, `Stale ${kind} observations with errors must render a working Retry`);
      const before = await snapshot();
      assert(
        before.detail.error && recipes(before).error,
        'Require explicit Retry before any current read recovers',
      );
      await device.interactions.press({
        ...selection,
        x: retry.rect.x + retry.rect.width / 2,
        y: retry.rect.y + retry.rect.height / 2,
      });
      const recovered = await until(
        (value) =>
          projection(value) &&
          value.detail?.status === 'ready' &&
          recipes(value)?.status === 'ready' &&
          value.detail.data.run.tags?.includes(tag),
        `Explicit ${kind} Retry must recover both failed shared reads without reconnecting`,
      );
      assert.equal(
        recovered.startedAt,
        initial.startedAt,
        'Retry must preserve the native runtime',
      );
      assert.equal(
        recovered.connectionGeneration,
        initial.connectionGeneration,
        'Retry must recover on the same gateway connection',
      );
      await capture(`native-${kind}-retry-recovered.png`);
      console.log(
        JSON.stringify({
          result: 'PASS',
          [diff ? 'nativeRunDiffRetry' : 'nativeArtifactRetry']: true,
          retainedObservedAt: stale.detail.observedAt,
          recoveredObservedAt: recovered.detail.observedAt,
          connectionGeneration: recovered.connectionGeneration,
          nativePhases,
        }),
      );
    } finally {
      if (faultActive) {
        const current = await readFile(manifestFile, 'utf8');
        assert(current === faultyManifest || current === originalManifest);
        await writeFile(manifestFile, originalManifest);
        await chmod(manifestFile, originalMode);
      }
      assert.equal(await readFile(manifestFile, 'utf8'), originalManifest);
      assert.equal((await stat(manifestFile)).mode & 0o777, originalMode);
      await rpc('run.tags.set', { runId: fixture.runId, tags: original.tags ?? [] });
      await inbox();
    }
  }
  process.exit(0);
}

if (phase === 'terminal-context') {
  assert.equal(process.env.FARMSLOT_DISABLE_ORCHESTRATION, '1');
  assert(process.env.FARMSLOT_RUN_PROOF_FIXTURE && process.env.FARMSLOT_AGENT_DEVICE_STATE_DIR);
  const fixture = JSON.parse(await readFile(process.env.FARMSLOT_RUN_PROOF_FIXTURE, 'utf8'));
  assert.equal(fixture.home, home);
  const original = (await rpc('run.get', { runId: fixture.runId })).run;
  assert.equal(original.readOnly, false);
  assert.equal(original.slotId, fixture.slotId);
  const workerRepo = await realpath(fixture.workerRepo);
  assert(workerRepo.startsWith(`${home}/`));
  const pool = JSON.parse(
    await readFile(path.join(home, 'pool/offline-mirror-proof.json'), 'utf8'),
  );
  const ownedSlot = pool.slots.find((slot) => slot.id === fixture.slotId);
  assert.equal(ownedSlot.enabled, false);
  assert.equal(await realpath(ownedSlot.repo), workerRepo);
  const sessionName = ownedSlot.session;
  const sessionsBefore = (
    await execute('tmux', ['list-sessions', '-F', '#{socket_path}|#{pid}|#{session_name}'])
  ).stdout
    .trim()
    .split('\n');
  assert(
    sessionsBefore.length &&
      sessionsBefore.every((row) => row.split('|')[1] === sessionsBefore[0].split('|')[1]),
    'Use one existing tmux server',
  );
  const existed = sessionsBefore.some((row) => row.split('|')[2] === sessionName);
  const serverPid = sessionsBefore[0].split('|')[1];
  const sessionInfo = async () => {
    const { stdout } = await execute('tmux', [
      'list-panes',
      '-s',
      '-t',
      sessionName,
      '-F',
      '#{session_id}|#{session_created}|#{pane_pid}|#{pane_current_command}|#{pane_current_path}',
    ]);
    const rows = stdout.trim().split('\n');
    assert.equal(rows.length, 1, 'Only the private idle shell belongs to the proof');
    const [id, created, pid, command, cwd] = rows[0].split('|');
    assert(['zsh', 'bash', 'sh'].includes(command));
    assert.equal(await realpath(cwd), workerRepo);
    let children = [];
    const deadline = Date.now() + 5000;
    do {
      const processRows = (await execute('ps', ['-axo', 'pid=,ppid=,comm='])).stdout
        .trim()
        .split('\n');
      children = processRows.filter((row) => row.trim().split(/\s+/)[1] === pid);
      if (!children.length) break;
      await delay(100);
    } while (Date.now() < deadline);
    assert.equal(
      children.length,
      0,
      `Never send keys to or retire an active worker: ${JSON.stringify(children)}`,
    );
    return { id, created, pid, command, cwd };
  };
  const device = createAgentDeviceClient({ stateDir: process.env.FARMSLOT_AGENT_DEVICE_STATE_DIR });
  const deviceId = platform === 'ios' ? process.env.IOS_SIMULATOR : process.env.ADB_SERIAL;
  const devices = (await device.sessions.list()).filter(
    (session) => session.device.id === deviceId,
  );
  assert.equal(devices.length, 1);
  const selection = { session: devices[0].name, platform, target: 'mobile' };
  const nativeScreen = () =>
    device.capture.snapshot({ ...selection, interactiveOnly: false, forceFull: true });
  // A cold relaunch needs the app's own gateway mapping back as well as Metro's.
  const relaunch = async () => {
    await restartNative();
    if (platform === 'android')
      await execute('adb', [
        '-s',
        deviceId,
        'reverse',
        `tcp:${gateway.port}`,
        `tcp:${gateway.port}`,
      ]);
  };
  // Raw keys (BACK, typed text, Return) go only to the development app's own window, never to
  // another app that a relaunch briefly brings forward.
  const devAppFocused = async () => {
    const { stdout } = await execute('adb', ['-s', deviceId, 'shell', 'dumpsys', 'window']);
    const focus = stdout.split('\n').find((line) => line.includes('mCurrentFocus=')) ?? '';
    return { focused: focus.includes('net.siteed.farmslot.development/'), window: stdout };
  };
  const sendKeys = async (...args) => {
    assert((await devAppFocused()).focused, 'Keys go only to the development app');
    await execute('adb', ['-s', deviceId, 'shell', ...args]);
  };
  // The soft keyboard covers the key bar; BACK hides it only while it is showing.
  const hideKeyboard = async () => {
    if (platform !== 'android') return;
    const { focused, window } = await devAppFocused();
    if (focused && window.includes('mImeShowing=true'))
      await execute('adb', ['-s', deviceId, 'shell', 'input', 'keyevent', 'KEYCODE_BACK']);
  };
  // Send stays disabled until the pane is in the machine's inventory; press it once enabled.
  const pressEnabled = async (identifier) => {
    await hideKeyboard();
    const deadline = Date.now() + 30000;
    let found;
    do {
      found = (await nativeScreen()).nodes.find((node) => node.identifier === identifier);
      if (found?.enabled && found.rect) {
        await device.interactions.press({
          ...selection,
          x: found.rect.x + found.rect.width / 2,
          y: found.rect.y + found.rect.height / 2,
        });
        return;
      }
      await delay(250);
    } while (Date.now() < deadline);
    assert.fail(`${identifier} must become enabled: ${JSON.stringify(found)}`);
  };
  const button = async (enabled, label = '^L') => {
    await hideKeyboard();
    const deadline = Date.now() + 15000;
    let found;
    do {
      found = (await nativeScreen()).nodes.find((node) => node.label === label);
      if (found?.enabled === enabled && found.rect) return found;
      await delay(100);
    } while (Date.now() < deadline);
    assert.fail(`The actual terminal key must be enabled=${enabled}: ${JSON.stringify(found)}`);
  };
  const phases = [];
  let phaseStart = Date.now();
  const capture = async (name) => {
    await device.capture.screenshot({
      ...selection,
      path: path.join(process.env.FARMSLOT_RECIPE_ARTIFACTS_DIR, 'screenshots', name),
      stabilize: true,
    });
    phases.push({ name, startedAt: phaseStart, endedAt: Date.now() });
    phaseStart = Date.now();
  };
  // The slot's Terminal tab is the shared terminal, resolved to the run's pane.
  const route = `workspace/slot/${fixture.slotId}/terminal?runId=${fixture.runId}`;
  proofRef = `runs-cache:terminal:${fixture.runId}`;
  const current = (value) =>
    value.slotProjectionMatches && value.detail?.status === 'ready' && value.terminalReady;
  let ownedSession;
  let cold;
  const tag = `native-terminal-${randomUUID().slice(0, 8)}`;
  const shortTag = (prefix) => `${prefix}${randomUUID().replace(/-/g, '').slice(0, 8)}`;
  const paneText = async () =>
    (await execute('tmux', ['capture-pane', '-p', '-J', '-S', '-80', '-t', sessionName])).stdout;
  const untilPane = async (ready, label) => {
    const deadline = Date.now() + 30000;
    let text = '';
    do {
      text = await paneText();
      if (ready(text)) return text;
      await delay(200);
    } while (Date.now() < deadline);
    assert.fail(`${label}: ${JSON.stringify(text.split('\n').slice(-8))}`);
  };
  // Two review-round routing fixes, on runs this proof seeds into the private gateway home and
  // removes again: a CI-fix context saved as {window: null, target: '<session>:<window>'} opens
  // and sends to that window's pane, and a native review worktree opened by run id takes the
  // conversation branch instead of a worktree pane.
  const proveSeededRouting = async () => {
    const template = JSON.parse(await readFile(fixture.runFile, 'utf8'));
    const now = new Date().toISOString();
    const fixRunId = randomUUID();
    const reviewRunId = randomUUID();
    const files = [fixRunId, reviewRunId].map((id) => path.join(home, 'runs', `${id}.json`));
    const window = 'ot-fix';
    const seededRun = (id, overrides) => ({
      ...template,
      id,
      flowType: 'fix-bug',
      status: 'monitoring',
      tags: [],
      steps: [],
      decisions: [],
      readOnly: false,
      createdAt: now,
      updatedAt: now,
      completedAt: undefined,
      ...overrides,
    });
    const fixRun = seededRun(fixRunId, {
      slotId: fixture.slotId,
      agentContexts: [
        {
          id: 'ci-fix',
          role: 'ci-fix',
          label: 'CI fix',
          status: 'working',
          slotId: fixture.slotId,
          runId: fixRunId,
          runner: 'claude',
          // The shape services/gateway/src/ci-monitor/inline-fix.ts saves; context ids are the
          // role's own (contextIdFor), as the gateway requires.
          target: {
            session: sessionName,
            window: null,
            pane: null,
            target: `${sessionName}:${window}`,
          },
        },
      ],
    });
    // A native run is readable only with a recorded owner; the operator who reads it owns it.
    const { principals } = await rpc('principal.list');
    const operator = principals.find(
      (principal) =>
        principal.subject.type === 'person' &&
        principal.roles.some((grant) => grant.role === 'admin'),
    );
    assert(operator, 'The sandbox must have an admin person for the native review run');
    const reviewRun = seededRun(reviewRunId, {
      slotId: null,
      transport: 'native',
      nativeOwnerPrincipalId: operator.id,
      reviewWorkspace: {
        workspaceId: `ot-${reviewRunId.slice(0, 8)}`,
        machine: pool.machine,
        executionNodeId: 'local',
        checkoutPath: workerRepo,
        taskPath: template.taskFile,
        artifactPath: path.dirname(template.taskFile),
      },
      agentContexts: [
        {
          id: 'review',
          role: 'review',
          label: 'Review',
          status: 'working',
          slotId: null,
          runId: reviewRunId,
          runner: 'claude',
        },
      ],
    });
    let seeded = false;
    let windowOpen = false;
    try {
      await sessionInfo();
      await execute('tmux', [
        'new-window',
        '-d',
        '-t',
        `=${sessionName}:`,
        '-n',
        window,
        '-c',
        workerRepo,
      ]);
      windowOpen = true;
      const paneOf = async (target) =>
        (
          await execute('tmux', ['display-message', '-p', '-t', target, '#{pane_id}'])
        ).stdout.trim();
      const fixPane = await paneOf(`=${sessionName}:${window}`);
      const shellPane = await paneOf(`=${sessionName}:^`);
      assert.notEqual(fixPane, shellPane);
      await withOwnedGatewayOffline(async () => {
        await writeFile(files[0], JSON.stringify(fixRun), { flag: 'wx', mode: 0o600 });
        await writeFile(files[1], JSON.stringify(reviewRun), { flag: 'wx', mode: 0o600 });
        seeded = true;
      });

      // Saved target: the pane shown and the pane terminal.send types into are the same.
      const sent = shortTag('os');
      proofRef = `runs-cache:terminal:${fixRunId}`;
      await inbox(
        `workspace/slot/${fixture.slotId}/terminal?runId=${fixRunId}&contextId=ci-fix&draft=${encodeURIComponent(`echo ${sent}`)}`,
      );
      const opened = await until(
        (value) =>
          value.terminalReady &&
          value.terminalStream === 'live' &&
          value.terminalDraft === `echo ${sent}`,
        'The saved CI-fix target must open its own window',
      );
      assert.deepEqual(opened.terminalTarget, {
        slotId: fixture.slotId,
        runId: fixRunId,
        contextId: 'ci-fix',
        role: 'ci-fix',
      });
      await pressEnabled('worker-voice-send');
      await until(
        (value) => sentThroughRunner(value, opened.terminalSends?.length ?? 0),
        "The saved target's Send must go through terminal.send",
      );
      const capturePane = async (pane) =>
        (await execute('tmux', ['capture-pane', '-p', '-J', '-S', '-80', '-t', pane])).stdout;
      const deadline = Date.now() + 30000;
      let shown;
      do {
        shown = await snapshot();
        if (
          sentWhereShown(
            shown,
            fixPane,
            await capturePane(fixPane),
            await capturePane(shellPane),
            sent,
          )
        )
          break;
        await delay(200);
      } while (Date.now() < deadline);
      assert(
        sentWhereShown(
          shown,
          fixPane,
          await capturePane(fixPane),
          await capturePane(shellPane),
          sent,
        ),
        `The pane shown must be the pane terminal.send typed into: ${JSON.stringify(shown?.terminalWorker)} vs ${fixPane}`,
      );
      await capture('native-terminal-saved-target.png');

      // Native review worktree: the run link takes the conversation branch.
      proofRef = `runs-cache:terminal:${reviewRunId}`;
      await inbox(`terminal/worker?runId=${reviewRunId}`);
      await until(openedNative, 'A native review worktree must open its conversation, not a pane');
      await capture('native-terminal-native-review.png');
    } finally {
      proofRef = `runs-cache:terminal:${fixture.runId}`;
      await inbox('runs');
      if (seeded)
        await withOwnedGatewayOffline(async () => {
          for (const file of files) await rm(file, { force: true });
        });
      if (windowOpen) await execute('tmux', ['kill-window', '-t', `=${sessionName}:${window}`]);
    }
  };

  // The shared terminal must create the missing slot session itself (terminal.reinit); a
  // previous run of this proof retires the session it created.
  assert(!existed, `Start without the private proof session ${sessionName}`);
  let proofError;
  try {
    // A clean launch: screens left stacked by an earlier run keep their own input lines. A link
    // sent while the relaunched app is still starting can be dropped, so it is sent again.
    await relaunch();
    for (let attempt = 0; attempt < 3; attempt++) {
      await inbox(route);
      const deadline = Date.now() + 15000;
      let opened;
      do {
        opened = (await snapshot())?.terminalReady !== undefined;
        if (!opened) await delay(250);
      } while (!opened && Date.now() < deadline);
      if (opened) break;
    }
    const initial = await until(
      (value) =>
        current(value) &&
        value.terminalStream === 'live' &&
        !value.terminalInputDisabledReason &&
        value.terminalBufferText?.includes(path.basename(workerRepo)),
      'The shared terminal must subscribe only after its current run resolves a pane',
    );
    assert.deepEqual(initial.terminalTarget, { slotId: fixture.slotId, bareSession: true });
    ownedSession = await sessionInfo();
    assert(
      sessionRecreated(initial, Boolean(ownedSession)),
      `The missing slot session must be created through terminal.reinit: ${initial.terminalReinit}`,
    );
    if (!existed)
      assert(
        Number(ownedSession.created) >= Math.floor(phaseStart / 1000),
        'Only retire the session created by this proof',
      );
    const clear = await button(true);
    await device.interactions.press({
      ...selection,
      x: clear.rect.x + clear.rect.width / 2,
      y: clear.rect.y + clear.rect.height / 2,
    });
    await until(
      (value) =>
        value.terminalInputCommands === 1 &&
        !value.terminalControlBusy &&
        !value.terminalControlError,
      'The actual terminal key must send through the verified private idle shell',
    );

    // Typing once: the input line types the line and the keyboard's Return runs it, once.
    const typed = shortTag('ot');
    await sessionInfo();
    if (platform === 'android') {
      // Typed at a person's pace into the focused line: keys injected microseconds apart race
      // the emulator's input method and arrive garbled.
      await device.interactions.press({ ...selection, selector: 'id="terminal-input-line"' });
      const keys = [...`echo ${typed}`]
        .map((key) => `input text '${key === ' ' ? '%s' : key}'; sleep 0.12;`)
        .join(' ');
      await sendKeys(keys);
      await sendKeys('input', 'keyevent', 'KEYCODE_ENTER');
    } else {
      await device.interactions.fill({
        ...selection,
        selector: 'id="terminal-input-line"',
        text: `echo ${typed}\n`,
      });
    }
    await untilPane((text) => typedOnce(text, typed), 'The input line must type its line once');
    await hideKeyboard();
    await capture('native-terminal-typed-once.png');

    // An old /terminal/<slot> link opens the same shared terminal on that slot.
    await inbox('runs');
    // The proof reads only the focused terminal: on another screen it has no terminal frame.
    await until((value) => value.terminalReady === undefined, 'Leave the terminal first');
    await inbox(`terminal/${fixture.slotId}?runId=${fixture.runId}`);
    await until(
      (value) => value.slotProjectionMatches && openOnSlot(value, fixture.slotId),
      'The old /terminal/<slot> link must open the shared terminal on its slot',
    );

    // A draft is kept per pane: it comes back after a relaunch, and Send from a slot-opened
    // terminal goes through the runner's terminal.send (typed by the gateway, once).
    const drafted = shortTag('od');
    const draftText = `echo ${drafted}`;
    await inbox(`${route}&draft=${encodeURIComponent(draftText)}`);
    await until(
      (value) => openOnSlot(value, fixture.slotId) && value.terminalDraft === draftText,
      'A handed-over draft must reach the shared terminal composer',
    );
    await relaunch();
    await inbox(route);
    const restored = await until(
      (value) => openOnSlot(value, fixture.slotId) && draftRestored(value, draftText),
      'The unsent draft must come back on the same pane after a relaunch',
    );
    await capture('native-terminal-draft-restored.png');
    const sendsBefore = restored.terminalSends?.length ?? 0;
    await sessionInfo();
    await pressEnabled('worker-voice-send');
    await until(
      (value) => sentThroughRunner(value, sendsBefore) && value.terminalDraft === '',
      "Send from a slot-opened terminal must go through the runner's terminal.send once",
    );
    await untilPane(
      (text) => typedOnce(text, drafted),
      'The runner must type the sent line into the pane once',
    );
    await capture('native-terminal-runner-send.png');

    // The relaunch above mounted a new terminal: the stream baseline is its current one.
    const beforeWrite = await until(
      (value) => current(value) && value.terminalStream === 'live',
      'The relaunched terminal must be live before the external write',
    );
    await rpc('run.tags.set', { runId: fixture.runId, tags: [...(original.tags ?? []), tag] });
    const updated = await until(
      (value) => current(value) && value.detail.data.run.tags?.includes(tag),
      'The rendered terminal run must follow an external write',
    );
    assert.equal(
      updated.terminalSubscriptionStarts,
      beforeWrite.terminalSubscriptionStarts,
      'Ordinary run invalidation must not restart the terminal stream',
    );
    const committed = await until(
      (value) => current(value) && value.storedDetail?.observedAt === value.detail.observedAt,
      'The actual terminal full-run row must reach SQLite before the cold restart',
    );
    assert(committed.storedDetail.bytes > 0);
    await capture('native-terminal-current.png');
    await withOwnedGatewayOffline(async () => {
      // Keys are never gated offline: they queue, and the terminal says Offline after the grace.
      const stale = await until(
        (value) => value.detail?.status === 'stale' && value.slotProjectionMatches,
        'A disconnected terminal must retain its run facts',
      );
      await capture('native-terminal-stale.png');
      await relaunch();
      await inbox(route);
      cold = await until(
        (value) =>
          value.startedAt > initial.startedAt &&
          value.detail?.status === 'stale' &&
          value.slotProjectionMatches,
        'A cold terminal must restore its actual saved run while offline',
      );
      assert.equal(cold.detail.observedAt, stale.detail.observedAt);
      assert.equal(cold.diagnostics.integrity, 'ok');
      await capture('native-terminal-cold.png');
    });
    await until(
      (value) =>
        current(value) && value.terminalStream === 'live' && !value.terminalInputDisabledReason,
      'Terminal reconnect requires current run inputs before commands resume',
    );
    assert.equal(
      (await snapshot()).terminalInputCommands,
      0,
      'Cold reconnect must never replay a terminal key',
    );
    await inbox(`${route}&contextId=offline-proof-missing-actor`);
    const pinned = await until(
      // A refused actor has current run facts but no pane.
      (value) =>
        value.slotProjectionMatches &&
        value.detail?.status === 'ready' &&
        value.terminalStream === 'ended' &&
        value.terminalSnapshotError,
      'An unavailable explicit actor must show the real gateway refusal',
    );
    assert.equal(pinned.terminalTarget.contextId, 'offline-proof-missing-actor');
    assert.equal(pinned.terminalTarget.runId, fixture.runId);
    assert.equal(pinned.terminalTarget.bareSession, undefined);
    await until(
      (value) =>
        value.terminalSnapshotError &&
        !value.terminalBufferText?.includes(path.basename(workerRepo)),
      'Changing the terminal actor must clear the actual previous pane buffer',
    );
    await capture('native-terminal-pin-refused.png');
    await proveSeededRouting();
    console.log(
      JSON.stringify({
        result: 'PASS',
        phase,
        nativeTerminalShared: true,
        nativeTerminalCommand: true,
        nativeTerminalCold: true,
        nativeTerminalSqlTimestamp: committed.storedDetail.observedAt,
        nativeTerminalPinRefused: true,
        nativeTerminalClearsPane: true,
        nativeTerminalReinit: true,
        nativeTerminalTypedOnce: true,
        nativeTerminalLegacyRoute: true,
        nativeTerminalDraftRestored: true,
        nativeTerminalRunnerSend: true,
        nativeTerminalSavedTarget: true,
        nativeTerminalNativeReview: true,
        noTerminalReplay: true,
        nativePhases: phases,
        observedAt: cold.detail.observedAt,
      }),
    );
  } catch (error) {
    proofError = error;
  }
  // The proof's first failure is the result: cleanup failures are reported after it and never
  // replace it (a gateway still restarting from the outage step used to mask the real error).
  const cleanupErrors = [];
  const cleanup = async (step) => {
    try {
      await step();
    } catch (error) {
      cleanupErrors.push(error);
    }
  };
  await cleanup(() => rpc('run.tags.set', { runId: fixture.runId, tags: original.tags ?? [] }));
  await cleanup(() => inbox('runs'));
  if (!existed)
    await cleanup(async () => {
      const rows = (await execute('tmux', ['list-sessions', '-F', '#{pid}|#{session_name}'])).stdout
        .trim()
        .split('\n');
      assert(
        rows.every((row) => row.split('|')[0] === serverPid),
        'Never change the tmux server',
      );
      if (rows.some((row) => row.split('|')[1] === sessionName)) {
        const idle = await sessionInfo();
        if (ownedSession) assert.equal(idle.id, ownedSession.id);
        await execute('tmux', ['kill-session', '-t', idle.id]);
      }
    });
  for (const error of cleanupErrors)
    console.error(`Cleanup also failed: ${error instanceof Error ? error.message : error}`);
  if (proofError) throw proofError;
  if (cleanupErrors.length) throw cleanupErrors[0];
  process.exit(0);
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
  await waitForSimulatorRecipeBridge({ platform });
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
  const id = d05.inbox.id;
  const project = d05.inbox.project;
  const task = path.dirname(d05.inbox.file);
  const file = d05.inbox.file;
  const existingReceipt = await readFile(receipt, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  const previous = existingReceipt && JSON.parse(existingReceipt);
  if (previous) assert.equal(previous.planId, d05.planId);
  const owner = new D05FixtureOwner([project, receipt], previous?.ownership);
  let createdReceipt = false;
  try {
    await owner.directory(task);
    await owner.write(file, d05InboxBody(d05));
    const nextReceipt = JSON.stringify({
      id,
      home,
      project,
      file,
      platform,
      metro,
      planId: d05.planId,
      receiptOwned: true,
      ownership: owner.journal,
    });
    if (previous) {
      // This is our previously checked receipt, not an arbitrary existing file.
      await writeFile(receipt, nextReceipt, { mode: 0o600 });
    } else {
      await writeFile(receipt, nextReceipt, { flag: 'wx', mode: 0o600 });
      createdReceipt = true;
    }
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
    await owner.cleanup();
    if (createdReceipt) await rm(receipt);
    throw error;
  }
} else if (phase === 'resolve-inbox') {
  const fixture = JSON.parse(await readFile(receipt, 'utf8'));
  assert.equal(fixture.planId, d05.planId);
  assert.equal(fixture.id, d05.inbox.id);
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
    assert.equal(fixture.planId, d05.planId);
    await new D05FixtureOwner([fixture.project, receipt], fixture.ownership).cleanup();
    assert.equal(fixture.receiptOwned, true);
    await rm(receipt);
  }
} else {
  assert(process.env.FARMSLOT_RUN_PROOF_FIXTURE);
  const fixture =
    d05?.baseline ?? JSON.parse(await readFile(process.env.FARMSLOT_RUN_PROOF_FIXTURE, 'utf8'));
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
    assert.equal(platform, 'ios', 'The bounded cold collection pass currently authorizes iOS only');
    const decisionFixture = JSON.parse(await readFile(receipt, 'utf8'));
    assert.equal(decisionFixture.home, home);
    assert.equal(decisionFixture.planId, d05.planId);
    assert.equal(decisionFixture.id, d05.inbox.id);
    assert.equal(decisionFixture.platform, platform);
    const decisionBytes = await readFile(decisionFixture.file, 'utf8');
    const nativeScreen = () =>
      device.capture.snapshot({ ...selection, interactiveOnly: false, forceFull: true });
    const captureCollections = async (route, prefix, expectedText, name) => {
      await inbox(route);
      const deadline = Date.now() + 10000;
      let rendered;
      const hasFixture = (frame) =>
        frame.nodes.some((node) =>
          route === 'runs'
            ? node.label === d05.savedRun.selector
            : node.label?.includes(expectedText),
        );
      do {
        rendered = await nativeScreen();
        if (rendered.nodes.some((node) => node.label?.startsWith(prefix)) && hasFixture(rendered))
          break;
        if (route === 'runs' && !hasFixture(rendered))
          await device.interactions.scroll({ ...selection, direction: 'down', pixels: 240 });
        await delay(100);
      } while (Date.now() < deadline);
      await device.capture.screenshot({
        ...selection,
        path: path.join(process.env.FARMSLOT_RECIPE_ARTIFACTS_DIR, 'screenshots', name),
        stabilize: true,
      });
      await writeFile(
        path.join(process.env.FARMSLOT_RECIPE_ARTIFACTS_DIR, name + '.snapshot.json'),
        JSON.stringify(rendered),
      );
      assert(
        rendered.nodes.some((node) => node.label?.startsWith(prefix)),
        `Render ${prefix} age banner`,
      );
      assert(hasFixture(rendered), `Render saved ${route} fixture row`);
    };
    // Real navigation warms the same product queries that the snapshot observes read-only.
    await inbox('runs');
    await inbox('inbox');
    const warmCollections = await until(
      (value) =>
        value.runsStatus === 'ready' &&
        value.decisionsStatus === 'ready' &&
        value.decisionProjectionMatches &&
        value.activeIds?.includes(d05.savedRun.id) &&
        value.runs.some(
          (row) => row.id === d05.savedRun.id && row.ticketOrPr === d05.savedRun.title,
        ) &&
        value.decisions.some((row) => row.id === decisionFixture.id),
      'Warm nonempty Runs and the actual worker decision before going offline',
    );
    assert.equal(warmCollections.diagnostics.integrity, 'ok');
    await captureCollections('runs', '', expected.run.ticketOrPr, 'native-runs-list-warm.png');
    await captureCollections('inbox', '', 'Offline native inbox proof', 'native-inbox-warm.png');
    assert(warmCollections.runsObservedAt && warmCollections.decisionsObservedAt);
    const runIds = (value) => value.runs.map((row) => row.id).sort();
    const decisionIds = (value) => value.decisions.map((row) => row.id).sort();
    await inbox(`workspace/run/${fixture.runId}/evidence`);
    let cold;
    let coldCollections;
    let storedCollections;
    await withOwnedGatewayOffline(async () => {
      const stale = await until(
        (value) => value.detail?.status === 'stale' && value.detail.data?.run.id === fixture.runId,
        'Disconnect must retain the full run as stale',
      );
      assert(stale.detail.observedAt >= observed.detail.observedAt);
      const savedCollections = await until(
        (value) =>
          value.runsStatus === 'stale' &&
          value.decisionsStatus === 'stale' &&
          value.decisionProjectionMatches,
        'Disconnect marks both saved collections stale',
      );
      assert.deepEqual(runIds(savedCollections), runIds(warmCollections));
      assert.deepEqual(decisionIds(savedCollections), decisionIds(warmCollections));
      // Inspect the actual SQLite file, read-only, after its product writes have settled.
      const directory = savedCollections.diagnostics.directory.startsWith('file:')
        ? fileURLToPath(savedCollections.diagnostics.directory)
        : savedCollections.diagnostics.directory;
      const database = path.join(directory, savedCollections.diagnostics.filename);
      const scope = JSON.parse(savedCollections.workspaceKey).scope;
      const { stdout: sql } = await execute('python3', [
        '-c',
        'import sqlite3,json,sys; db=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True); rows=db.execute("SELECT q.id,q.observed_at,q.data FROM resource_queries q JOIN resource_stores s ON q.store_id=s.id WHERE s.scope_id=?",(sys.argv[2],)).fetchall(); print(json.dumps([dict(id=r[0],observedAt=r[1],data=json.loads(r[2])) for r in rows]))',
        database,
        scope,
      ]);
      storedCollections = JSON.parse(sql);
      const storedRuns = storedCollections.find((row) => row.id === 'run.list:{"active":true}');
      const storedDecisions = storedCollections.find((row) => row.id === 'decision.list:{}');
      assert(storedRuns?.data.runs.length > 0, 'Actual SQLite must contain nonempty active runs');
      assert.deepEqual(
        storedRuns.data.runs.map((row) => row.id).sort(),
        [...savedCollections.activeIds].sort(),
        'SQLite active IDs must match the observed saved rows',
      );
      assert(storedRuns.observedAt > 0);
      assert(
        storedDecisions?.data.decisions.some((row) => row.id === decisionFixture.id),
        'Actual SQLite must contain the worker decision',
      );
      assert.equal(storedDecisions.observedAt, savedCollections.decisionsObservedAt);

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
      coldCollections = await until(
        (value) =>
          value.runsStatus === 'stale' &&
          value.decisionsStatus === 'stale' &&
          value.decisionProjectionMatches &&
          value.decisions.some((row) => row.id === decisionFixture.id),
        'Cold offline runtime restores both collections from SQLite',
      );
      assert(coldCollections.startedAt > warmCollections.startedAt);
      assert.deepEqual(runIds(coldCollections), runIds(savedCollections));
      assert.deepEqual(
        [...coldCollections.activeIds].sort(),
        storedRuns.data.runs.map((row) => row.id).sort(),
      );
      assert.deepEqual(decisionIds(coldCollections), decisionIds(savedCollections));
      assert.equal(coldCollections.runsObservedAt, savedCollections.runsObservedAt);
      assert.equal(coldCollections.decisionsObservedAt, savedCollections.decisionsObservedAt);
      await captureCollections(
        'runs',
        'Saved runs,',
        expected.run.ticketOrPr,
        'native-runs-list-cold.png',
      );
      await captureCollections(
        'inbox',
        'Saved decisions,',
        'Offline native inbox proof',
        'native-inbox-cold.png',
      );
      await inbox(`decision/${decisionFixture.id}`);
      let action;
      const actionDeadline = Date.now() + 10000;
      do {
        action = (await nativeScreen()).nodes.find(
          (node) => node.label === 'Acknowledge' && node.rect,
        );
        if (action?.enabled === false) break;
        await device.interactions.scroll({ ...selection, direction: 'down', pixels: 240 });
        await delay(100);
      } while (Date.now() < actionDeadline);
      assert.equal(action?.enabled, false, 'The actual saved decision command must be disabled');
      await device.interactions.press({
        ...selection,
        x: action.rect.x + action.rect.width / 2,
        y: action.rect.y + action.rect.height / 2,
      });
      await nativeScreen();
      assert.equal(
        await readFile(decisionFixture.file, 'utf8'),
        decisionBytes,
        'Disabled offline tap cannot resolve the actual decision',
      );
      await device.capture.screenshot({
        ...selection,
        path: path.join(
          process.env.FARMSLOT_RECIPE_ARTIFACTS_DIR,
          'screenshots',
          'native-inbox-cold-disabled.png',
        ),
        stabilize: true,
      });
      await inbox(`workspace/run/${fixture.runId}/evidence`);
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
    const recoveredCollections = await until(
      (value) =>
        value.runsStatus === 'ready' &&
        value.decisionsStatus === 'ready' &&
        value.decisionProjectionMatches &&
        value.decisions.some((row) => row.id === decisionFixture.id),
      'Single recovery reauthorizes both collections without replay',
    );
    assert.equal(
      await readFile(decisionFixture.file, 'utf8'),
      decisionBytes,
      'Reconnect must not replay the disabled decision command',
    );
    const canonicalDecisions = await rpc('decision.list');
    assert(
      canonicalDecisions.decisions.some((row) => row.id === decisionFixture.id),
      'Independent endpoint must still expose the unresolved decision after recovery',
    );
    assert(recoveredCollections.decisionsObservedAt >= coldCollections.decisionsObservedAt);
    assert(recoveredCollections.runsObservedAt >= coldCollections.runsObservedAt);
    await writeFile(
      path.join(process.env.FARMSLOT_RECIPE_ARTIFACTS_DIR, 'native-cold-collections.json'),
      JSON.stringify(
        {
          warm: warmCollections,
          cold: coldCollections,
          recovered: recoveredCollections,
          stored: storedCollections,
        },
        null,
        2,
      ),
      { flag: 'wx', mode: 0o600 },
    );
    console.log(
      JSON.stringify({
        result: 'PASS',
        phase,
        platform,
        runId: fixture.runId,
        nativeColdSavedRuns: true,
        nativeColdSavedInbox: true,
        nativeColdDisabledDecision: true,
        nativeColdCollectionsNoReplay: true,
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
