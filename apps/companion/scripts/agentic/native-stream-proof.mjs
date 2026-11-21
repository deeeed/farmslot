// Phases of native-stream-follow.recipe.json. Reads the app's own conversation proof frame through
// the Metro recipe relay and the isolated stack's control port (native-stream-stack.mts); it never
// writes app state. UI input comes from the recipe's ui.* nodes.
//
//   NATIVE_STREAM_CONTROL=http://127.0.0.1:8863 NATIVE_STREAM_STATE=<file> METRO_PORT=<port> \
//   PLATFORM=ios IOS_SIMULATOR=<udid> node scripts/agentic/native-stream-proof.mjs <phase>
//
// On Android set PLATFORM=android and ADB_SERIAL=<serial> instead (jank-conversation.recipe.json);
// the status-bar-top phase is iOS only.
//
// `setup` seeds NATIVE_STREAM_SEED_TURNS earlier turns (default 4), so the reader has history to
// scroll away into; 0 is allowed and opens an empty conversation.
//
// NATIVE_STREAM_REQUIRE_FOLLOW=no makes at-end, streams-following and reader-away report the follow
// state without checking it, so a build whose proof frame has none yet (a before build) runs the
// same steps for a frame-rate comparison. They report `follow: null` when the frame has none.
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
const android = process.env.PLATFORM === 'android';
// The same variables @farmslot/adapter-rn reads, so this script drives the recipe's device.
const target = android
  ? (process.env.ADB_SERIAL ?? process.env.ANDROID_SERIAL ?? process.env.ANDROID_DEVICE)
  : process.env.IOS_SIMULATOR;
assert(control && stateFile && /^\d+$/.test(metro ?? '') && target, 'Set the proof environment');
const requireFollow = process.env.NATIVE_STREAM_REQUIRE_FOLLOW !== 'no';
/**
 * NATIVE_STREAM_FRAMES=off, for an Android release build: it has no recipe bridge (development
 * only), so there is no proof frame. Phases then wait on the gateway and the device's own view
 * tree, and only frame-rate runs (NATIVE_STREAM_REQUIRE_FOLLOW=no) are possible.
 */
const frames = process.env.NATIVE_STREAM_FRAMES !== 'off';
assert(frames || android, 'NATIVE_STREAM_FRAMES=off is for Android release builds');
const appId = process.env.FARMSLOT_RECIPE_APP_ID ?? 'net.siteed.farmslot.development';
const targetArgs = android
  ? ['--platform', 'android', '--serial', target]
  : ['--platform', 'ios', '--udid', target];
/** Opens a link in the app the way the system would: simctl on iOS, a VIEW intent on Android. */
const openUrl = (link) => {
  // adb shell joins its arguments into one remote shell command: the link is single-quoted there,
  // so it must not contain a single quote itself.
  assert(!android || !link.includes("'"), `Cannot pass a link with a single quote to adb: ${link}`);
  return android
    ? // Quoted for the remote shell, which would otherwise split the link at its `&`.
      execFileSync(
        'adb',
        [
          '-s',
          target,
          'shell',
          'am',
          'start',
          '-W',
          '-a',
          'android.intent.action.VIEW',
          '-d',
          `'${link}'`,
          appId,
        ],
        { stdio: 'ignore' },
      )
    : execFileSync('xcrun', ['simctl', 'openurl', target, link]);
};
const agentDevice = fileURLToPath(
  new URL('../../../../node_modules/.bin/agent-device', import.meta.url),
);
// Native input the recipe's ui.* nodes cannot give here: pairing's native alerts, and a fling
// (ui.swipe needs idb HID, which current Xcode no longer supports). agent-device uses the recipe's own
// state dir, so its daemon owns the simulator runner for both.
const stateDir =
  process.env.FARMSLOT_AGENT_DEVICE_STATE_DIR ??
  path.join(tmpdir(), 'farmslot-agent-device', target.replace(/[^a-zA-Z0-9._-]/gu, '-'));
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
  const result = spawnSync(agentDevice, [...args, '--session', session, ...targetArgs, '--json'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      AGENT_DEVICE_STATE_DIR: stateDir,
      AGENT_DEVICE_IOS_RUNNER_IDLE_STOP_MS: '100',
      AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '10000',
    },
  });
  assert(result.stdout?.trim(), `agent-device ${args[0]} printed nothing: ${result.stderr}`);
  return JSON.parse(result.stdout);
};
/**
 * Presses `button` on the native alert that mentions `text` once it shows; false if none showed.
 * `text` may list alternatives: Android's dialog reading can return the message without the title.
 */
