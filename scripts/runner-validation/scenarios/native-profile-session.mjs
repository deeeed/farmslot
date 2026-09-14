import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { Methods, NativeSessionEventTypes } from '@farmslot/protocol';

import { ROOT } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';

import { rpc, wait } from './native-worker-lifecycle.mjs';

export const SCENARIO_ID = 'native-profile-session';

export async function runScenario({
  outDir,
  timeoutMs = 120000,
  executionNodeId = 'local',
  cwd: requestedCwd,
  runnerAdapter,
  model,
}) {
  const runner = runnerAdapter?.RUNNER_ID ?? 'claude';
  const report = { runner, checks: [], pass: false };
  let sessionId;
  const call = (method, params = {}) => rpc(method, { executionNodeId, ...params });
  try {
    assert.equal(process.env.FARMSLOT_GATEWAY, 'ws://127.0.0.1:18777');
    const profileId = process.env.FARMSLOT_NATIVE_PROFILE_PROOF;
    const otherId = process.env.FARMSLOT_NATIVE_PROFILE_OTHER;
    assert.ok(profileId && otherId && profileId !== otherId);
    const profile = call(Methods.NATIVE_PROFILE_STATUS, { profileId });
    const other = call(Methods.NATIVE_PROFILE_STATUS, { profileId: otherId });
    assert.equal(
      profile.account.login,
      'authenticated',
      'Selected native directory lost its existing login',
    );
    assert.equal(profile.profile.runner, runner);
    assert.equal(other.profile.runner, profile.profile.runner);
    assert.notEqual(other.profile.directory, profile.profile.directory);
    assert.equal(other.account.login, 'signed-out', 'Empty profile inherited an account');
    assert.ok(
      executionNodeId === 'local' || requestedCwd,
      'Remote profile proof needs its prepared workspace',
    );
    const cwd =
      requestedCwd ?? path.join(ROOT, 'temp/native-validation/native-profile-conversation');
    if (executionNodeId === 'local') fs.mkdirSync(cwd, { recursive: true });
    const params = {
      sessionId: randomUUID(),
      runner,
      model,
      cwd,
      profileId,
      accountContextId: profile.profile.accountContextId,
    };
    const created = call(Methods.NATIVE_SESSION_ENSURE, params).session;
    sessionId = created.id;
    report.sessionId = sessionId;
    assert.equal(created.profileId, profileId);
    assert.equal(created.accountContextId, profile.profile.accountContextId);
    assert.throws(
      () =>
        call(Methods.NATIVE_SESSION_ENSURE, {
          ...params,
          profileId: otherId,
          accountContextId: other.profile.accountContextId,
        }),
      /profileId|account/,
    );
    const read = () => call(Methods.NATIVE_SESSION_READ, { sessionId });
    assert.equal(read().session.generation, created.generation);
    const token = `PROFILE_${randomUUID().replaceAll('-', '')}`;
    const turn = async (text) => {
      const commandId = randomUUID();
      call(Methods.NATIVE_SESSION_SEND, { sessionId, commandId, text });
      const page = await wait(
        read,
        (state) => {
          const command = state.commands.find((command) => command.commandId === commandId);
          const error = state.events.findLast(
            (event) =>
              event.commandId === commandId && event.type === NativeSessionEventTypes.ERROR,
          );
          assert.notEqual(
            command?.outcome,
            'failed',
            error?.text ?? 'Native profile command failed',
          );
          return (
            state.session.state === 'idle' && command?.accepted && command.outcome === 'completed'
          );
        },
        timeoutMs,
      );
      return page.events
        .filter(
          (event) =>
            event.commandId === commandId && event.type === NativeSessionEventTypes.TEXT_DELTA,
        )
        .map((event) => event.text ?? '')
        .join('');
    };
    assert.ok(
      (
        await turn(
          `Remember ${token} for this conversation. Reply with exactly that token; use no tools.`,
        )
      ).includes(token),
    );
    call(Methods.NATIVE_SESSION_CLOSE, { sessionId });
    assert.equal(read().session.processStopped, true);
    const resume = {
      runner,
      model,
      cwd,
      profileId,
      accountContextId: profile.profile.accountContextId,
      resumeSessionId: created.nativeSessionId,
    };
    assert.throws(
      () =>
        call(Methods.NATIVE_SESSION_CREATE, {
          ...resume,
          profileId: otherId,
          accountContextId: other.profile.accountContextId,
        }),
      /account execution context/,
    );
    const resumed = call(Methods.NATIVE_SESSION_CREATE, resume).session;
    assert.equal(resumed.id, sessionId);
    assert.equal(resumed.accountContextId, created.accountContextId);
    assert.notEqual(resumed.generation, created.generation);
    assert.ok(
      (await turn('Reply with only the token you remembered earlier. Use no tools.')).includes(
        token,
      ),
    );
    report.checks.push(
      'named profile inference and saved memory; wrong-profile ensure/resume refused',
    );
    call(Methods.NATIVE_PROFILE_REMOVE, {
      profileId,
      accountContextId: profile.profile.accountContextId,
    });
    assert.equal(read().session.processStopped, true);
    if (executionNodeId === 'local') assert.equal(fs.existsSync(profile.profile.directory), true);
    const fresh = call(Methods.NATIVE_PROFILE_ADD, {
      profileId,
      runner,
      directory: profile.profile.directory,
    }).profile;
    assert.notEqual(fresh.accountContextId, profile.profile.accountContextId);
    assert.equal(
      call(Methods.NATIVE_PROFILE_STATUS, { profileId }).account.login,
      'authenticated',
      'Metadata retirement must preserve the native directory and login',
    );
    assert.throws(
      () => call(Methods.NATIVE_SESSION_ENSURE, { ...params, sessionId: randomUUID() }),
      /profile changed/,
    );
    assert.throws(
      () => call(Methods.NATIVE_SESSION_CREATE, resume),
      /profile changed|account execution context/,
    );
    assert.throws(
      () =>
        call(Methods.NATIVE_SESSION_SEND, {
          sessionId,
          commandId: randomUUID(),
          text: 'Old profile binding must not send',
        }),
      /profile changed/,
    );
    assert.equal(read().session.accountContextId, profile.profile.accountContextId);
    report.checks.push(
      'retirement confirms process stop; reused label cannot revive old account binding; history remains readable',
    );
    report.pass = true;
  } catch (error) {
    report.error = error.message;
  } finally {
    if (sessionId) {
      try {
        call(Methods.NATIVE_SESSION_CLOSE, { sessionId });
        assert.equal(call(Methods.NATIVE_SESSION_READ, { sessionId }).session.processStopped, true);
      } catch (error) {
        report.pass = false;
        report.cleanupError = error.message;
      }
    }
  }
  const outPath = writeEvidence(report, SCENARIO_ID, report.runner, outDir);
  return { scenario: SCENARIO_ID, runner: report.runner, pass: report.pass, report, outPath };
}
