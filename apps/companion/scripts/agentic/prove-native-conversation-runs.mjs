import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { inspect, promisify } from 'node:util';

import { createAgentDeviceClient } from 'agent-device';

import { GatewayClient } from '../../../../packages/cli/src/gateway-client.ts';
import { automationGatewayTarget } from '../../../../scripts/lib/gateway-profile.mjs';
import { createRunReplyProxy } from '../../../../services/gateway/scripts/visual-reply-proxy.mjs';

import { openAndroidUrl, waitForSimulatorRecipeBridge } from './simulator-dev-client.mjs';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, '');
assert.equal(process.env.FARMSLOT_OFFLINE_PROOF, '1');
const platform = process.env.PLATFORM;
assert(['ios', 'android'].includes(platform), 'Use an explicitly owned native proof device');
const deviceId =
  platform === 'ios'
    ? process.env.IOS_SIMULATOR
    : (process.env.ADB_SERIAL ?? process.env.ANDROID_SERIAL);
assert(
  process.env.FARMSLOT_NATIVE_CONVERSATION_FIXTURE &&
    process.env.FARMSLOT_AGENT_DEVICE_STATE_DIR &&
    process.env.FARMSLOT_RECIPE_ARTIFACTS_DIR &&
    deviceId,
);
if (platform === 'android')
  assert(deviceId.startsWith('emulator-') && process.env.FARMSLOT_RECIPE_APP_ID);
const directory = await realpath(process.env.FARMSLOT_NATIVE_CONVERSATION_FIXTURE);
const fixture = JSON.parse(await readFile(path.join(directory, 'ready.json'), 'utf8'));
const credential = (await readFile(fixture.credentialFile, 'utf8')).trim();
assert(fixture.realNativeWorker && fixture.actualMarkerVerified);
assert.equal(fixture.sourceRoot, root);
assert.equal(await realpath(process.env.FARMSLOT_HOME), await realpath(fixture.home));
const target = await automationGatewayTarget();
assert.equal(target.url, fixture.url);
const gateway = new URL(target.url);
assert(['127.0.0.1', 'localhost'].includes(gateway.hostname));
const { stdout: pid } = await execute('lsof', ['-t', `-iTCP:${gateway.port}`, '-sTCP:LISTEN']);
assert.equal(Number(pid.trim()), fixture.gatewayPid);
const device = createAgentDeviceClient({ stateDir: process.env.FARMSLOT_AGENT_DEVICE_STATE_DIR });
const sessions = (await device.sessions.list()).filter((session) => session.device.id === deviceId);
assert.equal(sessions.length, 1);
const selection = { session: sessions[0].name, platform, target: 'mobile' };
const ref = `runs-cache:conversation:${fixture.runId}`;
const metro = process.env.METRO_PORT;
assert(/^\d+$/.test(metro ?? ''));
const screen = () =>
  device.capture.snapshot({ ...selection, interactiveOnly: false, forceFull: true });
