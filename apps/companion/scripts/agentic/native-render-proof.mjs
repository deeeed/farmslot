#!/usr/bin/env node
// Companion native rendering proof: T3 Code's markdown, highlighting, file chips, file viewer and
// native diffs in a real native conversation. It reads only the isolated stack's control port
// (native-stream-stack.mts with the native-render-opencode.cjs peer) and the app's own render
// reports over the Metro recipe relay (`native-render:` and `runs-cache:conversation:` refs).
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const phase = process.argv[2];
const control = process.env.NATIVE_RENDER_CONTROL;
const stateFile = process.env.NATIVE_RENDER_STATE;
const metro = process.env.METRO_PORT;
const simulator = process.env.IOS_SIMULATOR;
assert(control && stateFile && /^\d+$/.test(metro ?? '') && simulator, 'Set the proof environment');
const agentDevice = fileURLToPath(
  new URL('../../../../node_modules/.bin/agent-device', import.meta.url),
);
// Pairing's native alerts are the only native input this script gives; the recipe drives the rest.
const stateDir =
  process.env.FARMSLOT_AGENT_DEVICE_STATE_DIR ??
  path.join(tmpdir(), 'farmslot-agent-device', simulator.replace(/[^a-zA-Z0-9._-]/gu, '-'));
function deviceSession() {
  const slot = process.env.FARMSLOT_SLOT_ID ?? path.basename(process.env.RUNTIME_DIR ?? 'local');
  const sessions = path.join(stateDir, 'sessions');
  const live = (existsSync(sessions) ? readdirSync(sessions) : []).filter((name) => {
    const pid = Number(name.slice(`farmslot-${slot}-`.length));
    if (!name.startsWith(`farmslot-${slot}-`) || !Number.isSafeInteger(pid)) return false;
    return spawnSync('ps', ['-p', String(pid)]).status === 0;
  });
  assert(live.length <= 1, `More than one live recipe session: ${live.join(', ')}`);
  return live[0] ?? 'native-render-proof';
}
const device = (...args) => {
  const result = spawnSync(
    agentDevice,
    [...args, '--session', deviceSession(), '--platform', 'ios', '--udid', simulator, '--json'],
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

const call = async (method, route) => {
  const response = await fetch(`${control}${route}`, { method });
  const body = await response.json();
  assert(response.ok, body.error);
  return body;
};
const readState = () => JSON.parse(readFileSync(stateFile, 'utf8'));
const report = (result) => console.log(JSON.stringify({ phase, ...result }));

async function observe(ref) {
  const response = await fetch(`http://127.0.0.1:${metro}/farmslot-recipe/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      command: 'observeUi',
      nodeId: 'native-render',
      payload: { refs: [ref] },
      timeout_ms: 3000,
    }),
    signal: AbortSignal.timeout(5000),
  });
  // A route transition replaces the app's long poll; no sample until its replacement.
  if (response.status === 504) return undefined;
  assert(response.ok, `Observer HTTP ${response.status}`);
  const reply = await response.json();
  assert(reply.ok, reply.error);
  return reply.observations;
}
/** Polls `read` until `check` passes, which returns failure text or null; the last failure is thrown. */
async function until(read, check, label, timeout = 60000) {
  const deadline = Date.now() + timeout;
  let failure = 'no sample';
  while (Date.now() < deadline) {
    const value = await read();
    failure = value === undefined ? 'no sample' : check(value);
    if (failure === null) return value;
    await delay(250);
  }
  throw new Error(`Timed out: ${label}: ${failure}`);
}
const render = async () => (await observe(`native-render:${readState().sessionId}`))?.nativeRender;
const conversation = async () =>
  (await observe(`runs-cache:conversation:${readState().sessionId}`))?.runCollections?.conversation;
const DEMO = 'src/demo.ts';
const LINE = 32;
const nativeDiff = (diff) =>
  !diff
    ? 'no diff rendered'
    : diff.surface !== 'native'
      ? `surface ${diff.surface}`
      : diff.decodedRows !== diff.rows
        ? `native decoded ${diff.decodedRows} of ${diff.rows} rows`
        : !diff.drawn
          ? 'native view has not drawn'
          : diff.tokenRows === 0
            ? 'no highlighted rows'
            : null;

if (phase === 'pair') {
  // Setup: pair through the app's own link and native alerts. Opening the app can deliver the link
  // twice; the second shows "Pairing already running", which is dismissed while the first goes on.
  // A saved profile for the previous stack can fail the first exchange; a fresh link then pairs.
  const answers = [
    ['Open in', 'Open'],
    ['Pairing already running', 'OK'],
    ['Pair with this gateway?', 'Pair'],
    ['Pairing failed', 'OK'],
    ['Companion paired', 'OK'],
  ];
  let outcome = '';
  for (let attempt = 0; outcome !== 'Companion paired'; attempt++) {
    assert(attempt < 3, 'Pairing failed three times');
    const { link } = await call('POST', '/pair');
    execFileSync('xcrun', ['simctl', 'openurl', simulator, link]);
    device('open', 'net.siteed.farmslot.development');
    const deadline = Date.now() + 120000;
    for (outcome = ''; outcome !== 'Companion paired' && outcome !== 'Pairing failed'; ) {
      assert(Date.now() < deadline, 'Pairing did not finish');
      const alert = device('alert', 'get');
      if (!alert.success)
        assert.equal(alert.error?.message, 'alert not found', JSON.stringify(alert.error));
      const text = alert.success ? JSON.stringify(alert.data) : '';
      const answer = answers.find(([title]) => text.includes(title));
      if (!answer) {
        await delay(500);
        continue;
      }
      const pressed = device('press', `label="${answer[1]}"`);
      // The alert can close between reading and pressing it; the next read sees what replaced it.
      if (pressed.success) outcome = answer[0];
    }
  }
  assert(device('close').success, 'Could not release the device');
  report({ paired: true });
} else if (phase === 'setup') {
  assert(!existsSync(stateFile), 'Use a new NATIVE_RENDER_STATE file');
  const { sessionId } = await call('POST', '/session');
  writeFileSync(stateFile, `${JSON.stringify({ sessionId })}\n`, { mode: 0o600 });
  report({ sessionId });
} else if (phase === 'open') {
  execFileSync('xcrun', [
    'simctl',
    'openurl',
    simulator,
    `farmslot-development:///native?sessionId=${encodeURIComponent(readState().sessionId)}&executionNodeId=local`,
  ]);
  await until(conversation, (value) => (value.caughtUp ? null : 'not caught up'), 'history');
  report({ open: true });
} else if (phase === 'reply') {
  // The reply rendered as native markdown: its fenced TypeScript block and both file links.
  const value = await until(
    render,
    (value) => {
      const message = Object.values(value.messages ?? {}).find((entry) =>
        entry.links.some((link) => link.startsWith(DEMO)),
      );
      if (!message) return 'no markdown message with a file link';
      if (!message.codeBlocks.some((block) => block.language === 'ts' && block.lines === 4))
        return `code blocks ${JSON.stringify(message.codeBlocks)}`;
      if (!message.links.includes(`${DEMO}:${LINE}`)) return `links ${message.links}`;
      if (!message.links.includes('notes/plan.md'))
        return `inline file chip missing: ${message.links}`;
      return null;
    },
    'the markdown reply',
    120000,
  );
  report({ messages: value.messages });
} else if (phase === 'tool-diff' || phase === 'turn-diff') {
  const source = phase === 'tool-diff' ? 'tool' : 'turn';
  const value = await until(
    render,
    (value) => {
      const diff = Object.values(value.diffs ?? {}).find((entry) => entry.source === source);
      return (
        nativeDiff(diff) ??
        (diff.paths.some((file) => file.endsWith(DEMO)) ? null : `paths ${diff.paths}`)
      );
    },
    `the ${source} diff`,
  );
  report({ diffs: value.diffs });
} else if (phase === 'file-line') {
  // The chip opened the native source view at its line, highlighted, with that line on screen.
  const value = await until(
    render,
    ({ file }) =>
      !file
        ? 'no file viewer'
        : file.path !== DEMO || file.line !== LINE
          ? `opened ${file.path}:${file.line}`
          : file.surface !== 'native'
            ? `surface ${file.surface}`
            : file.targetIndex !== LINE - 1
              ? `target ${file.targetIndex}`
              : !(file.coloredLines > 0)
                ? `${file.status}: no highlighted lines ${file.error ?? ''}`
                : !file.visibleRange ||
                    file.visibleRange.first > LINE - 1 ||
                    file.visibleRange.last < LINE - 1 ||
                    file.visibleRange.first === 0
                  ? `visible rows ${JSON.stringify(file.visibleRange)}`
                  : null,
    'the file at its line',
  );
  report({ file: value.file });
} else if (phase === 'markdown-rendered') {
  const value = await until(
    render,
    ({ file }) =>
      file?.path !== 'notes/plan.md'
        ? `opened ${file?.path}`
        : file.mode !== 'rendered'
          ? `mode ${file.mode}`
          : !file.markdown?.codeBlocks.some((block) => block.language === 'ts')
            ? `rendered blocks ${JSON.stringify(file.markdown)}`
            : !file.markdown.links.includes('../src/demo.ts:32')
              ? `links ${file.markdown.links}`
              : null,
    'the rendered markdown file',
  );
  report({ file: value.file });
} else if (phase === 'markdown-raw') {
  const value = await until(
    render,
    ({ file }) =>
      file?.path !== 'notes/plan.md'
        ? `opened ${file?.path}`
        : file.mode !== 'raw'
          ? `mode ${file.mode}`
          : file.surface !== 'native' || file.language !== 'md'
            ? `raw ${file.surface} ${file.language}`
            : null,
    'the raw markdown source',
  );
  report({ file: value.file });
} else if (phase === 'reveal') {
  // The finished turn folds its work, reply included, above the end the reader follows. The recipe
  // opened the fold; drag the conversation until `label` is on screen: toward its start by
  // default, or toward its end with `end`.
  const label = process.argv[3];
  const [from, to] = process.argv[4] === 'end' ? ['700', '450'] : ['450', '700'];
  assert(label, 'Name the label to reveal');
  for (let attempt = 0; ; attempt++) {
    const tree = device('snapshot');
    assert(tree.success, JSON.stringify(tree.error));
    if (JSON.stringify(tree.data).includes(label)) break;
    assert(attempt < 6, `${label} did not come into view`);
    assert(device('swipe', '200', from, '200', to, '300').success, 'Could not drag the list');
  }
  report({ revealed: label });
} else throw new Error(`Unknown phase ${phase}`);
