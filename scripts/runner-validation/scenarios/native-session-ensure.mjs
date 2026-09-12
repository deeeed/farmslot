import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { ROOT } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';

export const SCENARIO_ID = 'native-session-ensure';
const exec = promisify(execFile);

async function rpc(method, params = {}, token = process.env.FARMSLOT_GATEWAY_TOKEN) {
  const executionNodeId = process.env.FARMSLOT_NATIVE_EXECUTION_NODE ?? 'local';
  try {
    const { stdout } = await exec(
      process.execPath,
      [
        path.join(ROOT, 'apps/command-center/scripts/cdp.mjs'),
        'gateway',
        method,
        JSON.stringify(
          method.startsWith('native.session.') ? { ...params, executionNodeId } : params,
        ),
      ],
      { cwd: ROOT, timeout: 70000, env: { ...process.env, FARMSLOT_GATEWAY_TOKEN: token } },
    );
    return JSON.parse(stdout);
  } catch (error) {
    // Only a structured gateway refusal can prove a negative control.
    const response = String(error.stderr ?? '')
      .split('\n')
      .find((line) => line.includes('"ok":false'));
    if (!response) throw new Error(`${method}: transport failed without a gateway refusal`);
    const failure = JSON.parse(response.slice(response.indexOf('{'))).error;
    throw Object.assign(new Error(failure.message), { rpcCode: failure.code });
  }
}

async function refused(params, expected, token) {
  await assert.rejects(rpc('native.session.ensure', params, token), (error) => {
    assert.ok(error.rpcCode, 'Transport failure is not refusal evidence');
    assert.match(error.message, expected);
    return true;
  });
}

function identity(session) {
  return Object.fromEntries(
    [
      'id',
      'generation',
      'nativeSessionId',
      'hostPid',
      'processPid',
      'ownerPrincipalId',
      'executionNodeId',
      'cwd',
      'runner',
      'model',
      'mode',
    ]
      .filter((key) => session[key] !== undefined)
      .map((key) => [key, session[key]]),
  );
}

function gatewayPid() {
  const url = new URL(process.env.FARMSLOT_GATEWAY);
  assert.ok(
    ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname),
    'Use a local validation gateway',
  );
  const pids = execFileSync('lsof', ['-t', '-nP', `-iTCP:${url.port}`, '-sTCP:LISTEN'], {
    encoding: 'utf8',
  })
    .trim()
    .split('\n');
  assert.equal(pids.length, 1);
  const pid = Number(pids[0]);
  assert.equal(
    pid,
    Number(fs.readFileSync(path.join(ROOT, '.runs', `gateway-${url.port}.pid`), 'utf8')),
  );
  return pid;
}

