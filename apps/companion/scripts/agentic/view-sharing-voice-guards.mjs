#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { workerInstructionAttempts } from './terminal-control-replies.mjs';

const mode = process.argv[2];
const caseDir = process.env.FARMSLOT_VIEW_SHARING_CASE;
const artifactDir = process.env.FARMSLOT_RECIPE_ARTIFACTS_DIR;
assert(caseDir && artifactDir);
const fixture = JSON.parse(await readFile(path.join(caseDir, 'fixture.json'), 'utf8'));
const setup = JSON.parse(await readFile(process.env.FARMSLOT_VIEW_SHARING_WORKER_RECEIPT, 'utf8'));
const save = (name, value) =>
  writeFile(path.join(artifactDir, name + '.json'), JSON.stringify(value, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
const counts = async () => {
  const response = await fetch(process.env.FARMSLOT_VIEW_SHARING_COUNTS_URL, {
    signal: AbortSignal.timeout(3000),
  });
  assert(response.ok);
  const current = await response.json();
  assert.equal(current.caseDir, caseDir);
  assert.equal(current.sourceRoot, fixture.sourceRoot);
  assert.equal(current.startId, process.env.FARMSLOT_VIEW_SHARING_PROXY_START_ID);
  assert.equal(current.failure, null);
  return current;
};
if (mode === 'begin' || mode === 'unavailable-begin') {
  const current = await counts();
  const input = (await readFile(setup.inputPath, 'utf8')).trim().split('\n').map(JSON.parse);
  await save(mode, { current, input });
} else if (mode === 'sent') {
  const baseline = JSON.parse(await readFile(path.join(artifactDir, 'begin.json'), 'utf8'));
  const input = (await readFile(setup.inputPath, 'utf8')).trim().split('\n').map(JSON.parse);
  const added = input
    .slice(baseline.input.length)
    .map((x) => x.data)
    .join('');
  assert.equal(added, 'Explain only this terminal.\r');
  const current = await counts();
  const before = workerInstructionAttempts(baseline.current);
  const after = workerInstructionAttempts(current);
  assert.equal(after.length, before.length + 1);
  assert.deepEqual(after.slice(0, before.length), before);
  const last = after.at(-1);
  assert.equal(last.method, 'terminal.worker.input');
  assert.equal(last.origin, process.env.FARMSLOT_VIEW_SHARING_NATIVE_ORIGIN);
  assert.equal(last.dataSha256, createHash('sha256').update(added).digest('hex'));
  assert(
    current.responses.some((r) => r.connectionId === last.connectionId && r.id === last.id && r.ok),
  );
  assert.equal(
    execFileSync('ps', ['-p', String(setup.serverPid), '-o', 'lstart='], {
      encoding: 'utf8',
    }).trim(),
    setup.serverBirth,
  );
  assert.equal(
    execFileSync('ps', ['-p', String(setup.panePid), '-o', 'lstart='], { encoding: 'utf8' }).trim(),
    setup.paneBirth,
  );
  await save(mode, { input, current, added, ownedReceiver: true });
} else {
  const { createAgentDeviceClient } = await import('agent-device');
  const device = createAgentDeviceClient({ stateDir: process.env.FARMSLOT_AGENT_DEVICE_STATE_DIR });
  const sessions = (await device.sessions.list()).filter(
    (s) => s.device.id === process.env.ADB_SERIAL,
  );
  assert.equal(sessions.length, 1);
  const selection = {
    session: sessions[0].name,
    platform: 'android',
    target: 'mobile',
    serial: process.env.ADB_SERIAL,
  };
  if (mode === 'open-worker') {
    const observed = JSON.parse(
      await readFile(process.env.FARMSLOT_VIEW_SHARING_DIRECT_WORKER, 'utf8'),
    );
    assert.equal(observed.method, 'copilot.status');
    assert.equal(observed.worker.nodeId, fixture.machine);
    assert.equal(observed.worker.session, setup.session);
    assert.equal(observed.worker.paneId, setup.paneId);
    const params = new URLSearchParams({
      workerRef: encodeURIComponent(JSON.stringify(observed.worker)),
    });
    await device.apps.open({
      ...selection,
      app: process.env.FARMSLOT_RECIPE_APP_ID,
      url: 'farmslot-development:///terminal/worker?' + params,
      relaunch: false,
      noRecord: true,
    });
    await save(mode, observed);
  } else if (mode === 'review') {
    const screen = await device.capture.snapshot({ ...selection, raw: true, depth: 40 });
    const field = screen.nodes.find((n) => n.identifier === 'worker-voice-instruction');
    assert.equal(field?.value ?? field?.label, 'Explain only this terminal.');
    assert(
      !screen.nodes.some((n) => n.identifier === 'worker-voice-context'),
      'A direct terminal gesture must not inherit a previous run draft',
    );
    const send = screen.nodes.find((n) => n.identifier === 'worker-voice-send');
    const bubble = screen.nodes.find((n) => n.identifier === 'companion-quick-actions');
    assert(send?.enabled && send.rect && bubble?.rect);
    const a = send.rect,
      b = bubble.rect;
    assert([a.x, a.y, a.width, a.height, b.x, b.y, b.width, b.height].every(Number.isFinite));
    assert(
      a.x + a.width <= b.x ||
        b.x + b.width <= a.x ||
        a.y + a.height <= b.y ||
        b.y + b.height <= a.y,
      'The floating action must not cover Send',
    );
    await device.capture.screenshot({
      ...selection,
      path: path.join(artifactDir, 'direct-reviewed.png'),
    });
    await save(mode, { screen, send, bubble });
  } else if (mode === 'unavailable') {
    const screen = await device.capture.snapshot({ ...selection, raw: true, depth: 40 });
    assert(screen.nodes.some((n) => n.identifier === 'companion-screen-copilot'));
    const terminal = screen.nodes.find((n) => n.identifier === 'companion-copilot-terminal');
    assert.equal(terminal?.enabled, false);
    assert(!screen.nodes.some((n) => n.identifier === 'worker-voice-record-widget'));
    assert(
      screen.nodes.some((n) =>
        [n.label, n.value].some(
          (t) => typeof t === 'string' && t.includes('run=' + fixture.runs[0].id.slice(0, 16)),
        ),
      ),
    );
    const baseline = JSON.parse(
      await readFile(path.join(artifactDir, 'unavailable-begin.json'), 'utf8'),
    );
    const current = await counts();
    assert.deepEqual(
      workerInstructionAttempts(current),
      workerInstructionAttempts(baseline.current),
    );
    await device.capture.screenshot({
      ...selection,
      path: path.join(artifactDir, 'unavailable-copilot.png'),
    });
    await save(mode, { screen, current, notLaunched: true, notRecorded: true });
  } else throw new Error('Unknown voice guard mode ' + mode);
}
console.log(JSON.stringify({ status: 'PASS', mode }));
