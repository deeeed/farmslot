import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { ROOT, shSingleQuote } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';

export const SCENARIO_ID = 'native-session-startup-close';
export const RUNNER_AGNOSTIC = true;
const exec = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function rpc(method, params = {}) {
  const { stdout } = await exec(
    process.execPath,
    [
      path.join(ROOT, 'apps/command-center/scripts/cdp.mjs'),
      'gateway',
      method,
      JSON.stringify(params),
    ],
    { cwd: ROOT, env: process.env, timeout: 45000 },
  );
  return JSON.parse(stdout);
}

function parentPid(pid) {
  return Number(
    execFileSync('ps', ['-p', String(pid), '-o', 'ppid='], { encoding: 'utf8' }).trim(),
  );
}

export async function runScenario({ outDir }) {
  assert.ok(process.env.FARMSLOT_GATEWAY, 'Select the isolated validation gateway explicitly');
  const url = new URL(process.env.FARMSLOT_GATEWAY);
  assert.ok(
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname),
    'This process ownership scenario requires a local gateway',
  );
  const gatewayPid = Number(
    fs.readFileSync(path.join(ROOT, '.runs', `gateway-${url.port}.pid`), 'utf8'),
  );
  assert.ok(Number.isSafeInteger(gatewayPid) && gatewayPid > 1);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'native-startup-close-'));
  const ready = path.join(cwd, 'ready.json');
  const release = path.join(cwd, 'release');
  const hook = path.join(cwd, 'barrier.cjs');
  execFileSync('git', ['init', '--quiet'], { cwd });
  fs.mkdirSync(path.join(cwd, '.claude'));
  fs.writeFileSync(
    hook,
    `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid,ppid:process.ppid}));const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);process.exit(0);}},20);setTimeout(()=>process.exit(1),15000);`,
  );
  fs.writeFileSync(
    path.join(cwd, '.claude/settings.json'),
    JSON.stringify({
      hooks: {
        SessionStart: [
          {
            matcher: 'startup',
            hooks: [
              {
                type: 'command',
                command: `${shSingleQuote(process.execPath)} ${shSingleQuote(hook)}`,
              },
            ],
          },
        ],
      },
    }),
  );
  const report = {
    runner: 'claude',
    gateway: process.env.FARMSLOT_GATEWAY,
    inferenceExpected: false,
    checks: [],
    pass: false,
    error: null,
  };
  let sessionId;
  let runnerPid;
  let hostPid;
  let closing;
  const outcome = rpc('native.session.create', { runner: 'claude', cwd }).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  try {
    const deadline = Date.now() + 20000;
    while (!fs.existsSync(ready) && Date.now() < deadline) await sleep(100);
    assert.ok(fs.existsSync(ready), 'Native startup hook did not reach its barrier');
    const sessions = (await rpc('native.session.list')).sessions;
    const reserved = sessions.find((session) => session.cwd === cwd);
    assert.ok(reserved);
    sessionId = reserved.id;
    assert.equal(reserved.state, 'starting');
    hostPid = reserved.hostPid;
    assert.notEqual(hostPid, gatewayPid);
    let pid = JSON.parse(fs.readFileSync(ready, 'utf8')).ppid;
    for (let depth = 0; pid > 1 && depth < 12; depth++) {
      const parent = parentPid(pid);
      if (parent === hostPid) {
        runnerPid = pid;
        break;
      }
      pid = parent;
    }
    assert.ok(runnerPid, 'Could not identify the test-owned native process');
    closing = rpc('native.session.close', { sessionId }).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    let state;
    do {
      state = (await rpc('native.session.read', { sessionId })).session.state;
      assert.notEqual(state, 'closed', 'Close released ownership before startup completed');
      if (state !== 'closing') await sleep(50);
    } while (state !== 'closing' && Date.now() < deadline);
    assert.equal(state, 'closing');
    process.kill(runnerPid, 0);
    report.checks.push({ name: 'startup-owner-remains-reserved-while-closing', pass: true });
    fs.writeFileSync(release, 'ready');
    const created = await outcome;
    const closed = await closing;
    if (created.error) throw created.error;
    if (closed.error) throw closed.error;
    assert.ok(created.value.session.nativeSessionId);
    assert.equal(closed.value.closed, true);
    assert.throws(() => process.kill(runnerPid, 0), { code: 'ESRCH' });
    const snapshot = await rpc('native.session.read', { sessionId });
    assert.equal(snapshot.session.state, 'closed');
    assert.equal(snapshot.events.filter((event) => event.type === 'session.closed').length, 1);
    assert.equal(
      snapshot.events.some((event) => event.type === 'command.accepted'),
      false,
    );
    report.checks.push({ name: 'close-terminates-startup-process-without-inference', pass: true });
    report.pass = true;
  } catch (error) {
    report.error = error.message;
  } finally {
    fs.writeFileSync(release, 'ready');
    const created = await outcome;
    if (closing) await closing;
    if (created.value) sessionId = created.value.session.id;
    if (sessionId) {
      try {
        await rpc('native.session.close', { sessionId });
      } catch (error) {
        report.pass = false;
        report.cleanupError = error.message;
      }
    }
    // A broken ownership implementation must not leave the fixture's process alive.
    if (runnerPid) {
      try {
        process.kill(runnerPid, 0);
        if (parentPid(runnerPid) === hostPid) {
          process.kill(runnerPid, 'SIGTERM');
          report.pass = false;
          report.cleanupForced = true;
        }
      } catch (error) {
        if (error.code !== 'ESRCH') {
          report.pass = false;
          report.cleanupError = error.message;
        }
      }
    }
    // Native startup-hook helpers may finish their own temporary-file cleanup just
    // after the CLI exits. Retry only this test-owned directory's removal.
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
  const outPath = writeEvidence(report, SCENARIO_ID, 'claude', outDir);
  return { scenario: SCENARIO_ID, runner: 'claude', outPath, pass: report.pass, report };
}