// Run checkpoint, restart the isolated gateway, run replay, then close and reload.
// The caller owns service restarts; this scenario never kills a host or an operator process.
export async function runScenario({ runnerAdapter, outDir, model }) {
  const runner = runnerAdapter.RUNNER_ID;
  const stage = process.env.FARMSLOT_NATIVE_ENSURE_STAGE;
  const executionNodeId = process.env.FARMSLOT_NATIVE_EXECUTION_NODE ?? 'local';
  const report = {
    runner,
    stage,
    executionNodeId,
    inferenceExpected: false,
    checks: [],
    pass: false,
  };
  let params;
  let removeFixture = false;
  try {
    assert.ok(process.env.FARMSLOT_GATEWAY, 'Select an isolated validation gateway');
    report.gatewayPid = gatewayPid();
    assert.ok(
      [
        'old-host',
        'old-node',
        'resume-diagnostic',
        'persistence',
        'checkpoint',
        'replay',
        'close',
        'reload',
        'failed',
      ].includes(stage),
    );
    const statePath = path.resolve(process.env.FARMSLOT_NATIVE_ENSURE_STATE ?? '');
    assert.ok(
      statePath.startsWith(path.join(ROOT, 'temp/native-validation/')),
      'Select a private validation state file',
    );
    if (
      ['old-host', 'old-node', 'resume-diagnostic', 'persistence', 'checkpoint'].includes(stage)
    ) {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'farmslot-native-ensure-'));
      execFileSync('git', ['init', '--quiet'], { cwd });
      params = { sessionId: randomUUID(), runner, cwd, ...(model ? { model } : {}) };
      if (stage === 'resume-diagnostic') {
        for (const resumeSessionId of ['', null])
          await refused({ ...params, resumeSessionId }, /not for resume/);
        assert.equal(
          (await rpc('native.session.list')).sessions.some((item) => item.cwd === cwd),
          false,
        );
        report.checks.push('malformed-resume-mixing-is-explained-without-launch');
        removeFixture = true;
      } else if (stage === 'persistence') {
        assert.equal(executionNodeId, 'local');
        const hostRoot = path.resolve(process.env.FARMSLOT_NATIVE_ENSURE_HOST_STATE ?? '');
        assert.ok(
          hostRoot.startsWith(path.join(ROOT, 'temp/native-validation/')),
          'Select the private host state directory',
        );
        await rpc('native.session.list');
        const journal = path.join(hostRoot, 'sessions', `${params.sessionId}.journal`);
        fs.mkdirSync(journal);
        try {
          await refused(params, /EISDIR/);
        } finally {
          fs.rmdirSync(journal);
        }
        await refused(params, /EISDIR/);
        const read = await rpc('native.session.read', { sessionId: params.sessionId });
        assert.equal(read.session.state, 'failed');
        assert.equal(read.session.processPid, undefined);
        assert.equal(read.session.nativeSessionId, '');
        assert.equal(fs.existsSync(journal), false);
        assert.equal(
          read.events.some((event) => event.type === 'command.accepted'),
          false,
        );
        report.checks.push(
          'failed-initial-persistence-remains-an-error-after-path-repair-without-launch',
        );
        removeFixture = true;
      } else if (stage !== 'checkpoint') {
        removeFixture = true;
        const before = (await rpc('native.session.list')).sessions.map(identity);
        await refused(
          params,
          stage === 'old-host'
            ? /Native host upgrade required/
            : /Native execution node upgrade required/,
        );
        assert.deepEqual((await rpc('native.session.list')).sessions.map(identity), before);
        report.checks.push(`${stage}-refuses-without-creating-and-ordinary-inventory-survives`);
      } else {
        // Separate connections exercise concurrent creates through the actual service/IPC path.
        const results = await Promise.allSettled(
          Array.from({ length: 4 }, () => rpc('native.session.ensure', params)),
        );
        for (const result of results)
          assert.equal(result.status, 'fulfilled', result.reason?.message);
        const session = results[0].value.session;
        assert.equal(session.id, params.sessionId);
        assert.equal(session.state, 'idle');
        assert.ok(session.nativeSessionId);
        assert.ok(session.processPid > 1);
        for (const result of results)
          assert.deepEqual(identity(result.value.session), identity(session));
        const matches = (await rpc('native.session.list')).sessions.filter(
          (item) => item.cwd === params.cwd,
        );
        assert.equal(matches.length, 1, 'Concurrent retries launched duplicate sessions');
        report.checks.push('concurrent-ensure-returns-one-process-and-generation');
        await refused({ ...params, sessionId: params.sessionId.toUpperCase() }, /lowercase UUID/);
        await refused(
          { ...params, cwd: path.dirname(params.cwd) },
          /launch configuration differs: cwd/,
        );
        await refused({ ...params, mode: 'plan' }, /launch configuration differs: mode/);
        for (const resumeSessionId of [session.nativeSessionId, '', null])
          await refused({ ...params, resumeSessionId }, /not for resume/);
        const other = process.env.FARMSLOT_NATIVE_OTHER_TOKEN;
        assert.ok(
          other && other !== process.env.FARMSLOT_GATEWAY_TOKEN,
          'A second authenticated admin is required',
        );
        await rpc('principal.list', {}, other);
        await refused(params, /owner|profile|principal/i, other);
        assert.deepEqual(
          identity((await rpc('native.session.ensure', params)).session),
          identity(session),
        );
        report.checks.push(
          'invalid-reservations-and-other-owner-refused-with-original-process-intact',
        );
        const { events } = await rpc('native.session.read', { sessionId: session.id });
        assert.equal(
          events.some((event) => event.type === 'command.accepted'),
          false,
        );
        fs.writeFileSync(
          statePath,
          JSON.stringify({
            params,
            session: identity(session),
            executionNodeId,
            gatewayPid: report.gatewayPid,
          }),
          { mode: 0o600 },
        );
        report.session = identity(session);
      }
    } else {
      const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      assert.equal(saved.executionNodeId, executionNodeId);
      assert.equal(saved.params.runner, runner);
      params = saved.params;
      if (stage === 'replay')
        assert.notEqual(
          report.gatewayPid,
          saved.gatewayPid,
          'Restart the validation gateway before replay',
        );
      if (stage === 'reload' || stage === 'failed') {
        const hostRoot = path.resolve(process.env.FARMSLOT_NATIVE_ENSURE_HOST_STATE ?? '');
        assert.ok(
          hostRoot.startsWith(path.join(ROOT, 'temp/native-validation/')),
          'Select the private host state directory',
        );
        const { pid } = JSON.parse(fs.readFileSync(path.join(hostRoot, 'worker.json'), 'utf8'));
        assert.notEqual(
          pid,
          saved.session.hostPid,
          'Restart the closed validation host before reload',
        );
        process.kill(pid, 0);
        report.reloadedHostPid = pid;
      }
      if (stage === 'close') {
        const closed = await rpc('native.session.close', { sessionId: params.sessionId });
        assert.equal(closed.closed, true);
      }
      const { session } = await rpc('native.session.ensure', params);
      assert.deepEqual(identity(session), saved.session);
      assert.equal(
        session.state,
        stage === 'replay' ? 'idle' : stage === 'failed' ? 'failed' : 'closed',
      );
      const read = await rpc('native.session.read', { sessionId: params.sessionId });
      assert.equal(
        read.events.some((event) => event.type === 'command.accepted'),
        false,
      );
      if (stage !== 'replay') {
        assert.equal(session.processStopped, true);
        assert.equal(read.events.filter((event) => event.type === 'session.closed').length, 1);
      }
      report.checks.push(
        stage === 'replay'
          ? 'retry-preserves-live-session-after-gateway-restart'
          : `${session.state}-reservation-never-relaunches`,
      );
      report.session = identity(session);
      removeFixture = stage === 'reload' || stage === 'failed';
    }
    report.pass = true;
  } catch (error) {
    report.error = error.message;
  } finally {
    if (params && (!report.pass || removeFixture)) {
      try {
        // Find every session from this unique fixture, including a broken reservation's random ID.
        const owned = (await rpc('native.session.list')).sessions.filter(
          (item) => item.cwd === params.cwd,
        );
        for (const session of owned) await rpc('native.session.close', { sessionId: session.id });
        fs.rmSync(params.cwd, { recursive: true, force: true });
      } catch (error) {
        report.pass = false;
        report.cleanupError = error.message;
      }
    }
  }
  const outPath = writeEvidence(
    report,
    `${SCENARIO_ID}-${stage}-${params?.sessionId ?? 'invalid'}`,
    runner,
    outDir,
  );
  return { scenario: SCENARIO_ID, runner, outPath, pass: report.pass, report };
}
