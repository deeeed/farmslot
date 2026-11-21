// Shows that a list's rows actually move under a recipe's drag, from the device's own view tree
// (agent-device snapshot): it works on release builds, which have no recipe bridge. jank.recipe.json
// runs it around one in-list drag before measuring a list, so an empty list (nothing to scroll)
// fails the run instead of measuring some other animation.
//
//   PLATFORM=android ADB_SERIAL=<serial> node scripts/agentic/list-scroll-proof.mjs mark <screen test id>
//   (the drag)
//   PLATFORM=android ADB_SERIAL=<serial> node scripts/agentic/list-scroll-proof.mjs moved <screen test id>
//
// `mark` records the labelled rows on the screen and their positions; `moved` reads them again and
// fails unless a row seen both times moved up by at least MIN_MOVE_PX. On iOS set PLATFORM=ios and
// IOS_SIMULATOR=<udid>.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [phase, screen] = process.argv.slice(2);
assert(['mark', 'moved'].includes(phase) && screen, 'Usage: mark|moved <screen test id>');
const android = process.env.PLATFORM === 'android';
// The same variables @farmslot/adapter-rn reads, so this script reads the recipe's device.
const target = android
  ? (process.env.ADB_SERIAL ?? process.env.ANDROID_SERIAL ?? process.env.ANDROID_DEVICE)
  : process.env.IOS_SIMULATOR;
assert(target, 'Set PLATFORM and the device (ADB_SERIAL or IOS_SIMULATOR)');
/** A 900 px drag moves a list's rows by far more; layout jitter by far less. */
const MIN_MOVE_PX = 200;
const targetArgs = android
  ? ['--platform', 'android', '--serial', target]
  : ['--platform', 'ios', '--udid', target];
const agentDevice = fileURLToPath(
  new URL('../../../../node_modules/.bin/agent-device', import.meta.url),
);
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
  return live[0] ?? 'list-scroll-proof';
}
const session = deviceSession();
// agent-device reports a failed command as JSON on stdout, with or without a non-zero exit.
const device = (...args) => {
  const result = spawnSync(agentDevice, [...args, '--session', session, ...targetArgs, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, AGENT_DEVICE_STATE_DIR: stateDir },
  });
  assert(result.stdout?.trim(), `agent-device ${args[0]} printed nothing: ${result.stderr}`);
  return JSON.parse(result.stdout);
};

/** Each labelled row on the screen, by label, with its top edge; repeated labels are left out. */
function rows() {
  const shot = device('snapshot');
  assert(shot.success, JSON.stringify(shot.error));
  // Outside a recipe this script opened its own session: hand the device back.
  if (session === 'list-scroll-proof')
    assert(device('close').success, 'Could not release the device');
  const nodes = shot.data.nodes;
  const root = nodes.find((node) => node.identifier === screen);
  assert(root, `${screen} is not on screen`);
  // Descendants of the screen (parents come before children).
  const inside = new Set([root.index]);
  for (const node of nodes) if (inside.has(node.parentIndex)) inside.add(node.index);
  const found = new Map();
  const repeated = new Set();
  for (const node of nodes) {
    if (
      node.index === root.index ||
      !inside.has(node.index) ||
      !node.label ||
      !(node.rect?.height > 0)
    )
      continue;
    if (found.has(node.label)) repeated.add(node.label);
    found.set(node.label, node.rect.y);
  }
  for (const label of repeated) found.delete(label);
  return found;
}

const stateFile = path.join(
  tmpdir(),
  'farmslot-list-scroll',
  `${target.replace(/[^a-zA-Z0-9._-]/gu, '-')}-${screen}.json`,
);
if (phase === 'mark') {
  const marked = rows();
  mkdirSync(path.dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, `${JSON.stringify(Object.fromEntries(marked))}\n`);
  console.log(JSON.stringify({ phase, screen, rows: marked.size }));
} else {
  const before = new Map(Object.entries(JSON.parse(readFileSync(stateFile, 'utf8'))));
  const after = rows();
  const moves = [...after]
    .filter(([label]) => before.has(label))
    .map(([label, y]) => ({ label: label.slice(0, 60), from: before.get(label), to: y }))
    .filter((move) => move.from - move.to >= MIN_MOVE_PX);
  const result = {
    phase,
    screen,
    rowsBefore: before.size,
    rowsAfter: after.size,
    rowsMoved: moves.length,
  };
  console.log(JSON.stringify({ ...result, example: moves[0] ?? null }));
  assert(moves.length > 0, `No row of ${screen} moved up by ${MIN_MOVE_PX} px under the drag`);
}
