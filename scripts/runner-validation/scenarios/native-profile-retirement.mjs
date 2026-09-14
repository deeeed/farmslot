import assert from 'node:assert/strict';
import fs from 'node:fs';

import { Methods } from '@farmslot/protocol';

import { writeEvidence } from '../lib/evidence.mjs';

import { rpc } from './native-worker-lifecycle.mjs';
import { pinnedWorkerTarget } from './native-worker-read.mjs';

export const SCENARIO_ID = 'native-profile-retirement';
export const RUNNER_AGNOSTIC = true;

/** Retire a private configuration after its workers stop, retaining their readable history. */
export async function runScenario({ outDir }) {
  const report = { runner: 'native', checks: [], pass: false };
  let original;
  try {
    assert.equal(process.env.FARMSLOT_GATEWAY, 'ws://127.0.0.1:18777');
    const profileId = process.env.FARMSLOT_NATIVE_PROFILE_PROOF;
    const runId = process.env.FARMSLOT_NATIVE_PROFILE_HISTORY_RUN;
    assert.ok(profileId && runId);
    original = rpc(Methods.NATIVE_PROFILE_LIST).profiles.find(
      (profile) => profile.id === profileId,
    );
    assert.ok(original);
    report.original = original;
    writeEvidence(report, SCENARIO_ID, report.runner, outDir);
    const sessions = rpc(Methods.NATIVE_SESSION_LIST, { executionNodeId: 'local' }).sessions.filter(
      (session) => session.profileId === profileId,
    );
    assert.ok(
      sessions.some((session) => session.workerManaged),
      'Requires actual managed worker history',
    );
    assert.ok(
      sessions.every(
        (session) =>
          ['closed', 'failed'].includes(session.state) &&
          (!session.processPid || session.processStopped),
      ),
      'Stop profile sessions before this proof',
    );
    const run = rpc(Methods.RUN_GET, { runId }).run;
    const context = run.agentContexts.find(
      (context) => context.nativeSession?.profile?.profileId === profileId,
    );
    assert.ok(context);
    const target = pinnedWorkerTarget(runId, context.id, context.nativeSession.leaseId);
    const before = rpc(Methods.NATIVE_SESSION_READ, target);
    assert.ok(before.events.length);
    rpc(Methods.NATIVE_PROFILE_REMOVE, { profileId, accountContextId: original.accountContextId });
    assert.equal(
      rpc(Methods.NATIVE_PROFILE_LIST).profiles.some((profile) => profile.id === profileId),
      false,
    );
    assert.equal(fs.existsSync(original.directory), true);
    const after = rpc(Methods.NATIVE_SESSION_READ, target);
    assert.deepEqual(after.events, before.events);
    assert.equal(after.session.processStopped, true);
    assert.equal(after.session.accountContextId, before.session.accountContextId);
    report.checks.push(
      'Profile removal accepts stopped managed workers, retains native files and preserves readable task history',
    );
    report.pass = true;
  } catch (error) {
    report.error = error.message;
  } finally {
    if (original) {
      try {
        const current = rpc(Methods.NATIVE_PROFILE_LIST).profiles.find(
          (profile) => profile.id === original.id,
        );
        if (!current) {
          const restored = rpc(Methods.NATIVE_PROFILE_ADD, {
            profileId: original.id,
            runner: original.runner,
            directory: original.directory,
          }).profile;
          assert.notEqual(restored.accountContextId, original.accountContextId);
          report.restored = restored;
        } else if (current.state === 'retiring') {
          report.requiresRetirementRecovery = true;
          report.pass = false;
        }
      } catch (error) {
        report.cleanupError = error.message;
        report.pass = false;
      }
    }
  }
  const outPath = writeEvidence(report, SCENARIO_ID, report.runner, outDir);
  return { scenario: SCENARIO_ID, runner: report.runner, pass: report.pass, report, outPath };
}
