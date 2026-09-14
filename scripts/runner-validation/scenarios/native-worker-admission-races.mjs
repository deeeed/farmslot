import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';

import { rpc, wait } from './native-worker-lifecycle.mjs';
import { pinnedWorkerTarget } from './native-worker-read.mjs';

export const SCENARIO_ID = 'native-worker-admission-races';
const privateRoot = path.join(ROOT, 'temp/native-validation') + path.sep;
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

function request(method, params) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [
        path.join(ROOT, 'apps/command-center/scripts/cdp.mjs'),
        'gateway',
        method,
        JSON.stringify(params),
      ],
      {
        cwd: ROOT,
        env: { ...process.env, FARMSLOT_RPC_TIMEOUT_MS: '120000' },
        timeout: 125000,
      },
      (error, stdout, stderr) =>
        resolve(error ? { error: String(stderr || error.message) } : { value: JSON.parse(stdout) }),
    );
  });
}

function armFault(binding, extra) {
  const fault = process.env.FARMSLOT_NATIVE_RESUME_REPLY_FAULT;
  assert.ok(fault && path.resolve(fault).startsWith(privateRoot));
  assert.equal(fs.existsSync(fault), false, 'Use a fresh private fault path');
  const pids = execFileSync('lsof', ['-t', '-nP', '-iTCP:18777', '-sTCP:LISTEN'], {
    encoding: 'utf8',
  })
    .trim()
    .split(/\s+/)
    .map(Number);
  assert.equal(pids.length, 1);
  assert.ok(fs.existsSync(`${fault}.${pids[0]}.loaded`));
  fs.writeFileSync(
    fault,
    JSON.stringify({ gatewayPid: pids[0], sessionId: binding.sessionId, ...extra }),
    { mode: 0o600 },
  );
  return fault;
}

/** A real paused/stopped worker whose resume RPC loses its successful reply. */
export async function verifyLostResumePrepare({ runId, context, binding, cwd, slotId, outDir }) {
  const fault = armFault(binding, { method: 'native.worker.resume', mode: 'fail-applied-reply' });
  const marker = path.join(cwd, `prepare-must-preserve-${randomUUID()}`);
  fs.writeFileSync(marker, 'uncommitted worker progress\n');
  try {
    assert.throws(() => rpc('run.resume', { runId }), /Private validation deferred native request/);
    const applied = JSON.parse(fs.readFileSync(`${fault}.applied`, 'utf8'));
    assert.equal(applied.error, undefined);
    assert.equal(applied.processStopped, false);
    assert.notEqual(applied.generation, binding.generation);
    const held = rpc('run.get', { runId }).run.agentContexts.find(
      (c) => c.id === context.id,
    ).nativeSession;
    assert.ok(held.closedAt, 'Must cover the durable stale close timestamp');
    assert.ok(held.recovery?.requestedAt);
    let prepareError;
    let prepared;
    try {
      prepared = rpc('slot.prepare', { slotId, runId }).prepared;
    } catch (error) {
      prepareError = error.message;
    }
    const progressPreserved =
      fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') === 'uncommitted worker progress\n';
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(
      path.join(outDir, 'lost-resume-prepare-observation.json'),
      JSON.stringify(
        {
          runId,
          applied,
          closedAt: held.closedAt,
          recoveryRequestedAt: held.recovery.requestedAt,
          prepareError,
          prepared,
          progressPreserved,
        },
        null,
        2,
      ) + '\n',
    );
    assert.match(
      prepareError ?? '',
      /Stop the owned native worker/,
      'Same-run prepare must refuse an uncertain resumed worker',
    );
    assert.equal(progressPreserved, true, 'Refused preparation must preserve workspace progress');
    assert.equal(
      rpc('run.get', { runId }).run.agentContexts.find((c) => c.id === context.id).nativeSession
        .generation,
      binding.generation,
    );
  } finally {
    fs.writeFileSync(`${fault}.release`, '', { mode: 0o600 });
  }
}

/** Hold recovery's real snapshot read, replay through RPC, then release the stale read. */
export async function verifySupersededRecovery({ runId, context, binding, outDir }) {
  const fault = armFault(binding, { method: 'read', limit: 1 });
  const old = rpc('run.get', { runId }).run;
  const before = rpc('native.session.read', pinnedWorkerTarget(runId, context.id, binding.leaseId));
  const recovering = request('run.resume', { runId });
  try {
    await wait(() => fs.existsSync(`${fault}.applied`), Boolean, 20000);
    rpc('run.replayStep', { runId, stepName: 'monitor' });
    const replayed = rpc('run.get', { runId }).run;
    assert.ok((replayed.engineState?.generation ?? 0) > (old.engineState?.generation ?? 0));
    fs.writeFileSync(`${fault}.release`, '', { mode: 0o600 });
    const result = await recovering;
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(
      path.join(outDir, 'superseded-recovery-observation.json'),
      JSON.stringify(
        {
          runId,
          beforeGeneration: old.engineState?.generation ?? 0,
          replayedGeneration: replayed.engineState?.generation ?? 0,
          resumeSucceeded: Boolean(result.value),
          resumeError: result.error,
        },
        null,
        2,
      ) + '\n',
    );
    assert.match(result.error ?? '', /Native worker recovery ownership changed/);
    const read = rpc('native.session.read', pinnedWorkerTarget(runId, context.id, binding.leaseId));
    assert.equal(read.session.generation, binding.generation);
    assert.equal(read.session.processStopped, true);
    assert.deepEqual(
      read.commands,
      before.commands,
      'Superseded recovery must not create commands',
    );
    const current = rpc('run.get', { runId }).run.agentContexts.find(
      (c) => c.id === context.id,
    ).nativeSession;
    assert.equal(current.recovery, undefined);
    assert.equal(current.generation, binding.generation);
  } finally {
    fs.writeFileSync(`${fault}.release`, '', { mode: 0o600 });
    await recovering;
  }
}

