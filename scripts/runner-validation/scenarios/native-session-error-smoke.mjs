import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { ROOT } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';

export const SCENARIO_ID = 'native-session-error-smoke';

/** Uses an explicitly configured failing native account; never modifies authentication. */
export async function runScenario({ runnerAdapter, outDir, timeoutMs = 30000 }) {
  const executionNodeId = process.env.FARMSLOT_NATIVE_EXECUTION_NODE ?? 'local';
  const runner = runnerAdapter.RUNNER_ID;
  const report = { runner, executionNodeId, checks: [], pass: false };
  let session;
  const rpc = (method, params = {}) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [
          path.join(ROOT, 'apps/command-center/scripts/cdp.mjs'),
          'gateway',
          method,
          JSON.stringify({ ...params, executionNodeId }),
        ],
        {
          cwd: ROOT,
          env: process.env,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 60000,
        },
      ),
    );
  try {
    assert.equal(process.env.FARMSLOT_GATEWAY, 'ws://127.0.0.1:18777');
    const cwd = process.env.FARMSLOT_NATIVE_ERROR_CWD;
    const expected = process.env.FARMSLOT_NATIVE_EXPECT_ERROR;
    assert.ok(cwd && expected, 'Supply a disposable cwd and expected native error text');
    session = rpc('native.session.create', { runner, cwd }).session;
    report.sessionId = session.id;
    const commandId = randomUUID();
    rpc('native.session.send', {
      sessionId: session.id,
      commandId,
      text: 'Reply briefly. Do not use tools.',
    });
    let page;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      page = rpc('native.session.read', { sessionId: session.id });
      if (
        page.events.some(
          (event) => event.commandId === commandId && event.type === 'turn.completed',
        )
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    assert.equal(page.session.executionNodeId, executionNodeId);
    const events = page.events.filter((event) => event.commandId === commandId);
    assert.equal(events.find((event) => event.type === 'turn.completed')?.status, 'failed');
    // The native result supplies failure state; this assertion checks its diagnostic is visible.
    assert.ok(
      events.some((event) => event.type === 'error' && event.text?.includes(expected)),
      'Failed native turn omitted its diagnostic',
    );
    report.checks.push({ name: 'native-failure-preserves-user-visible-diagnostic', pass: true });
    report.pass = true;
  } catch (error) {
    report.error = error.stderr
      ? 'Gateway request failed; inspect isolated gateway logs'
      : error.message;
  } finally {
    if (session) {
      try {
        rpc('native.session.close', { sessionId: session.id });
      } catch {
        report.pass = false;
        report.cleanupError = 'Failed to close the validation session';
      }
    }
  }
  const outPath = writeEvidence(report, SCENARIO_ID, runner, outDir);
  return { scenario: SCENARIO_ID, runner, outPath, pass: report.pass, report };
}
