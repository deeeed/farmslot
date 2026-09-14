import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { Methods } from '@farmslot/protocol';

import { ROOT } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';

import { rpc } from './native-worker-lifecycle.mjs';

export const SCENARIO_ID = 'native-session-cleanup-confirmation';

function groupAbsent(pid) {
  try {
    process.kill(-pid, 0);
    return false;
  } catch (error) {
    if (error.code === 'ESRCH') return true;
    throw error;
  }
}

/** Real native startup/close, including a caller-injected shutdown-observation fault. */
export async function runScenario({ runnerAdapter, outDir }) {
  const report = { runner: runnerAdapter.RUNNER_ID, checks: [], pass: false };
  let session;
  try {
    assert.equal(process.env.FARMSLOT_GATEWAY, 'ws://127.0.0.1:18777');
    const marker = process.env.FARMSLOT_NATIVE_CLEANUP_CONFIRMATION_MARKER;
    if (marker) {
      assert.ok(
        path.resolve(marker).startsWith(path.join(ROOT, 'temp/native-validation') + path.sep),
      );
      assert.equal(fs.existsSync(marker), false, 'Use a fresh shutdown observation marker');
    }
    session = rpc(Methods.NATIVE_SESSION_CREATE, { runner: report.runner, cwd: ROOT }).session;
    report.sessionId = session.id;
    report.processPid = session.processPid;
    writeEvidence(report, SCENARIO_ID, report.runner, outDir);
    rpc(Methods.NATIVE_SESSION_CLOSE, { sessionId: session.id });
    const stopped = rpc(Methods.NATIVE_SESSION_READ, { sessionId: session.id }).session;
    assert.equal(stopped.processStopped, true);
    assert.equal(stopped.state, 'closed');
    assert.equal(
      groupAbsent(session.processPid),
      true,
      'Gateway reported cleanup while the native group remained',
    );
    if (marker) {
      assert.deepEqual(JSON.parse(fs.readFileSync(marker, 'utf8')), {
        hostPid: session.hostPid,
        processPid: session.processPid,
      });
      report.checks.push('Shutdown fault actually reached the native host and exact child');
    }
    report.checks.push('Real native close reports stopped only after OS process-group absence');
    report.pass = true;
  } catch (error) {
    report.error = error.message;
    if (session) {
      report.groupAbsent = groupAbsent(session.processPid);
      const state = rpc(Methods.NATIVE_SESSION_READ, { sessionId: session.id }).session;
      report.reportedStopped = state.processStopped;
      report.requiresCleanupConfirmation = !state.processStopped;
    }
  }
  const outPath = writeEvidence(report, SCENARIO_ID, report.runner, outDir);
  return { scenario: SCENARIO_ID, runner: report.runner, pass: report.pass, report, outPath };
}