/** Prepare's real project preflight keeps admission held while Resume is attempted. */
export async function verifyPrepareBeforeRecovery({
  runId,
  context,
  binding,
  slotId,
  project,
  timeoutMs,
  outDir,
}) {
  const projectPath = path.join(privateRoot, 'projects', project, 'project.json');
  assert.ok(fs.realpathSync(projectPath).startsWith(privateRoot));
  const original = fs.readFileSync(projectPath, 'utf8');
  const config = JSON.parse(original);
  const checkpoint = path.join(privateRoot, `prepare-admission-${randomUUID()}`);
  const fixture = path.join(ROOT, 'scripts/runner-validation/fixtures/native-prepare-delay.mjs');
  const profile = 'native-recovery-admission-proof';
  fs.writeFileSync(
    projectPath,
    JSON.stringify(
      {
        ...config,
        prepare: {
          ...config.prepare,
          profiles: {
            ...config.prepare?.profiles,
            [profile]: {
              phases: ['preflight'],
              hooks: { preflight: `node ${quote(fixture)} ${quote(checkpoint)}` },
            },
          },
        },
      },
      null,
      2,
    ),
  );
  // Dispatch/prepare share loadProjectVars' five-second cache; let the prior
  // fixture configuration expire before selecting the newly written profile.
  await new Promise((resolve) => setTimeout(resolve, 5100));
  const preparing = request('slot.prepare', { slotId, runId, prepareProfile: profile });
  try {
    await wait(() => fs.existsSync(`${checkpoint}.ready`), Boolean, timeoutMs);
    const resuming = await request('run.resume', { runId });
    const current = rpc('run.get', { runId }).run.agentContexts.find((c) => c.id === context.id);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(
      path.join(outDir, 'prepare-before-recovery-observation.json'),
      JSON.stringify(
        {
          runId,
          preparationHeld: !fs.existsSync(`${checkpoint}.release`),
          resumeSucceeded: Boolean(resuming.value),
          resumeError: resuming.error,
          nativeGenerationBefore: binding.generation,
          nativeGenerationAfter: current?.nativeSession?.generation,
        },
        null,
        2,
      ) + '\n',
    );
    assert.match(
      resuming.error ?? '',
      /is preparing; native worker recovery is unavailable/,
      'Recovery must refuse an admitted preparation',
    );
    const read = rpc('native.session.read', pinnedWorkerTarget(runId, context.id, binding.leaseId));
    assert.equal(read.session.generation, binding.generation);
    assert.equal(read.session.processStopped, true);
    assert.equal(
      rpc('run.get', { runId }).run.agentContexts.find((c) => c.id === context.id).nativeSession
        .recovery,
      undefined,
    );
  } finally {
    fs.writeFileSync(`${checkpoint}.release`, '', { mode: 0o600 });
    const result = await preparing;
    fs.writeFileSync(projectPath, original);
    assert.equal(result.error, undefined, result.error);
    assert.equal(result.value.prepared, true);
  }
}

/** Requires an existing private idle worker. Stops it using ordinary run controls. */
export async function runScenario({ runnerAdapter, via, timeoutMs, outDir }) {
  const report = { runner: runnerAdapter.RUNNER_ID, checks: [], pass: false, error: null };
  const runId = process.env.FARMSLOT_NATIVE_ADMISSION_RUN_ID;
  let ownsCleanup = false;
  try {
    assert.equal(process.env.FARMSLOT_GATEWAY, 'ws://127.0.0.1:18777');
    assert.ok(runId, 'Provide FARMSLOT_NATIVE_ADMISSION_RUN_ID for an idle private fixture worker');
    const run = rpc('run.get', { runId }).run;
    const context = run.agentContexts.find((c) => c.nativeSession && !c.nativeSession.releasedAt);
    assert.ok(context);
    const binding = context.nativeSession;
    const target = pinnedWorkerTarget(runId, context.id, binding.leaseId);
    const before = rpc('native.session.read', target);
    assert.ok(before.session.cwd.startsWith(privateRoot));
    assert.equal(before.session.state, 'idle');
    ownsCleanup = true;
    rpc('run.pause', { runId });
    rpc('native.session.close', target);
    const input = {
      runId,
      context,
      binding,
      cwd: before.session.cwd,
      slotId: run.slotId,
      project: run.project,
      timeoutMs,
      outDir,
    };
    if (via === 'lost-resume-prepare') await verifyLostResumePrepare(input);
    else if (via === 'superseded-recovery') await verifySupersededRecovery(input);
    else if (via === 'prepare-before-recovery') await verifyPrepareBeforeRecovery(input);
    else
      throw new Error('Choose lost-resume-prepare, superseded-recovery or prepare-before-recovery');
    report.checks.push(via);
    report.pass = true;
  } catch (error) {
    report.error = error.message;
  } finally {
    if (ownsCleanup) {
      try {
        const result = rpc('run.cancel', {
          runId,
          reason: 'Native admission race validation complete',
        });
        assert.ok(result.effects.every((effect) => effect.status !== 'failed'));
      } catch (error) {
        report.pass = false;
        report.error = `${report.error ?? ''}; cleanup: ${error.message}`;
      }
    }
  }
  const outPath = writeEvidence(report, SCENARIO_ID, report.runner, outDir);
  return { scenario: SCENARIO_ID, runner: report.runner, pass: report.pass, outPath, report };
}
