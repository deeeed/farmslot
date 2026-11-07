import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { writeEvidence } from '../lib/evidence.mjs';

export const SCENARIO_ID = 'copilot-runtime-smoke';

function rpc(method, params = {}) {
  const stdout = execFileSync(
    process.execPath,
    [
      path.resolve('apps/command-center/scripts/cdp.mjs'),
      'gateway',
      method,
      JSON.stringify(params),
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        FARMSLOT_RPC_TIMEOUT_MS: process.env.FARMSLOT_RPC_TIMEOUT_MS ?? '60000',
      },
    },
  );
  return JSON.parse(stdout);
}

async function waitForIdle(target, commandId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const page = rpc('native.session.read', { ...target, limit: 500 });
    const command = commandId
      ? page.commands.find((row) => row.commandId === commandId)
      : undefined;
    if (
      page.session.state === 'failed' ||
      command?.state === 'failed' ||
      command?.state === 'unknown'
    )
      throw new Error(page.session.error ?? command?.reason ?? 'Native command failed');
    if (page.session.state === 'idle' && (!commandId || command?.state === 'completed'))
      return page;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for the native Co-Pilot receipt');
}

export async function runScenario({
  runnerAdapter,
  timeoutMs,
  outDir,
  via,
  resumeExisting = false,
}) {
  const runner = runnerAdapter.RUNNER_ID;
  const report = { runner, pass: false, error: null };
  try {
    if (via === 'model-effort')
      assert.equal(
        process.env.FARMSLOT_GATEWAY,
        'ws://127.0.0.1:18777',
        'Model/effort validation requires the private gateway',
      );
    const before = rpc('operator.snapshot');
    if (!resumeExisting) {
      rpc('copilot.stop', { reason: 'runner-validation-reset' });
      report.configured = rpc('copilot.configure', {
        runner,
        ...(via === 'model-effort' ? { model: 'gpt-6-astra', effort: 'low' } : {}),
      });
    }
    report.start = rpc(
      'copilot.start',
      resumeExisting ? { mode: 'reconnect' } : { safetyTier: 'sandboxed' },
    );
    const target = report.start.session.nativeSession;
    assert.ok(target, 'The Co-Pilot must bind its configured native singleton');
    const bootstrap = await waitForIdle(target, undefined, timeoutMs);
    assert.equal(bootstrap.session.runner, runner);
    if (via === 'model-effort') {
      assert.equal(bootstrap.session.model, 'gpt-6-astra');
      assert.equal(bootstrap.session.effort, 'low');
      assert.throws(
        () => rpc('copilot.configure', { effort: 'medium' }),
        /Stop the Co-Pilot runtime/,
      );
    }
    const commandId = randomUUID();
    report.send = rpc('native.session.send', {
      ...target,
      commandId,
      text: 'Acknowledge the isolated Co-Pilot runtime smoke once. Do not call tools or change farm state.',
    });
    const completed = await waitForIdle(target, commandId, timeoutMs);
    assert(
      completed.events.some(
        (event) => event.type === 'text.delta' && event.commandId === commandId,
      ),
    );
    report.reconnect = rpc('copilot.start', { mode: 'reconnect' });
    assert.equal(report.reconnect.reused, true);
    assert.equal(report.reconnect.session.runtimeId, report.start.session.runtimeId);
    assert.deepEqual(report.reconnect.session.nativeSession, target);
    report.stop = rpc('copilot.stop', { reason: 'runner-validation-complete' });
    assert.equal(report.stop.session.status, 'stopped');
    const after = rpc('operator.snapshot');
    for (const field of ['totalSlots', 'activeRuns', 'queuedItems'])
      assert.equal(after.counts[field], before.counts[field], field + ' changed');
    report.pass = true;
  } catch (error) {
    report.error = error?.message || String(error);
  }
  const outPath = writeEvidence(report, SCENARIO_ID, runner, outDir);
  return { scenario: SCENARIO_ID, runner, outPath, pass: report.pass, report };
}
