// Run against the authenticated disposable workspace.rpc.live.ts UI fixture.
// The caller owns the simulator/session and fixture teardown. No product slot is eligible.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createAgentDeviceClient } from 'agent-device';

const output = process.env.FARMSLOT_WORKSPACE_UI_PROOF_OUT;
const deviceFile = process.env.FARMSLOT_WORKSPACE_PROOF_DEVICE;
assert.ok(output && deviceFile, 'Set the UI proof output and owned device record');
const context = JSON.parse(fs.readFileSync(path.join(output, 'ui-context.json'), 'utf8'));
const root = fs.realpathSync(context.root);
assert.ok(root.startsWith(path.join(fs.realpathSync(os.tmpdir()), 'workspace-recovery-')));
const device = JSON.parse(fs.readFileSync(deviceFile, 'utf8'));
assert.equal(device.name, 'Fleet recovery proof', 'Use a dedicated proof simulator');
for (const repo of [context.repo, context.secondRepo, context.localRepo])
  assert.ok(fs.realpathSync(repo).startsWith(root + path.sep));
const client = createAgentDeviceClient({ stateDir: device.deviceStateDir });
const selection = {
  session: device.session,
  platform: device.platform ?? 'ios',
  ...(device.platform === 'android' ? { serial: device.serial } : { udid: device.udid }),
};
const git = (repo, ...args) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
const snapshot = () =>
  client.capture.snapshot({
    ...selection,
    interactiveOnly: false,
    forceFull: true,
    timeoutMs: 20_000,
  });
const press = (selector) => client.interactions.press({ ...selection, selector });
const wait = async (predicate, label) => {
  const deadline = Date.now() + 300_000;
  for (;;) {
    const value = await snapshot();
    if (predicate(value)) return value;
    assert.ok(Date.now() < deadline, `Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
};
const has = (value, label) => value.nodes.some((node) => node.label === label);
const reveal = async (id) => {
  for (let attempt = 0; attempt < 6; attempt++) {
    const value = await snapshot();
    const node = value.nodes.find((item) => item.identifier === id);
    const rectangles = value.nodes.flatMap((item) => (item.rect ? [item.rect] : []));
    assert.ok(rectangles.length, 'Native snapshot must expose viewport dimensions');
    const screen = {
      width: Math.max(...rectangles.map((rect) => rect.x + rect.width)),
      height: Math.max(...rectangles.map((rect) => rect.y + rect.height)),
    };
    if (
      node?.rect &&
      node.rect.y > screen.height * 0.12 &&
      node.rect.y + node.rect.height < screen.height * 0.88
    )
      return;
    await client.interactions.swipe({
      ...selection,
      from: { x: screen.width * 0.5, y: screen.height * 0.8 },
      to: { x: screen.width * 0.5, y: screen.height * 0.4 },
      durationMs: 500,
    });
  }
  throw new Error(`Native control is not visible: ${id}`);
};
const capture = async (name) => {
  fs.writeFileSync(path.join(output, `${name}.json`), JSON.stringify(await snapshot(), null, 2));
  await client.capture.screenshot({ ...selection, path: path.join(output, `${name}.png`) });
};
const assertReady = (slotId, repo) => {
  assert.equal(git(repo, 'branch', '--show-current'), 'main');
  assert.equal(git(repo, 'rev-parse', 'HEAD'), git(repo, 'rev-parse', 'origin/main'));
  assert.equal(fs.readFileSync(path.join(repo, 'fixture.txt'), 'utf8'), 'synced fixture\n');
  const status = JSON.parse(fs.readFileSync(path.join(root, 'status.json'), 'utf8'));
  const row = status.slots.find((slot) => slot.slot === slotId);
  assert.equal(row.lifecycle, 'ready');
  assert.equal(row.current_run_id ?? null, null);
  assert.equal(row.workspace_recovery ?? null, null);
  assert.equal(row.fixtures, 'OK');
};
const localFile = path.join(context.localRepo, 'local.txt');
const originalHead = git(context.localRepo, 'rev-parse', 'HEAD');
const originalWork = fs.readFileSync(localFile, 'utf8');
const unchanged = () => {
  assert.equal(git(context.localRepo, 'rev-parse', 'HEAD'), originalHead);
  assert.equal(fs.readFileSync(localFile, 'utf8'), originalWork);
};

try {
  console.log('Inspecting the authenticated native Fleet screen');
  const initial = await snapshot();
  if (initial.nodes.some((node) => node.identifier === 'fleet-recovery-close'))
    await press('id="fleet-recovery-close"');
  await wait((value) => value.nodes.some((n) => n.identifier === 'fleet-release-idle'), 'Fleet');
  await press('id="fleet-release-idle"');
  await wait((value) => has(value, 'Release idle slots (2)'), 'two safe bulk targets');
  console.log('Verified two safe bulk targets');
  await capture('native-bulk-review');
  await press('label="Release idle slots (2)"');
  await wait(
    (value) => value.nodes.filter((n) => n.label?.startsWith('refreshed')).length >= 2,
    'bulk recovery completion',
  );
  assertReady('proof-slot', context.repo);
  assertReady('proof-slot-two', context.secondRepo);
  unchanged();
  console.log('Verified native bulk results and preserved unpublished work');
  await capture('native-bulk-complete');
  await press('id="fleet-recovery-close"');

  await reveal('fleet-release-proof-unpublished');
  await press('id="fleet-release-proof-unpublished"');
  await wait((value) => has(value, 'Keep work'), 'discard warning');
  await capture('native-discard-warning');
  await press('label="Keep work"');
  unchanged();
  await press('label="Release and update to main"');
  await wait((value) => has(value, 'Keep work'), 'renewed discard warning');
  // A real edit after the confirmation was created, with unchanged HEAD and slot epoch.
  const changedWork = originalWork + 'changed after confirmation\n';
  fs.writeFileSync(localFile, changedWork);
  await press('label="Discard local work and update"');
  await wait(
    (value) => value.nodes.some((n) => n.label?.includes('Workspace changed')),
    'changed-content refusal',
  );
  assert.equal(git(context.localRepo, 'rev-parse', 'HEAD'), originalHead);
  assert.equal(fs.readFileSync(localFile, 'utf8'), changedWork);
  await capture('native-changed-content-refused');

  await press('label="Inspect again"');
  await wait((value) => has(value, 'Release and update to main'), 'fresh workspace inspection');
  await press('label="Release and update to main"');
  await wait((value) => has(value, 'Discard local work and update'), 'fresh discard warning');
  await press('label="Discard local work and update"');
  await wait((value) => value.nodes.some((n) => n.label?.startsWith('refreshed')), 'discard');
  assertReady('proof-unpublished', context.localRepo);
  assert.equal(fs.existsSync(localFile), false);
  await capture('native-discard-complete');
  fs.writeFileSync(
    path.join(output, 'native-recovery-proof.json'),
    JSON.stringify(
      {
        pass: true,
        bulk: 2,
        unsafeBulkPreserved: true,
        cancelPreserved: true,
        changedContentRefused: true,
        confirmedDiscardVerified: true,
      },
      null,
      2,
    ) + '\n',
  );
  await press('id="fleet-recovery-close"');
  console.log('Native fleet recovery and independent Git/status/fixture readbacks PASS');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
