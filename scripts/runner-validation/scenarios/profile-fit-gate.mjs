#!/usr/bin/env node
// Live protocol proof against a disposable gateway with a synthetic CLI slot.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const gateway = process.env.FARMSLOT_GATEWAY;
const slotId = process.env.FARMSLOT_PROFILE_FIT_TEST_SLOT;
assert.match(gateway ?? '', /^ws:\/\/(?:127\.0\.0\.1|localhost):\d+$/);
assert.match(slotId ?? '', /^pr720-test-\d+$/);
const cdp = fileURLToPath(new URL('../../../apps/command-center/scripts/cdp.mjs', import.meta.url));
const rpc = (method, params = {}) =>
  JSON.parse(
    execFileSync(process.execPath, [cdp, 'gateway', method, JSON.stringify(params)], {
      encoding: 'utf8',
      timeout: 35_000,
      env: { ...process.env, FARMSLOT_RPC_TIMEOUT_MS: '30000' },
    }),
  );

const slot = rpc('fleet.status').fleet.slots.find((entry) => entry.slot === slotId);
assert.equal(slot?.project, 'farmslot-farm');
assert.equal(slot.platform, 'cli');
assert.ok(!['ios-sim', 'android-emu', 'android-device'].some((id) => slot.resources?.[id]));

const ticketOrPr = `FS-${Math.floor(Date.now() / 1000)}`;
const ticketData = {
  source: 'manual',
  title: 'Companion proof',
  description: 'Companion device validation',
  acceptanceCriteria: ['Companion connected'],
  affectedArea: 'companion',
  stepsToReproduce: [],
  screenshots: [],
  labels: ['companion'],
};
const preview = rpc('dispatch.preview', {
  project: 'farmslot-farm',
  flowType: 'fix-bug',
  ticketOrPr,
  slotId,
  mode: 'interactive',
  app: 'companion',
});
assert.equal(preview.preview.slotId, slotId);
assert.equal(preview.preview.profileFit?.suggestedPrepareProfile, 'sandbox-companion');
console.log('preview warns before dispatch');

const { run } = rpc('run.create', {
  project: 'farmslot-farm',
  flowType: 'fix-bug',
  ticketOrPr,
  slotId,
  mode: 'interactive',
  app: 'companion',
  runner: 'claude',
  ticketData,
});
assert.ok(run?.id);
for (let i = 0; i < 40; i++) {
  const current = rpc('run.get', { runId: run.id }).run;
  const decision = current.decisions?.find(
    (entry) => entry.type === 'engine_prepare_profile_mismatch',
  );
  if (decision) {
    assert.equal(current.status, 'blocked');
    assert.match(decision.description, /requires one of: ios-sim, android-emu, android-device/);
    assert.deepEqual(
      decision.actions.map((action) => action.id),
      ['continue', 'abort'],
    );
    assert.equal(current.prepareProfile, undefined);
    console.log(`GRADE blocked run ${run.id} with incompatible-slot advice`);
    rpc('run.resolveDecision', { runId: run.id, decisionId: decision.id, actionId: 'abort' });
    process.exit(0);
  }
  assert.notEqual(current.status, 'failed', `run failed before GRADE: ${run.id}`);
  await new Promise((resolve) => setTimeout(resolve, 250));
}
throw new Error(`run ${run.id} did not reach prepare_profile_mismatch`);
