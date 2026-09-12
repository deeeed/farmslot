import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';

export const SCENARIO_ID = 'native-session-cleanup-isolation';

function rpc(method, params = {}) {
  try {
    return JSON.parse(
      execFileSync(
        process.execPath,
        [
          path.join(ROOT, 'apps/command-center/scripts/cdp.mjs'),
          'gateway',
          method,
          JSON.stringify(params),
        ],
        {
          cwd: ROOT,
          env: process.env,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 60_000,
        },
      ),
    );
  } catch (error) {
    throw Object.assign(new Error(`Gateway ${method} failed`), {
      rpcCode: String(error.stderr ?? '').match(/"code":"([A-Z_]+)"/)?.[1],
    });
  }
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}
async function wait(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'Cleanup isolation timed out');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export async function runScenario({ runnerAdapter, outDir, timeoutMs = 120000 }) {
  const report = { runner: runnerAdapter.RUNNER_ID, checks: [], pass: false, error: null };
  const sessions = [];
  let root;
  let config;
  try {
    assert.equal(process.env.FARMSLOT_GATEWAY, 'ws://127.0.0.1:18777');
    root = fs.realpathSync(process.env.FARMSLOT_NATIVE_STATE_DIR);
    config = process.env.FARMSLOT_NATIVE_SIGNAL_FAULT;
    const validation = fs.realpathSync(path.join(ROOT, 'temp', 'native-validation')) + path.sep;
    assert.ok(root.startsWith(validation) && path.resolve(config).startsWith(validation));
    assert.equal(fs.existsSync(config), false, 'Use a new private fault file');
    assert.ok(
      rpc('native.session.list').sessions.every(
        (session) =>
          ['closed', 'failed'].includes(session.state) &&
          (!session.processPid || session.processStopped),
      ),
    );
    const cwd = fs.mkdtempSync(path.join(path.dirname(root), 'cleanup-isolation-'));
    execFileSync('git', ['init', '--quiet'], { cwd });
    for (let i = 0; i < 2; i++)
      sessions.push(rpc('native.session.create', { runner: report.runner, cwd }).session);
    const [victim, sibling] = sessions;
    assert.equal(victim.hostPid, sibling.hostPid);
    assert.ok(
      fs.existsSync(`${config}.${victim.hostPid}.loaded`),
      'Native host did not load the validation-only signal injector',
    );
    fs.writeFileSync(
      config,
      JSON.stringify({ hostPid: victim.hostPid, processPid: victim.processPid }),
      { mode: 0o600 },
    );
    assert.throws(
      () => rpc('native.session.close', { sessionId: victim.id }),
      (error) => error.rpcCode === 'NATIVE_SESSION_ERROR',
    );
    assert.ok(fs.existsSync(`${config}.fired`), 'Injected fault was not exercised');
    const failed = rpc('native.session.read', { sessionId: victim.id }).session;
    assert.equal(failed.state, 'failed');
    assert.equal(failed.processStopped, false);
    assert.ok(alive(victim.hostPid), 'Cleanup error stopped the shared host');
    assert.throws(
      () =>
        rpc('native.session.create', {
          runner: report.runner,
          cwd,
          resumeSessionId: victim.nativeSessionId,
        }),
      (error) => error.rpcCode === 'NATIVE_SESSION_ERROR',
    );
    report.checks.push(
      'signal failure stayed within its session, recorded uncertainty and blocked recovery',
    );
    const commandId = randomUUID();
    rpc('native.session.send', {
      sessionId: sibling.id,
      commandId,
      text: 'Reply exactly SIBLING_ALIVE. Do not use tools.',
    });
    await wait(() => {
      const snapshot = rpc('native.session.read', { sessionId: sibling.id });
      assert.equal(
        snapshot.pendingRequests.length,
        0,
        'Inspect unexpected sibling request explicitly',
      );
      return snapshot.events.some(
        (event) =>
          event.commandId === commandId &&
          event.type === 'turn.completed' &&
          event.status === 'completed',
      );
    }, timeoutMs);
    assert.equal(
      rpc('native.session.read', { sessionId: sibling.id }).session.hostPid,
      victim.hostPid,
    );
    rpc('native.session.close', { sessionId: sibling.id });
    report.checks.push('concurrent sibling completed a real native turn on the original host');
    report.pass = true;
  } catch (error) {
    report.error = error.message;
  } finally {
    if (config && fs.existsSync(config)) fs.rmSync(config);
    // The fixture exclusively owns these sessions. The supervisor performs final cleanup.
    if (root && sessions.length) {
      const host = JSON.parse(fs.readFileSync(path.join(root, 'host.json'), 'utf8'));
      const ready = JSON.parse(fs.readFileSync(path.join(root, 'ready.json'), 'utf8'));
      assert.equal(ready.pid, sessions[0].hostPid);
      process.kill(host.pid, 'SIGTERM');
      await wait(() => !alive(host.pid) && !alive(ready.pid), timeoutMs);
      for (const session of sessions) assert.equal(alive(session.processPid), false);
    }
  }
  const outPath = writeEvidence(report, SCENARIO_ID, report.runner, outDir);
  return { scenario: SCENARIO_ID, runner: report.runner, outPath, pass: report.pass, report };
}
