import assert from 'node:assert/strict';

import { NATIVE_PROFILE_METHODS } from '@farmslot/agent-runtime/native/profile-service';
import { Methods } from '@farmslot/protocol';

import { writeEvidence } from '../lib/evidence.mjs';

import { rpc, wait } from './native-worker-lifecycle.mjs';

export const SCENARIO_ID = 'native-profile-node-compatibility';
export const RUNNER_AGNOSTIC = true;

/** An older real node must retain ordinary sessions and refuse profile operations. */
export async function runScenario({ outDir, timeoutMs = 30000 }) {
  const report = { runner: 'native', checks: [], pass: false };
  try {
    assert.equal(process.env.FARMSLOT_GATEWAY, 'ws://127.0.0.1:18777');
    const executionNodeId = process.env.FARMSLOT_NATIVE_LEGACY_NODE;
    assert.ok(executionNodeId && executionNodeId !== 'local');
    const catalog = await wait(
      () => rpc(Methods.NATIVE_SESSION_CATALOG),
      (result) => result.contexts.some((context) => context.executionNodeId === executionNodeId),
      timeoutMs,
    );
    const contexts = catalog.contexts.filter(
      (context) => context.executionNodeId === executionNodeId,
    );
    assert.ok(
      contexts.length && contexts.every((context) => !context.supportsProfiles),
      'Requires an owned node that does not yet advertise native profiles',
    );
    const params = { executionNodeId };
    const before = rpc(Methods.NATIVE_SESSION_LIST, params);
    for (const method of NATIVE_PROFILE_METHODS) {
      assert.throws(
        () => rpc(method, params),
        /Execution node upgrade required for native account profiles/,
        `${method} did not enforce the shared profile capability`,
      );
    }
    const after = rpc(Methods.NATIVE_SESSION_LIST, params);
    assert.deepEqual(
      after.sessions.map((session) => session.id),
      before.sessions.map((session) => session.id),
    );
    report.executionNodeId = executionNodeId;
    report.methods = NATIVE_PROFILE_METHODS;
    report.checks.push(
      'Every profile method refuses an older node; ordinary session inventory remains available and unchanged',
    );
    report.pass = true;
  } catch (error) {
    report.error = error.message;
  }
  const outPath = writeEvidence(report, SCENARIO_ID, report.runner, outDir);
  return { scenario: SCENARIO_ID, runner: report.runner, pass: report.pass, report, outPath };
}
