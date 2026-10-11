#!/usr/bin/env node
// Fixture and side-effect checks for terminal-runner-keys.recipe.json.
//
//   setup                 two tmux panes that print each byte they read as hex: one runs a
//                         binary named `claude`, one named `keysink`; waits until the slot
//                         gateway lists both new panes and checks the processRunnerIds it derived
//                         and that neither carries a linkedRunner
//   row <known|unknown>   waits for that pane's row on the Terminals tab and prints its exact
//                         accessibility label, the selector ui.press needs
//   terminals             opens the Terminals tab
//   back                  taps the terminal's Back control
//   bytes <pane> <hex..>  every byte the pane has read equals the given hex bytes, so one tap
//                         sent the key data exactly once
//   teardown              kills both panes
//
// Panes are opened by tapping their Terminals row, not by deep link: deep-link query values
// are percent-decoded until no escape is left, so a pane id such as `%225` cannot survive one.
// Rows carry no testID and agent-device selectors match labels exactly, so the row's composite
// accessibility label is read first. Session names start with `0-` so both rows sort
// to the top of the list, on screen. The header Back control is not hittable to agent-device,
// so `back` taps the centre of its accessibility frame through idb.
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
  known: { session: `0-keys-known-${GATEWAY_PORT}`, binary: 'claude', runnerIds: ['claude'] },
  unknown: { session: `0-keys-unknown-${GATEWAY_PORT}`, binary: 'keysink', runnerIds: undefined },
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
      execFileSync('tmux', ['has-session', '-t', `=${session}`], { stdio: 'ignore' });
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

// Matches the new pane id once it runs its binary: a cached listing can still hold the previous
// run's pane, and a fresh pane reports its shell until the exec lands.
async function waitForPanes(paneIds) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const { workers } = rpc('tmux.worker.list', { includeDisconnected: false });
    const found = Object.fromEntries(
      Object.entries(PANES).map(([name, pane]) => [
        name,
        workers.find(
          (worker) =>
            worker.ref.session === pane.session &&
            worker.ref.paneId === paneIds[name] &&
            worker.command === pane.binary,
        ),
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

function simulatorUdid() {
  const device = process.env.IOS_SIMULATOR ?? SIMULATOR;
  assert(device, 'SIMULATOR comes from the slot configuration');
  const { devices } = JSON.parse(
    execFileSync('xcrun', ['simctl', 'list', 'devices', 'booted', '-j'], { encoding: 'utf8' }),
  );
  const match = Object.values(devices)
    .flat()
    .find((entry) => entry.udid === device || entry.name === device);
  assert(match, `simulator ${device} is not booted`);
  return match.udid;
}

// idb reads the accessibility tree and taps; adapter-rn already uses it for iOS gestures. The
// recipe's agent-device session owns the device, so a second agent-device session is refused.
const idb = process.env.RECIPE_RN_IDB_PATH ?? 'idb';

function describeUi(udid) {
  return JSON.parse(
    execFileSync(idb, ['ui', 'describe-all', '--udid', udid], { encoding: 'utf8' }),
  );
}

async function waitForRowLabel(paneSession) {
  const udid = simulatorUdid();
  const deadline = Date.now() + 15_000;
  for (;;) {
    const row = describeUi(udid).find((element) => element.AXLabel?.startsWith(`${paneSession}, `));
    if (row) return row.AXLabel;
    if (Date.now() > deadline) throw new Error(`no Terminals row for ${paneSession}`);
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
  const paneIds = {};
  for (const [key, pane] of Object.entries(PANES)) {
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
    paneIds[key] = tmux('display-message', '-p', '-t', `=${pane.session}:`, '#{pane_id}').trim();
  }
  const workers = await waitForPanes(paneIds);
  for (const [key, pane] of Object.entries(PANES)) {
    assert.deepEqual(workers[key].processRunnerIds, pane.runnerIds, `${key} processRunnerIds`);
    // No run is linked to the fixture panes, so the gateway must not name a linked runner.
    assert.equal(workers[key].linkedRunner, undefined, `${key} linkedRunner`);
  }
  const state = Object.fromEntries(
    Object.entries(workers).map(([key, worker]) => [key, worker.ref]),
  );
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
  console.log(JSON.stringify({ phase, pass: true, workers }));
} else if (phase === 'row') {
  const ref = readState()[name];
  assert(ref, `unknown pane ${name}`);
  process.stdout.write(await waitForRowLabel(ref.session));
} else if (phase === 'back') {
  const udid = simulatorUdid();
  // The label is the chevron glyph followed by `, Back`.
  const control = describeUi(udid).find((element) => element.AXLabel?.endsWith(', Back'));
  assert(control, 'no Back control on screen');
  const { x, y, width, height } = control.frame;
  execFileSync(idb, [
    'ui',
    'tap',
    '--udid',
    udid,
    String(Math.round(x + width / 2)),
    String(Math.round(y + height / 2)),
  ]);
  console.log(JSON.stringify({ phase, pass: true }));
} else if (phase === 'terminals') {
  assert(SCHEME && SIMULATOR, 'SCHEME and SIMULATOR come from the slot configuration');
  execFileSync('xcrun', ['simctl', 'openurl', SIMULATOR, `${SCHEME}:///workers`]);
  console.log(JSON.stringify({ phase, pass: true }));
} else if (phase === 'bytes') {
  const pane = PANES[name];
  assert(pane && hex.length > 0, 'usage: bytes <known|unknown> <hex...>');
  const read = () =>
    tmux('capture-pane', '-p', '-S', '-200', '-t', `=${pane.session}:`)
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^[0-9a-f]{2}$/.test(line))
      .join(' ');
  const expected = hex.join(' ');
  const deadline = Date.now() + 10_000;
  while (read() !== expected) {
    if (Date.now() > deadline)
      throw new Error(`${pane.session} read ${read()}, expected ${expected}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  // A second copy of the key data can land just after the first match.
  await new Promise((resolve) => setTimeout(resolve, 500));
  const settled = read();
  assert.equal(settled, expected, `${pane.session} kept reading after the key data`);
  console.log(JSON.stringify({ phase, pass: true, pane: name, bytes: hex }));
} else if (phase === 'teardown') {
  for (const pane of Object.values(PANES)) killSession(pane.session);
  fs.rmSync(workDir, { recursive: true, force: true });
  console.log(JSON.stringify({ phase, pass: true }));
} else {
  throw new Error(`Unknown phase ${phase}`);
}