async function observe(reference = ref) {
  const response = await fetch(`http://127.0.0.1:${metro}/farmslot-recipe/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      command: 'observeUi',
      nodeId: 'native-conversation-runs',
      payload: { refs: [reference] },
      timeout_ms: 3000,
    }),
    signal: AbortSignal.timeout(5000),
  });
  // A route transition replaces the app's long poll. No sample is available until its replacement.
  if (response.status === 504) return undefined;
  assert(response.ok, `Native observer HTTP ${response.status}`);
  const reply = await response.json();
  assert(reply.ok, reply.error);
  return reply.observations.runCollections;
}
async function until(read, predicate, label, timeout = 45000) {
  const deadline = Date.now() + timeout;
  let last;
  do {
    const value = await read();
    if (value) {
      last = value;
      if (predicate(value)) return value;
    }
    await delay(100);
  } while (Date.now() < deadline);
  assert.fail(`${label}: ${JSON.stringify(last)}`);
}
const conversation = () => observe();
async function open(route) {
  if (platform === 'android') {
    openAndroidUrl(
      deviceId,
      process.env.FARMSLOT_RECIPE_APP_ID,
      `farmslot-development:///${route}`,
    );
    return;
  }
  await execute('xcrun', ['simctl', 'openurl', deviceId, `farmslot-development:///${route}`]);
}
async function reveal(identifier) {
  for (let i = 0; i < 12; i++) {
    const snapshot = await screen();
    const node = snapshot.nodes.find((node) => node.identifier === identifier);
    const viewport = snapshot.nodes.find((node) =>
      ['companion-native-connection-screen', 'companion-screen-native'].includes(node.identifier),
    )?.rect;
    if (
      node?.rect &&
      node.rect.y >= Math.max(0, viewport?.y ?? 0) &&
      (!viewport || node.rect.y + node.rect.height <= viewport.y + viewport.height)
    )
      return node;
    const direction = node?.rect && viewport && node.rect.y < viewport.y ? 'up' : 'down';
    await device.interactions.scroll({ ...selection, direction, pixels: 320 });
  }
  assert.fail(`Actual native control is not visible: ${identifier}`);
}
async function press(identifier) {
  const node = await reveal(identifier);
  await device.interactions.press({
    ...selection,
    x: node.rect.x + node.rect.width / 2,
    y: node.rect.y + node.rect.height / 2,
  });
}
async function fill(identifier, text, verify = true) {
  await until(
    () => reveal(identifier),
    (node) => node.enabled !== false,
    `The actual native input must be enabled: ${identifier}`,
    10000,
  );
  await device.interactions.fill({ ...selection, selector: `id="${identifier}"`, text, verify });
}
let externalConnection;
const rpc = (method, params = {}) => externalConnection.call(method, params);
async function checkpoint(name, facts) {
  await writeFile(
    path.join(process.env.FARMSLOT_RECIPE_ARTIFACTS_DIR, `${name}.json`),
    `${JSON.stringify({ status: 'checkpoint', runId: fixture.runId, ...facts }, null, 2)}\n`,
    { flag: 'wx', mode: 0o600 },
  );
}
const shots = [];
async function capture(name) {
  const file = path.join(process.env.FARMSLOT_RECIPE_ARTIFACTS_DIR, 'screenshots', name);
  await mkdir(path.dirname(file), { recursive: true });
  await device.capture.screenshot({ ...selection, path: file, stabilize: false });
  shots.push(name);
}
const matches = (value) => {
  const frame = value.conversation;
  return (
    frame?.canonical &&
    frame.ready &&
    frame.caughtUp &&
    frame.observation.status === 'ready' &&
    frame.selection.runId === fixture.runId &&
    frame.selection.contextId === fixture.contextId &&
    frame.selection.leaseId === fixture.leaseId &&
    frame.selection.generation === fixture.generation &&
    frame.session?.id === fixture.sessionId &&
    frame.session.executionNodeId === fixture.executionNodeId &&
    frame.session.generation === fixture.generation &&
    frame.session.workerLeaseId === fixture.leaseId &&
    frame.session.cwd === fixture.repo
  );
};
let proxy,
  reversePort,
  originalProfile,
  profileChanged = false,
  result,
  originalFailure;
