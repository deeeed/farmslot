#!/usr/bin/env node
// Fixture and side-effect checks for terminal-runner-keys.recipe.json.
//
//   setup                 two tmux panes that print each byte they read as hex: one runs a
//                         binary named `claude`, one named `keysink`; waits until the slot
//                         gateway lists both and checks the processRunnerIds it derived
//   open <known|unknown>  opens that pane's worker terminal through the app's deep link
//   leave                 opens the workers tab, unmounting any worker terminal
//   bytes <pane> <hex..>  the pane's most recent bytes equal the given hex bytes
//   teardown              kills both panes
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const root = path.resolve(appDir, '../..');
const { GATEWAY_PORT, SCHEME, SIMULATOR } = process.env;
assert.match(GATEWAY_PORT ?? '', /^\d+$/, 'GATEWAY_PORT comes from the slot configuration');
const workDir = path.join(appDir, '.agent', `terminal-runner-keys-${GATEWAY_PORT}`);
const statePath = path.join(workDir, 'state.json');
const PANES = {
  known: { session: `fs-keys-known-${GATEWAY_PORT}`, binary: 'claude', runnerIds: ['claude'] },
  unknown: { session: `fs-keys-unknown-${GATEWAY_PORT}`, binary: 'keysink', runnerIds: undefined },
};
const SINK_SOURCE = `#include <stdio.h>
#include <unistd.h>
int main(void) {
  unsigned char c;
  while (read(0, &c, 1) == 1) { printf("%02x\\n", c); fflush(stdout); }
  return 0;
}
`;

function tmux(...args) {
  return execFileSync('tmux', args, { encoding: 'utf8' });
}

function killSession(session) {
  // has-session exits 1 when the session is absent; only an existing one is killed.
  const exists = (() => {
    try {
      tmux('has-session', '-t', `=${session}`);
      return true;
    } catch (error) {
      if (error.status === 1) return false;
      throw error;
    }
  })();
  if (exists) tmux('kill-session', '-t', `=${session}`);
}

function rpc(method, params) {
  const output = execFileSync(
    process.execPath,
    [
      path.join(root, 'apps/command-center/scripts/cdp.mjs'),
      'gateway',
      method,
      JSON.stringify(params),
    ],
    {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, FARMSLOT_GATEWAY: `ws://127.0.0.1:${GATEWAY_PORT}/ws` },
    },
  );
  return JSON.parse(output);
}

async function waitForPanes() {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const { workers } = rpc('tmux.worker.list', { includeDisconnected: false });
    const found = Object.fromEntries(
      Object.entries(PANES).map(([name, pane]) => [
        name,
        workers.find((worker) => worker.ref.session === pane.session),
      ]),
    );
    if (found.known && found.unknown) return found;
    if (Date.now() > deadline) {
      throw new Error(
        `gateway did not list ${Object.values(PANES)
          .map((p) => p.session)
          .join(', ')}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

function readState() {
  return JSON.parse(fs.readFileSync(statePath, 'utf8'));
}

const [phase, name, ...hex] = process.argv.slice(2);

if (phase === 'setup') {
  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(path.join(workDir, 'sink.c'), SINK_SOURCE);
  for (const pane of Object.values(PANES)) {
    execFileSync('cc', [
      '-O2',
      '-o',
      path.join(workDir, pane.binary),
      path.join(workDir, 'sink.c'),
    ]);
    killSession(pane.session);
    tmux(
      'new-session',
      '-d',
      '-s',
      pane.session,
      '-x',
      '120',
      '-y',
      '30',
      `stty -icanon -echo -isig -ixon -iexten -icrnl; exec ${JSON.stringify(path.join(workDir, pane.binary))}`,
    );
  }
  const workers = await waitForPanes();
  for (const [key, pane] of Object.entries(PANES)) {
    assert.equal(workers[key].command, pane.binary);
    assert.deepEqual(workers[key].processRunnerIds, pane.runnerIds, `${key} processRunnerIds`);
  }
  const state = Object.fromEntries(
    Object.entries(workers).map(([key, worker]) => [key, worker.ref]),
  );
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
  console.log(JSON.stringify({ phase, pass: true, workers }));
} else if (phase === 'open') {
  const ref = readState()[name];
  assert(ref, `unknown pane ${name}`);
  assert(SCHEME && SIMULATOR, 'SCHEME and SIMULATOR come from the slot configuration');
  const query = new URLSearchParams({
    workerRef: JSON.stringify(ref),
    nodeId: ref.nodeId,
    session: ref.session,
    target: ref.target,
    ...(ref.window ? { window: ref.window } : {}),
    ...(ref.pane ? { pane: ref.pane } : {}),
    ...(ref.paneId ? { paneId: ref.paneId } : {}),
    title: ref.session,
  });
  execFileSync('xcrun', ['simctl', 'openurl', SIMULATOR, `${SCHEME}:///terminal/worker?${query}`]);
  console.log(JSON.stringify({ phase, pass: true, pane: name, ref }));
} else if (phase === 'leave') {
  assert(SCHEME && SIMULATOR, 'SCHEME and SIMULATOR come from the slot configuration');
  execFileSync('xcrun', ['simctl', 'openurl', SIMULATOR, `${SCHEME}:///workers`]);
  console.log(JSON.stringify({ phase, pass: true }));
} else if (phase === 'bytes') {
  const pane = PANES[name];
  assert(pane && hex.length > 0, 'usage: bytes <known|unknown> <hex...>');
  const deadline = Date.now() + 10_000;
  let received = [];
  for (;;) {
    received = tmux('capture-pane', '-p', '-S', '-200', '-t', `=${pane.session}:`)
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^[0-9a-f]{2}$/.test(line));
    if (received.slice(-hex.length).join(' ') === hex.join(' ')) break;
    if (Date.now() > deadline) {
      throw new Error(
        `${pane.session} last bytes ${received.slice(-hex.length).join(' ')}, expected ${hex.join(' ')}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  console.log(JSON.stringify({ phase, pass: true, pane: name, bytes: hex }));
} else if (phase === 'teardown') {
  for (const pane of Object.values(PANES)) killSession(pane.session);
  fs.rmSync(workDir, { recursive: true, force: true });
  console.log(JSON.stringify({ phase, pass: true }));
} else {
  throw new Error(`Unknown phase ${phase}`);
}
