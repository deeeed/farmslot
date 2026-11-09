// Phases of native-stream-follow.recipe.json. Reads the app's own conversation proof frame through
// the Metro recipe relay and the isolated stack's control port (native-stream-stack.mts); it never
// writes app state. UI input comes from the recipe's ui.* nodes.
//
//   NATIVE_STREAM_CONTROL=http://127.0.0.1:8863 NATIVE_STREAM_STATE=<file> METRO_PORT=<port> \
//   IOS_SIMULATOR=<udid> node scripts/agentic/native-stream-proof.mjs <phase>
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const phase = process.argv[2];
const control = process.env.NATIVE_STREAM_CONTROL;
const stateFile = process.env.NATIVE_STREAM_STATE;
const metro = process.env.METRO_PORT;
const simulator = process.env.IOS_SIMULATOR;
assert(control && stateFile && /^\d+$/.test(metro ?? '') && simulator, 'Set the proof environment');
const agentDevice = fileURLToPath(
  new URL('../../../../node_modules/.bin/agent-device', import.meta.url),
);
// Native input the recipe's ui.* nodes cannot give here: pairing's native alerts, and a fling
// (ui.swipe needs idb HID, which current Xcode no longer supports). agent-device uses the recipe's own
// state dir, so its daemon owns the simulator runner for both.
const stateDir =
  process.env.FARMSLOT_AGENT_DEVICE_STATE_DIR ??
  path.join(tmpdir(), 'farmslot-agent-device', simulator.replace(/[^a-zA-Z0-9._-]/gu, '-'));
/**
 * The device belongs to one session at a time. Inside a recipe that is the runner's own session,
 * which @farmslot/adapter-rn names `farmslot-<slot>-<runner pid>` in this state dir; outside one,
 * this script's.
 */
function deviceSession() {
  const slot = process.env.FARMSLOT_SLOT_ID ?? path.basename(process.env.RUNTIME_DIR ?? 'local');
  const sessions = path.join(stateDir, 'sessions');
  const live = (existsSync(sessions) ? readdirSync(sessions) : []).filter((name) => {
    const pid = Number(name.slice(`farmslot-${slot}-`.length));
    if (!name.startsWith(`farmslot-${slot}-`) || !Number.isSafeInteger(pid)) return false;
    // A session left by a finished run names a pid that no longer exists.
    return spawnSync('ps', ['-p', String(pid)]).status === 0;
  });
  assert(live.length <= 1, `More than one live recipe session: ${live.join(', ')}`);
  return live[0] ?? 'native-stream-proof';
}
const session = deviceSession();
// agent-device reports a failed command as JSON on stdout, with or without a non-zero exit.
const device = (...args) => {
  const result = spawnSync(
    agentDevice,
    [...args, '--session', session, '--platform', 'ios', '--udid', simulator, '--json'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        AGENT_DEVICE_STATE_DIR: stateDir,
        AGENT_DEVICE_IOS_RUNNER_IDLE_STOP_MS: '100',
        AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '10000',
      },
    },
  );
  assert(result.stdout?.trim(), `agent-device ${args[0]} printed nothing: ${result.stderr}`);
  return JSON.parse(result.stdout);
};
/** Presses `button` on the native alert titled `title` once it shows; false if none showed. */
async function answerAlert(title, button, timeout = 30000) {
  device('open', 'net.siteed.farmslot.development');
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const alert = device('alert', 'get');
    if (alert.success && JSON.stringify(alert.data).includes(title)) {
      const pressed = device('press', `label="${button}"`);
      assert(pressed.success, JSON.stringify(pressed.error));
      return true;
    }
    if (!alert.success)
      assert.equal(alert.error?.message, 'alert not found', JSON.stringify(alert.error));
    await delay(500);
  }
  return false;
}

/** Within this distance of the end the reader follows (NATIVE_FOLLOW_SLACK_PX). */
const SLACK = 80;
/** DURATION_BUCKETS from @farmslot/protocol/performance, in seconds. */
const DURATION_BOUNDS = [
  0.001, 0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.15, 0.25, 0.5, 1, 2, 5, 10, 20, 30, 60, 120, 180,
  300, 600, 3600,
];

