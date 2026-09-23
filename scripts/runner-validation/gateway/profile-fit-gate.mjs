#!/usr/bin/env node
// Live protocol proof on a disposable gateway and automatically provisioned slots.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const gateway = process.env.FARMSLOT_GATEWAY;
const port = Number(gateway?.match(/^ws:\/\/(?:127\.0\.0\.1|localhost):(\d+)$/)?.[1]);
assert.ok(port >= 10000 && port <= 65535, 'use an isolated localhost gateway above port 10000');
const poolDir = resolve(process.env.FARMSLOT_POOL_DIR ?? '');
assert.ok(
  poolDir !== resolve('.') && existsSync(poolDir),
  'set FARMSLOT_POOL_DIR to an isolated pool',
);
assert.ok(
  poolDir.startsWith('/tmp/') ||
    poolDir.startsWith('/private/tmp/') ||
    poolDir.startsWith(`${tmpdir()}/`),
);
const cdp = fileURLToPath(new URL('../../../apps/command-center/scripts/cdp.mjs', import.meta.url));
const rpc = (method, params = {}) =>
  JSON.parse(
    execFileSync(process.execPath, [cdp, 'gateway', method, JSON.stringify(params)], {
      encoding: 'utf8',
      timeout: 35_000,
      env: { ...process.env, FARMSLOT_RPC_TIMEOUT_MS: '30000' },
    }),
  );

const suffix = `${process.pid}-${Date.now()}`;
const machine = `pr720-${suffix}`;
const repo = mkdtempSync(join(tmpdir(), 'farmslot-pr720-repo-'));
const poolFile = join(poolDir, `profile-fit-${suffix}.json`);
const withoutSim = `${machine}-1`;
const withSim = `${machine}-2`;
const slot = (id, resources) => ({ id, repo, session: id, resources });
const runs = [];
const ticketData = {
  source: 'manual',
  issueType: 'Task',
  title: 'Companion proof',
  description: 'Companion device validation',
  acceptanceCriteria: ['Companion connected'],
  affectedArea: 'companion',
  stepsToReproduce: [],
  screenshots: [],
  labels: ['companion'],
};
const request = (slotId, ticketOrPr) => ({
  project: 'farmslot-farm',
  flowType: 'fix-bug',
  ticketOrPr,
  slotId,
  mode: 'interactive',
  app: 'companion',
});
async function waitForGrade(runId, expectedDecision) {
  for (let i = 0; i < 60; i++) {
    const run = rpc('run.get', { runId }).run;
    const pending = run.decisions?.filter((entry) => !entry.resolvedAt) ?? [];
    const profileDecision = pending.find(
      (entry) => entry.type === 'engine_prepare_profile_mismatch',
    );
    const grade = run.steps?.find((step) => step.name === 'grade');
    assert.equal(run.taskFile, null, 'recipe must stop at GRADE before writing task files');
    if (expectedDecision && profileDecision) {
      assert.equal(run.status, 'blocked');
      assert.match(
        profileDecision.description,
        /requires one of: ios-sim, android-emu, android-device/,
      );
      assert.deepEqual(
        profileDecision.actions.map((action) => action.id),
        ['continue', 'abort'],
      );
      assert.deepEqual(
        pending.map((entry) => entry.type),
        ['engine_prepare_profile_mismatch'],
      );
      assert.equal(run.prepareProfile, undefined);
      return;
    }
    if (!expectedDecision && pending.length) {
      assert.deepEqual(
        pending.map((entry) => entry.type),
        ['engine_flow_type_mismatch'],
      );
      assert.equal(run.status, 'blocked');
      assert.equal(grade?.status, 'running');
      assert.equal(run.prepareProfile, undefined);
      return;
    }
    assert.notEqual(grade?.status, 'done', `GRADE completed without expected decision: ${runId}`);
    assert.notEqual(run.status, 'failed', `run failed before GRADE: ${runId}`);
    assert.notEqual(run.status, 'cancelled', `run cancelled before GRADE: ${runId}`);
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error(`run ${runId} did not reach expected GRADE state`);
}

function cleanup() {
  const cleanupErrors = [];
  for (const runId of runs) {
    try {
      const run = rpc('run.get', { runId }).run;
      if (!['done', 'failed', 'cancelled'].includes(run.status)) rpc('run.cancel', { runId });
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  rmSync(poolFile, { force: true });
  rmSync(repo, { recursive: true, force: true });
  rpc('fleet.refresh');
  if (cleanupErrors.length)
    throw new AggregateError(cleanupErrors, 'Could not cancel synthetic runs');
}

try {
  writeFileSync(
    poolFile,
    JSON.stringify({
      schema_version: 2,
      machine,
      project: 'farmslot-farm',
      platform: 'cli',
      os: process.platform === 'darwin' ? 'darwin' : 'linux',
      host: 'localhost',
      ssh_user: userInfo().username,
      slots: [slot(withoutSim, {}), slot(withSim, { 'ios-sim': { device: 'simulator' } })],
    }),
  );
  const fleet = rpc('fleet.refresh').fleet.slots;
  assert.ok(fleet.some((entry) => entry.slot === withoutSim));
  assert.ok(fleet.some((entry) => entry.slot === withSim));
  for (const [slotId, decisionExpected] of [
    [withoutSim, true],
    [withSim, false],
  ]) {
    const ticketOrPr = `FS-${Math.floor(Date.now() / 1000)}${decisionExpected ? '1' : '2'}`;
    const preview = rpc('dispatch.preview', request(slotId, ticketOrPr));
    assert.equal(preview.preview.slotId, slotId);
    assert.equal(
      preview.preview.profileFit?.suggestedPrepareProfile,
      decisionExpected ? 'sandbox-companion' : undefined,
    );
    if (decisionExpected) {
      assert.match(
        preview.preview.profileFit?.slotResourceBlocker ?? '',
        /ios-sim, android-emu, android-device/,
      );
      assert.match(preview.preview.profileFit?.rationale ?? '', /companion/i);
      assert.equal(preview.preview.profileFit?.confidence, 'high');
    }
    const { run } = rpc('run.create', {
      ...request(slotId, ticketOrPr),
      runner: 'claude',
      ticketData,
    });
    assert.ok(run?.id);
    runs.push(run.id);
    await waitForGrade(run.id, decisionExpected);
    console.log(
      `${slotId}: ${decisionExpected ? 'incompatible profile decision' : 'compatible core reached flow decision'}`,
    );
  }
} finally {
  cleanup();
}