async function answerAlert(text, button, timeout = 30000) {
  const needles = [text].flat();
  device('open', appId);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const alert = device('alert', 'get');
    if (alert.success && needles.some((needle) => JSON.stringify(alert.data).includes(needle))) {
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
/**
 * While a turn streams, the frame may be read between a delta's layout and the screen's jump to
 * the end: a few lines at most. A sample beyond this is read again after SETTLE_MS, and must then
 * be within it.
 */
const STREAM_ALLOWANCE = 120;
const SETTLE_MS = 300;
/** A 200-delta turn at 50 ms streams for about 10 s: enough samples to see it follow throughout. */
const MIN_STREAM_SAMPLES = 20;
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
/**
 * Android: how far the transcript's last laid-out row ends above the transcript's bottom edge, in
 * dp (the unit of distanceFromEnd), read from the device's own layout. The app's distanceFromEnd
 * comes from scroll events, and Android drops one that lands within scrollEventThrottle of the
 * last: after the final jump of a turn it can stay ~100 dp behind a list that is at its end.
 */
function endLayout(turnLastLine) {
  const shot = device('snapshot');
  assert(shot.success, JSON.stringify(shot.error));
  const nodes = shot.data.nodes;
  const list = nodes.find((node) => node.identifier === 'companion-native-transcript');
  assert(list?.rect, 'The transcript is not on screen');
  // The rows' content: labelled descendants of the transcript (parents come before children).
  // Unlabelled containers are skipped: the list's own content view spans its full height.
  const inside = new Set([list.index]);
  for (const node of nodes) if (inside.has(node.parentIndex)) inside.add(node.index);
  const rows = nodes.filter(
    (node) =>
      node.index !== list.index && inside.has(node.index) && node.label && node.rect?.height > 0,
  );
  assert(rows.length, 'The transcript has no laid-out rows');
  // The streamed turn's own text must be laid out: a list still showing earlier turns would
  // otherwise read as at its end.
  const turnRow = turnLastLine && rows.find((node) => node.label.includes(turnLastLine));
  assert(!turnLastLine || turnRow, `The new turn's last line is not laid out: ${turnLastLine}`);
  const lastBottom = Math.max(...rows.map((node) => node.rect.y + node.rect.height));
  const densityOutput = execFileSync('adb', ['-s', target, 'shell', 'wm', 'density'], {
    encoding: 'utf8',
  }).trim();
  const densityMatch = /(\d+)\s*$/.exec(densityOutput);
  assert(densityMatch, `Unexpected wm density output: ${densityOutput}`);
  const density = Number(densityMatch[1]);
  const listBottom = list.rect.y + list.rect.height;
  // Outside a recipe this script opened its own session: hand the device back.
  if (session === 'native-stream-proof')
    assert(device('close').success, 'Could not release the device');
  return {
    gap: ((listBottom - lastBottom) * 160) / density,
    listBottom,
    lastBottom,
    density,
    ...(turnRow ? { turnRowBottom: turnRow.rect.y + turnRow.rect.height } : {}),
  };
}
/** True when follow is only reported (NATIVE_STREAM_REQUIRE_FOLLOW=no); otherwise the frame must have it. */
const followless = (value) => {
  if (!requireFollow) return true;
  assert(value.follow !== undefined, 'The conversation proof frame has no follow state');
  return false;
};
const lastAssistant = (value) =>
  value.timeline.filter((entry) => entry.kind === 'assistant').at(-1);

if (phase === 'setup') {
  const { sessionId } = await call('POST', '/session');
  const seedTurns = Number(process.env.NATIVE_STREAM_SEED_TURNS ?? '4');
  assert(Number.isSafeInteger(seedTurns) && seedTurns >= 0, 'NATIVE_STREAM_SEED_TURNS: 0 or more');
  if (seedTurns) await call('POST', `/seed?turns=${seedTurns}`);
  const read = await call('GET', '/read');
  writeState({ sessionId, completedTurns: read.completedTurns });
  report({ sessionId, ...read });
} else if (phase === 'pair') {
  // Setup: pair the app with the isolated gateway through its own pair link and native Alert.
  const { link } = await call('POST', '/pair');
  openUrl(link);
  // iOS asks once per link, and not every time; Android's intent names the app.
  if (!android) await answerAlert('Open in', 'Open', 5000);
  assert(
    await answerAlert(['Pair with this gateway?', 'Pair only if you opened this link'], 'Pair'),
    'No pairing Alert',
  );
  assert(await answerAlert('Companion paired', 'OK'), 'Pairing did not finish');
  // Ends this script's session and leaves the app open, so a recipe can take the device.
  assert(device('close').success, 'Could not release the device');
  report({ paired: true });
} else if (phase === 'open' && !frames) {
  const { sessionId } = readState();
  openUrl(
    `farmslot-development:///native?sessionId=${encodeURIComponent(sessionId)}&executionNodeId=local`,
  );
  // The device's view tree shows the transcript and the seeded turns' last card.
  const deadline = Date.now() + 60000;
  for (;;) {
    const tree = execFileSync(
      'adb',
      ['-s', target, 'exec-out', 'uiautomator', 'dump', '/dev/tty'],
      {
        encoding: 'utf8',
      },
    );
    if (tree.includes('companion-native-transcript') && tree.includes('Turn completed')) break;
    assert(Date.now() < deadline, 'The conversation history did not show');
    await delay(500);
  }
  report({ frames: 'off' });
} else if ((phase === 'at-end' || phase === 'reader-away') && !frames) {
  assert(
    !requireFollow,
    'Without a proof frame follow cannot be checked: NATIVE_STREAM_REQUIRE_FOLLOW=no',
  );
  report({ frames: 'off' });
} else if (phase === 'streams-following' && !frames) {
  // The turn is sent from the gateway (NATIVE_STREAM_SEND=gateway) and read back from it.
  assert(
    process.env.NATIVE_STREAM_SEND === 'gateway',
    'NATIVE_STREAM_FRAMES=off needs NATIVE_STREAM_SEND=gateway',
  );
  assert(
    !requireFollow,
    'Without a proof frame follow cannot be checked: NATIVE_STREAM_REQUIRE_FOLLOW=no',
  );
  const before = readState().completedTurns;
  const read = await call('POST', '/seed?turns=1');
  assert(read.completedTurns > before, 'The streamed turn did not complete');
  // Let the last delta's layout settle, as the framed phase does.
  await delay(1000);
  writeState({ ...readState(), completedTurns: read.completedTurns });
  report({ frames: 'off', completedTurns: read.completedTurns });
} else if (phase === 'open') {
  const { sessionId } = readState();
  openUrl(
    `farmslot-development:///native?sessionId=${encodeURIComponent(sessionId)}&executionNodeId=local`,
  );
  // An empty conversation is caught up too: the composer is ready either way.
  const value = await until((sample) => sample.caughtUp, 'the conversation history');
  report({ entries: value.timeline.length, eventCount: value.eventCount, follow: value.follow });
} else if (phase === 'at-end') {
  // Rows rendered and the reader is at the end of them.
  const value = await until(
    (sample) =>
      followless(sample) || (sample.follow.following && sample.follow.distanceFromEnd < SLACK),
    'following at the end',
  );
  report({ follow: value.follow ?? null, ...(requireFollow ? { followChecked: true } : {}) });
} else if (phase === 'streams-following') {
  // The composer just sent a prompt: while it streams, every sample follows and sits at the end.
  // NATIVE_STREAM_SEND=gateway sends it from another client instead (the control port), for a run
  // that measures the stream rather than the composer; the turn streams to the app the same way.
  const before = readState().completedTurns;
  assert(Number.isSafeInteger(before), 'Run setup first');
  // Not awaited here: the control call returns only once the turn has finished streaming. Its
  // failure is kept as a value and rethrown when the turn is read as done.
  const seeding =
    process.env.NATIVE_STREAM_SEND === 'gateway'
      ? call('POST', '/seed?turns=1').then(
          () => undefined,
          (cause) => cause,
        )
      : undefined;
  const sent = async () => {
    const failure = await seeding;
    if (failure) throw failure;
  };
  const samples = [];
  // The app has the new turn once its frame holds more events than before the prompt and a newer
  // last assistant entry: the gateway finishing the turn alone does not mean the app received it.
  const start = await frame();
  assert(start, 'No conversation frame before the stream');
  const reached = (value) =>
    value.eventCount > start.eventCount &&
    lastAssistant(value)?.key !== undefined &&
    lastAssistant(value)?.key !== lastAssistant(start)?.key;
  const deadline = Date.now() + 120000;
  for (;;) {
    assert(Date.now() < deadline, 'Timed out waiting for the streamed turn');
    const { completedTurns } = await call('GET', '/read');
    let value = await frame();
    const done = completedTurns > before && value?.caughtUp && reached(value);
    if (done && followless(value)) {
      // Follow is only reported: the turn streamed and nothing is checked.
      await sent();
      writeState({ ...readState(), completedTurns });
      report({ follow: value.follow ?? null, completedTurns });
      break;
    }
    if (value && !done && !followless(value)) {
      if (value.follow.distanceFromEnd > STREAM_ALLOWANCE) {
        await delay(SETTLE_MS);
        value = (await frame()) ?? value;
      }
      samples.push(value.follow);
    }
    if (done) {
      // Let the last delta's layout settle before reading the final position.
      await delay(1000);
      const settled = await frame();
      assert(settled && reached(settled), 'The app lost the streamed turn');
      const off = samples.filter(
        (follow) => !follow.following || follow.distanceFromEnd > STREAM_ALLOWANCE,
      );
      assert.equal(
        off.length,
        0,
        `Away from the end while streaming (${off.length}/${samples.length}): ${JSON.stringify(off[0])}`,
      );
      assert(
        samples.length >= MIN_STREAM_SAMPLES,
        `Only ${samples.length} samples while streaming; need ${MIN_STREAM_SAMPLES}`,
      );
      assert(
        settled.follow.following,
        `Not following after the stream: ${JSON.stringify(settled.follow)}`,
      );
      // On Android the end is read from the final row's layout (see endLayout); a list past its
      // end shows a negative gap, which fails too.
      const turnLastLine = lastAssistant(settled).text.trim().split('\n').at(-1).trim();
      const layout = android ? endLayout(turnLastLine) : undefined;
      assert(
        layout ? layout.gap >= 0 && layout.gap < SLACK : settled.follow.distanceFromEnd < SLACK,
        `Not at the end after the stream: ${JSON.stringify({ follow: settled.follow, layout })}`,
      );
      await sent();
      writeState({ ...readState(), completedTurns });
      report({
        samples: samples.length,
        maxDistance: Math.max(...samples.map((follow) => follow.distanceFromEnd)),
        final: settled.follow,
        ...(layout ? { finalRowLayout: layout } : {}),
        turnEvents: settled.eventCount,
        followChecked: true,
        completedTurns,
      });
      break;
    }
    await delay(150);
  }
} else if (phase === 'end-layout') {
  // Android: the final row's layout gap alone, to see the stream-end check read a list away from
  // its end (a negative gap) as well as one at it.
  assert(android, 'end-layout reads Android layout');
  report({ finalRowLayout: endLayout() });
} else if (phase === 'reader-away') {
  // The recipe's own scroll moved the reader back into the history: they stop following.
  const value = await until(
    (sample) =>
      followless(sample) || (!sample.follow.following && sample.follow.distanceFromEnd >= SLACK),
    'the reader away from the end',
  );
  report({ follow: value.follow ?? null, ...(requireFollow ? { followChecked: true } : {}) });
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
} else if (phase === 'status-bar-top') {
  // iOS scrolls to the top on a status bar tap: a scroll that is not a drag. The reader must stop
  // following, even right after the screen's own jump to the end.
  const tapped = device('click', '200', '12');
  assert(tapped.success, JSON.stringify(tapped.error));
  const value = await until(
    (sample) => !sample.follow.following && sample.follow.distanceFromEnd >= SLACK,
    'the status bar scroll leaving the end',
    15000,
  );
  report({ follow: value.follow });
} else if (phase === 'stays-away') {
  // New output must not pull a reader who left back to the end.
  const before = readState().completedTurns;
  await call('POST', '/seed?turns=1');
  await delay(1000);
  const value = await frame();
  assert(value, 'No conversation frame');
  assert.equal(value.follow.following, false, `Pulled back: ${JSON.stringify(value.follow)}`);
  assert(value.follow.distanceFromEnd >= SLACK, `Back at the end: ${JSON.stringify(value.follow)}`);
  assert(value.follow.unseen > 0, `No unseen output: ${JSON.stringify(value.follow)}`);
  writeState({ ...readState(), completedTurns: before + 1 });
  report({ follow: value.follow });
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