const cleanupFailures = [];
try {
  await waitForSimulatorRecipeBridge({ platform });
  await open('connection');
  await until(
    screen,
    (value) => value.nodes.some((node) => node.identifier === 'companion-native-connection-screen'),
    'Open actual connection settings before observing the initial profile',
  );
  externalConnection = await new GatewayClient({
    url: target.url,
    credential: target.credential,
    timeout: 90000,
  }).connect();
  const before = await until(
    () => observe('runs-cache:snapshot'),
    (value) => value.connectionProfileId,
    'Read the actual initial profile',
  );
  originalProfile = before.connectionProfileId;
  proxy = await createRunReplyProxy({
    upstreamPort: Number(gateway.port),
    runId: fixture.runId,
    method: 'run.get',
    armed: false,
  });
  if (platform === 'android') {
    await execute('adb', [
      '-s',
      deviceId,
      'reverse',
      '--no-rebind',
      `tcp:${proxy.port}`,
      `tcp:${proxy.port}`,
    ]);
    reversePort = proxy.port;
  }
  if (!(await screen()).nodes.some((node) => node.identifier === 'companion-native-profile-name'))
    await press('companion-connection-manual-toggle');
  await fill('companion-native-profile-name', `Offline native ${randomUUID().slice(0, 8)}`);
  await fill('companion-native-profile-url', `ws://127.0.0.1:${proxy.port}`);
  await press('companion-native-auth-token');
  // Secure input is masked by accessibility; the subsequent authenticated native read verifies it.
  await fill('companion-native-profile-secret', credential, false);
  profileChanged = true;
  await press('companion-native-profile-save');
  await until(
    () => observe('runs-cache:snapshot'),
    (value) => value.online && value.connectionProfileId !== originalProfile,
    'Connect the private fixture profile',
  );
  const params = new URLSearchParams({
    runId: fixture.runId,
    contextId: fixture.contextId,
    sessionId: fixture.sessionId,
    executionNodeId: fixture.executionNodeId,
    leaseId: fixture.leaseId,
    generation: fixture.generation,
  });
  await open(`native?${params}`);
  const initial = await until(
    conversation,
    matches,
    'Open the actual pinned native worker conversation',
  );
  assert(initial.conversation.writable);
  assert(initial.conversation.cursor >= fixture.initialCursor);
  const initialRunGets = proxy.state().counts['run.get'];
  const initialReads = initial.conversation.pageReadCount;
  const idle = await until(
    conversation,
    (value) => matches(value) && value.conversation.pageReadCount >= initialReads + 2,
    'Observe cursor polling without another run lookup',
  );
  assert.equal(
    proxy.state().counts['run.get'],
    initialRunGets,
    'Native transcript polls must not reread run.get',
  );
  assert(
    idle.conversation.pageAfters.at(-1) >= initial.conversation.cursor,
    'Native paging must retain its cursor',
  );
  const token = `NATIVE_REPLY_${randomUUID().replaceAll('-', '')}`;
  const prompt = `Reply exactly ${token}. Do not use tools or modify files.`;
  await fill('companion-native-draft', prompt);
  const drafted = await until(
    conversation,
    (value) => matches(value) && value.conversation.draft === prompt && value.conversation.canSend,
    'Retain text typed into the actual native composer',
  );
  proxy.arm();
  const tag = `native-reader-${randomUUID().slice(0, 8)}`;
  await rpc('run.tags.set', {
    runId: fixture.runId,
    tags: [...(drafted.conversation.observation.data.run.tags ?? []), tag],
  });
  await until(
    conversation,
    (value) =>
      value.conversation?.canonical &&
      value.conversation.observation.status === 'stale' &&
      value.conversation.draft === prompt &&
      !value.conversation.canSend,
    'A real pending run read must pause the actual composer',
  );
  assert(
    proxy.state().held && !proxy.state().expired,
    'The actual successful run response must still be held',
  );
  assert.equal(
    (await reveal('companion-native-send')).enabled,
    false,
    'Actual Send must be disabled while the shared run is stale',
  );
  await capture('native-conversation-stale.png');
  assert(!proxy.state().expired, 'Finish stale UI proof within the real request deadline');
  proxy.release();
  const current = await until(
    conversation,
    (value) =>
      matches(value) &&
      value.conversation.draft === prompt &&
      value.conversation.canSend &&
      value.conversation.pageReadCount > drafted.conversation.pageReadCount &&
      value.conversation.observation.data.run.tags?.includes(tag),
    'Adopt the external run update and retain the composer',
  );
  assert.equal(current.connectionGeneration, initial.connectionGeneration);
  assert.equal(current.startedAt, initial.startedAt);
  assert(current.conversation.cursor >= drafted.conversation.cursor);
  assert(
    current.conversation.pageAfters
      .slice(-Math.min(20, current.conversation.pageReadCount - drafted.conversation.pageReadCount))
      .every((after) => after >= drafted.conversation.cursor),
    'A metadata refresh must not restart native paging from zero',
  );
  const refreshTransport = proxy.state();
  assert.equal(refreshTransport.responseDigest, refreshTransport.deliveredDigest);
  const knownCommands = new Set(current.conversation.commands.map((command) => command.commandId));
  await press('companion-native-send');
  const accepted = await until(
    conversation,
    (value) =>
      matches(value) &&
      !value.conversation.pendingCommandId &&
      value.conversation.timeline.some(
        (entry) => entry.kind === 'assistant' && entry.text.includes(token),
      ),
    'The real worker must answer the explicitly submitted native message',
    90000,
  );
  const commands = accepted.conversation.commands.filter(
    (command) => !knownCommands.has(command.commandId) && command.commandId.startsWith('mobile-'),
  );
  assert.equal(commands.length, 1);
  assert(commands[0].accepted && commands[0].submitted);
  assert.equal(proxy.state().counts['native.session.send'], 1);
  const page = await rpc('native.session.read', {
    sessionId: fixture.sessionId,
    executionNodeId: fixture.executionNodeId,
    worker: fixture.worker,
    limit: 200,
  });
  assert(
    page.commands.some(
      (command) => command.commandId === commands[0].commandId && command.accepted,
    ),
  );
  assert.equal(page.scope.leaseId, fixture.leaseId);
  await capture('native-conversation-accepted.png');
  await checkpoint('accepted-command', {
    command: commands[0],
    receipt: page.commands.find((command) => command.commandId === commands[0].commandId),
    worker: fixture.worker,
    refreshTransport,
    cursor: accepted.conversation.cursor,
    screenshots: [...shots],
  });
  const finalToken = `LATE_NATIVE_${randomUUID().replaceAll('-', '')}`;
  await fill('companion-native-draft', `Reply exactly ${finalToken}. Do not use tools.`);
  const beforeLate = await until(
    conversation,
    (value) =>
      matches(value) &&
      value.conversation.draft === `Reply exactly ${finalToken}. Do not use tools.` &&
      value.conversation.canSend,
    'Prepare an actual late-page request',
  );
  proxy.arm({
    method: 'native.session.read',
    holdResponse: (frame) =>
      frame.ok &&
      frame.payload?.session?.state === 'idle' &&
      frame.payload.events.some((event) => event.sequence > beforeLate.conversation.cursor),
  });
  await press('companion-native-send');
  await until(
    async () => proxy.state(),
    (value) => value.held,
    'Hold a real nonempty native transcript reply',
    90000,
  );
  const held = proxy.state();
  const frozen = await until(
    conversation,
    (value) => value.conversation?.cursor === held.heldAfter,
    'Bind the held reply to the actual displayed cursor',
  );
  const cancelled = await rpc('run.cancel', { runId: fixture.runId });
  assert(!cancelled.effects?.some((effect) => effect.status === 'failed'));
  // This proof removes a run, not its worktree. Release only this run's claim
  // through the public API so run.delete need not run destructive storage cleanup.
  const released = await rpc('slot.release', {
    slotId: fixture.slotId,
    expectedRunId: fixture.runId,
    keepWork: true,
    killTmux: false,
    detachRuns: true,
  });
  assert(released.released, released.reason);
  const releasedView = await until(
    conversation,
    (value) =>
      value.conversation?.observation.status === 'ready' &&
      value.conversation.observation.data?.run.status === 'cancelled' &&
      !value.conversation.writable,
    'Retain the cancelled run before its actual deletion',
  );
  assert.equal(releasedView.conversation.selection.leaseId, fixture.leaseId);
  assert.equal(releasedView.conversation.selection.generation, fixture.generation);
  assert.equal(releasedView.conversation.worker.binding.leaseId, fixture.leaseId);
  assert.equal(releasedView.conversation.worker.binding.generation, fixture.generation);
  assert.equal(releasedView.conversation.worker.binding.sessionId, fixture.sessionId);
  assert.equal(releasedView.conversation.session.id, fixture.sessionId);
  assert.equal(releasedView.conversation.cursor, frozen.conversation.cursor);
  assert.equal(releasedView.conversation.eventCount, frozen.conversation.eventCount);
  assert(!proxy.state().expired, 'Keep the original reply deadline through slot release');
  await checkpoint('released-before-delete', { released, transport: proxy.state() });
  await rpc('run.delete', { runId: fixture.runId });
  await until(
    conversation,
    (value) => value.conversation?.observation.error && !value.conversation.observation.data,
    'The authorized missing run must evict canonical data',
  );
  assert(!proxy.state().expired, 'Remove the owned run before the real reply deadline');
  proxy.release();
  const retired = await until(
    conversation,
    (value) => value.conversation?.pageReadCount > frozen.conversation.pageReadCount,
    'Observe completion of the retired page request',
  );
  assert.equal(
    retired.conversation.cursor,
    frozen.conversation.cursor,
    'A reply from a removed run must not advance the current native timeline',
  );
  assert.equal(retired.conversation.eventCount, frozen.conversation.eventCount);
  assert.equal(retired.conversation.writable, false);
  assert.equal(retired.connectionGeneration, initial.connectionGeneration);
  assert.equal(retired.startedAt, initial.startedAt);
  await press('companion-native-run-retry');
  const retried = await until(
    conversation,
    (value) =>
      value.conversation?.observation.error &&
      !value.conversation.observation.data &&
      !value.conversation.writable,
    'Contextual Retry must retain the actual removed-run error',
  );
  assert.equal(retried.conversation.cursor, frozen.conversation.cursor);
  assert.equal(proxy.state().counts['native.session.send'], 2);
  const lateTransport = proxy.state();
  assert.equal(lateTransport.responseDigest, lateTransport.deliveredDigest);
  await capture('native-conversation-removed.png');
  result = {
    platform,
    nativeConversationShared: true,
    nativeConversationStaleDisabled: true,
    nativeConversationAccepted: true,
    nativeConversationLatePageRetired: true,
    nativeConversationNoReplay: true,
    runId: fixture.runId,
    worker: fixture.worker,
    commandId: commands[0].commandId,
    refreshTransport,
    lateTransport,
    shots,
    offlineTranscriptProven: false,
    wholeNativeSessionMigrationComplete: false,
  };
} catch (error) {
  originalFailure = error;
} finally {
  if (profileChanged && originalProfile) {
    try {
      await open('connection');
      const profiles = await until(
        () => observe('runs-cache:snapshot'),
        (value) => value.connectionProfileIds?.includes(originalProfile),
        'Find the actual original profile',
      );
      await press(
        `companion-native-profile-${profiles.connectionProfileIds.indexOf(originalProfile)}`,
      );
      await until(
        () => observe('runs-cache:snapshot'),
        (value) => value.online && value.connectionProfileId === originalProfile,
        'Restore the original profile through the actual UI',
      );
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  try {
    await proxy?.close();
  } catch (error) {
    cleanupFailures.push(error);
  }
  if (reversePort) {
    try {
      await execute('adb', ['-s', deviceId, 'reverse', '--remove', `tcp:${reversePort}`]);
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  externalConnection?.close();
}
if (originalFailure || cleanupFailures.length) {
  const failures = [...(originalFailure ? [originalFailure] : []), ...cleanupFailures].map(
    (error) =>
      new Error(
        inspect(error, { depth: 5 }).replaceAll(credential, '<private fixture credential>'),
      ),
  );
  throw new AggregateError(failures, 'Native conversation proof and cleanup failures retained');
}
console.log(JSON.stringify({ result: 'PASS', ...result }));