const call = async (method, route) => {
  const response = await fetch(`${control}${route}`, { method });
  const body = await response.json();
  assert(response.ok, body.error);
  return body;
};
const readState = () => JSON.parse(readFileSync(stateFile, 'utf8'));
const writeState = (state) => writeFileSync(stateFile, `${JSON.stringify(state)}\n`);

async function frame() {
  const { sessionId } = readState();
  const response = await fetch(`http://127.0.0.1:${metro}/farmslot-recipe/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      command: 'observeUi',
      nodeId: 'native-stream-follow',
      payload: { refs: [`runs-cache:conversation:${sessionId}`] },
      timeout_ms: 3000,
    }),
    signal: AbortSignal.timeout(5000),
  });
  // A route transition replaces the app's long poll; no sample until its replacement.
  if (response.status === 504) return undefined;
  assert(response.ok, `Observer HTTP ${response.status}`);
  const reply = await response.json();
  assert(reply.ok, reply.error);
  return reply.observations.runCollections?.conversation;
}
async function until(predicate, label, timeout = 60000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await frame();
    if (last && predicate(last)) return last;
    await delay(200);
  }
  throw new Error(`Timed out: ${label}; last follow ${JSON.stringify(last?.follow)}`);
}
const report = (result) => console.log(JSON.stringify({ phase, ...result }));
const lastAssistant = (value) =>
  value.timeline.filter((entry) => entry.kind === 'assistant').at(-1);

if (phase === 'setup') {
  const { sessionId } = await call('POST', '/session');
  const seedTurns = Number(process.env.NATIVE_STREAM_SEED_TURNS ?? '0');
  if (seedTurns) await call('POST', `/seed?turns=${seedTurns}`);
  const read = await call('GET', '/read');
  writeState({ sessionId, completedTurns: read.completedTurns });
  report({ sessionId, ...read });
} else if (phase === 'pair') {
  // Setup: pair the app with the isolated gateway through its own pair link and native Alert.
  const { link } = await call('POST', '/pair');
  execFileSync('xcrun', ['simctl', 'openurl', simulator, link]);
  // The system asks once per link, and not every time.
  await answerAlert('Open in', 'Open', 5000);
  assert(await answerAlert('Pair with this gateway?', 'Pair'), 'No pairing Alert');
  assert(await answerAlert('Companion paired', 'OK'), 'Pairing did not finish');
  // Ends this script's session and leaves the app open, so a recipe can take the device.
  assert(device('close').success, 'Could not release the device');
  report({ paired: true });
} else if (phase === 'open') {
  const { sessionId } = readState();
  execFileSync('xcrun', [
    'simctl',
    'openurl',
    simulator,
    `farmslot-development:///native?sessionId=${encodeURIComponent(sessionId)}&executionNodeId=local`,
  ]);
  const value = await until(
    (sample) => sample.caughtUp && sample.timeline.length > 0,
    'the conversation history',
  );
  report({ entries: value.timeline.length, eventCount: value.eventCount, follow: value.follow });
} else if (phase === 'at-end') {
  // Rows rendered and the reader is at the end of them.
  const value = await until(
    (sample) => sample.follow.following && sample.follow.distanceFromEnd < SLACK,
    'following at the end',
  );
  report({ follow: value.follow });
} else if (phase === 'streams-following') {
  // The composer just sent a prompt: every sample while it streams follows the end.
  const before = readState().completedTurns;
  assert(Number.isSafeInteger(before), 'Run setup first');
  const samples = [];
  const deadline = Date.now() + 120000;
  for (;;) {
    assert(Date.now() < deadline, 'Timed out waiting for the streamed turn');
    const value = await frame();
    if (value) samples.push(value.follow);
    const { completedTurns } = await call('GET', '/read');
    if (completedTurns > before && value?.caughtUp) {
      // Let the last delta's layout settle before reading the final position.
      await delay(1000);
      const settled = await frame();
      const left = samples.filter((follow) => !follow.following);
      assert.equal(left.length, 0, `Left the end while streaming: ${JSON.stringify(left[0])}`);
      assert(
        settled.follow.following,
        `Not following after the stream: ${JSON.stringify(settled.follow)}`,
      );
      assert(
        settled.follow.distanceFromEnd < SLACK,
        `Not at the end after the stream: ${JSON.stringify(settled.follow)}`,
      );
      writeState({ ...readState(), completedTurns });
      report({ samples: samples.length, final: settled.follow, completedTurns });
      break;
    }
    await delay(150);
  }
} else if (phase === 'scrolled-away') {
  // The reader flicks the conversation back toward its start.
  const flung = device('gesture', 'fling', 'down', '200', '520', '400', '150');
  assert(flung.success, JSON.stringify(flung.error));
  const value = await until(
    (sample) => !sample.follow.following && sample.follow.distanceFromEnd >= SLACK,
    'the reader away from the end',
  );
  report({ follow: value.follow });
} else if (phase === 'more-output') {
  // Another client's turns arrive while the reader is away: they count as unseen.
  await call('POST', '/seed?turns=2');
  const value = await until(
    (sample) => !sample.follow.following && sample.follow.unseen > 0,
    'unseen entries',
  );
  writeState({ ...readState(), completedTurns: (await call('GET', '/read')).completedTurns });
  report({ follow: value.follow });
} else if (phase === 'latest') {
  const value = await until(
    (sample) =>
      sample.follow.following &&
      sample.follow.unseen === 0 &&
      sample.follow.distanceFromEnd < SLACK,
    'the Latest jump at the end',
  );
  report({ follow: value.follow });
} else if (phase === 'turn-done') {
  // The composer's [short] prompt finished; the reader still follows its end.
  const before = readState().completedTurns;
  const deadline = Date.now() + 60000;
  let completedTurns = before;
  while (completedTurns <= before) {
    assert(Date.now() < deadline, 'Timed out waiting for the short turn');
    await delay(250);
    ({ completedTurns } = await call('GET', '/read'));
  }
  const value = await until(
    (sample) => sample.caughtUp && sample.follow.following && sample.follow.distanceFromEnd < SLACK,
    'following after the short turn',
  );
  writeState({ ...readState(), completedTurns });
  report({ follow: value.follow, completedTurns });
} else if (phase === 'disclosure-kept-place') {
  // Opening the last message at the end grows the content below the reader; the screen must keep
  // their place instead of following it down.
  await delay(1000);
  const value = await frame();
  assert(value, 'No conversation frame');
  assert.equal(
    value.follow.following,
    false,
    `Followed a disclosure: ${JSON.stringify(value.follow)}`,
  );
  assert(
    value.follow.distanceFromEnd >= SLACK,
    `Scrolled to the end: ${JSON.stringify(value.follow)}`,
  );
  report({ follow: value.follow, lastAssistantKey: lastAssistant(value)?.key });
} else if (phase === 'render-metric') {
  // One more 200-delta turn into the open conversation; the app's own recorder times each streamed
  // update from receipt to the next foreground paint (farmslot_native_text_render_seconds).
  const probe = (name) =>
    JSON.parse(
      execFileSync(
        'node',
        [
          fileURLToPath(new URL('./cdp-eval.mjs', import.meta.url)),
          '--file',
          fileURLToPath(new URL(`./probes/${name}.js`, import.meta.url)),
        ],
        { encoding: 'utf8' },
      ),
    );
  const read = () => {
    const rows = probe('native-text-render');
    assert(rows.length <= 1, 'Expected one native text render series');
    return rows[0] ?? { count: 0, sum: 0, max: 0, buckets: [] };
  };
  const before = read();
  await call('POST', '/seed?turns=1');
  // The last update's paint.
  await delay(2000);
  const after = read();
  const count = after.count - before.count;
  assert(count > 0, 'No streamed update was timed');
  const cumulative = after.buckets.map((value, index) => value - (before.buckets[index] ?? 0));
  const bounds = [...DURATION_BOUNDS, Infinity];
  const percentile = (q) => bounds[cumulative.findIndex((value) => value >= q * count)];
  report({
    count,
    meanMs: ((after.sum - before.sum) / count) * 1000,
    p50UpperBoundMs: percentile(0.5) * 1000,
    p95UpperBoundMs: percentile(0.95) * 1000,
    // The recorder keeps one max per series: exact only when nothing was timed before this turn.
    maxMs: before.count ? undefined : after.max * 1000,
    ...probe('native-conversation-rows'),
  });
} else throw new Error(`Unknown phase ${phase}`);
process.exit(0);
