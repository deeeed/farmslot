import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { ROOT } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';

export const SCENARIO_ID = 'native-process-census';
const execute = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}
async function rpc(method, params = {}) {
  try {
    const { stdout } = await execute(
      process.execPath,
      [
        path.join(ROOT, 'apps/command-center/scripts/cdp.mjs'),
        'gateway',
        method,
        JSON.stringify(params),
      ],
      { cwd: ROOT, env: process.env, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
    );
    return JSON.parse(stdout);
  } catch (error) {
    throw Object.assign(new Error(`Gateway ${method} failed`), {
      rpcCode: String(error.stderr ?? '').match(/"code":"([A-Z_]+)"/)?.[1],
    });
  }
}
async function wait(predicate, label, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await sleep(100);
  }
  throw new Error(`Timed out: ${label}`);
}

// Requires a dedicated gateway and the native-census-fault preload. No operator state.
export async function runScenario({
  runnerAdapter,
  outDir,
  model,
  timeoutMs = 120_000,
  via = 'sharing',
}) {
  assert.ok(['sharing', 'transient', 'persistent', 'deadline'].includes(via));
  assert.equal(process.env.FARMSLOT_GATEWAY, 'ws://127.0.0.1:19787');
  const root = fs.realpathSync(process.env.FARMSLOT_NATIVE_STATE_DIR);
  const fault = path.resolve(process.env.FARMSLOT_NATIVE_CENSUS_FAULT);
  const privatePrefix = fs.realpathSync(path.join(ROOT, 'temp/native-validation')) + path.sep;
  assert.ok(root.startsWith(privatePrefix) && fault.startsWith(privatePrefix));
  assert.equal(fs.existsSync(fault), false, 'Previous fault must be disarmed');
  for (const suffix of ['.fired', '.observed']) fs.rmSync(fault + suffix, { force: true });
  const cwd = fs.mkdtempSync(path.join(path.dirname(root), `census-${via}-`));
  await execute('git', ['init', '--quiet'], { cwd });
  const trace = path.join(cwd, 'scans.jsonl');
  const report = {
    runner: runnerAdapter.RUNNER_ID,
    via,
    cwd,
    checks: [],
    measurements: {},
    pass: false,
    error: null,
  };
  const sessions = [];
  const configure = (extra = {}) =>
    fs.writeFileSync(
      fault,
      JSON.stringify({ root, roles: ['supervisor', 'host'], trace, ...extra }),
      { mode: 0o600 },
    );
  const scans = () =>
    fs.existsSync(trace)
      ? fs
          .readFileSync(trace, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  const create = async () => {
    const { session } = await rpc('native.session.create', {
      runner: report.runner,
      cwd,
      ...(model ? { model } : {}),
    });
    sessions.push(session);
    return session;
  };
  let detached;
  let supervisor;
  try {
    const victim = await create();
    supervisor = JSON.parse(fs.readFileSync(path.join(root, 'host.json'), 'utf8')).pid;
    assert.ok(fs.existsSync(`${fault}.${supervisor}.loaded`));
    assert.ok(fs.existsSync(`${fault}.${victim.hostPid}.loaded`));
    configure();
    if (via === 'sharing') {
      const count = async () => {
        const start = Date.now();
        await sleep(2200);
        const end = Date.now();
        return scans().filter(
          (scan) =>
            scan.pid === victim.hostPid &&
            scan.kind === 'async-start' &&
            scan.at >= start &&
            scan.at <= end,
        ).length;
      };
      const one = await count();
      await create();
      await create();
      const three = await count();
      report.measurements.scansPer2200ms = { oneSession: one, threeSessions: three };
      assert.ok(one >= 1 && three >= 1, 'Census telemetry did not observe live scans');
      let active = 0;
      let completedAt;
      for (const entry of scans().filter((entry) => entry.pid === victim.hostPid)) {
        if (entry.kind === 'async-start') {
          assert.equal(active, 0, 'Multiple native sessions launched overlapping census scans');
          if (completedAt !== undefined)
            assert.ok(
              entry.at - completedAt >= 90,
              'Census started before the shared completion interval',
            );
          active++;
        } else if (entry.kind === 'async-finish') {
          active--;
          completedAt = entry.at;
        }
      }
      configure({ delayMs: 2000 });
      const delayStart = Date.now();
      const scan = await wait(
        () =>
          scans().find(
            (entry) =>
              entry.pid === victim.hostPid && entry.kind === 'async-start' && entry.at > delayStart,
          ),
        'delayed scan starts',
      );
      const started = Date.now();
      const snapshot = await rpc('native.session.read', { sessionId: victim.id });
      const readMs = Date.now() - started;
      assert.equal(snapshot.session.id, victim.id);
      assert.ok(readMs < 1800, `Async census blocked gateway read for ${readMs}ms`);
      const finishes = scans().filter(
        (entry) =>
          entry.pid === victim.hostPid && entry.kind === 'async-finish' && entry.at > scan.at,
      );
      assert.equal(
        finishes.length,
        0,
        'Read must finish while the census callback remains pending',
      );
      report.measurements.delayedCensusReadMs = readMs;
      const delayedFinish = await wait(
        () =>
          scans().find(
            (entry) =>
              entry.pid === victim.hostPid &&
              entry.kind === 'async-finish' &&
              entry.at >= scan.at + 1900,
          ),
        'delayed census completes',
      );
      assert.equal(
        scans().filter(
          (entry) =>
            entry.pid === victim.hostPid &&
            entry.kind === 'async-start' &&
            entry.at > scan.at &&
            entry.at < delayedFinish.at,
        ).length,
        0,
        'Census scans overlapped',
      );
      const nextScan = await wait(
        () =>
          scans().find(
            (entry) =>
              entry.pid === victim.hostPid &&
              entry.kind === 'async-start' &&
              entry.at > delayedFinish.at,
          ),
        'next census starts',
      );
      assert.ok(
        nextScan.at - delayedFinish.at >= 90,
        'Census cadence did not wait after completion',
      );
      report.measurements.censusCompletionGapMs = nextScan.at - delayedFinish.at;
      configure();
      report.checks.push(
        'one shared periodic census for three live native sessions; gateway read finishes during a delayed census',
      );
    }
    const pidFile = path.join(cwd, 'descendant.json');
    const effectFile = path.join(cwd, 'late-effect');
    const fixture = path.join(cwd, 'spawn-descendant.cjs');
    fs.writeFileSync(
      fixture,
      `const fs=require('node:fs'), cp=require('node:child_process');\nconst child=cp.spawn(process.execPath,['-e',${JSON.stringify(`setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(effectFile)},'unexpected'),30000);`)}],{detached:true,stdio:'ignore'});\nfs.writeFileSync(${JSON.stringify(pidFile)},JSON.stringify({pid:child.pid,parent:process.pid,at:Date.now()}));child.unref();setTimeout(()=>{},45000);\n`,
    );
    const commandId = randomUUID();
    await rpc('native.session.send', {
      sessionId: victim.id,
      commandId,
      text: `Use the shell tool to run exactly: node ${JSON.stringify(fixture)}. Wait for it. This is a disposable local process cleanup fixture; do not edit files, retry, or run other commands.`,
    });
    const answered = new Set();
    await wait(
      async () => {
        const snapshot = await rpc('native.session.read', { sessionId: victim.id });
        for (const event of snapshot.events) {
          if (event.type !== 'approval.requested' || answered.has(event.request.id)) continue;
          assert.ok(JSON.stringify(event.data).includes(fixture), 'Unexpected approval target');
          await rpc('native.session.respond', {
            sessionId: victim.id,
            requestId: event.request.id,
            decision: 'approve',
          });
          answered.add(event.request.id);
        }
        assert.notEqual(snapshot.session.state, 'failed', 'Runner failed before cleanup fixture');
        return fs.existsSync(pidFile);
      },
      'native runner starts detached descendant',
      timeoutMs,
    );
    detached = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
    configure({ roles: ['supervisor'], observePid: detached.pid });
    await wait(() => fs.existsSync(`${fault}.observed`), 'detached descendant observed');
    const { stdout: processMetadata } = await execute('ps', [
      '-p',
      String(detached.pid),
      '-o',
      'pid=,ppid=,pgid=,lstart=',
    ]);
    detached.identity = processMetadata.trim().split(/\s+/).slice(3).join(' ');
    assert.equal(
      Number(processMetadata.trim().split(/\s+/)[2]),
      detached.pid,
      'Fixture is not a detached group',
    );
    report.measurements.detached = detached;
    const started = Date.now();
    if (via === 'sharing') {
      await rpc('native.session.close', { sessionId: victim.id });
      await wait(
        () => !alive(victim.processPid) && !alive(detached.pid),
        'closed runner and detached descendant exit',
        15_000,
      );
      const closed = await rpc('native.session.read', { sessionId: victim.id });
      assert.equal(closed.session.processStopped, true);
      assert.ok(alive(victim.hostPid), 'Closing one session stopped the host');
      report.measurements.closeMs = Date.now() - started;
      assert.ok(report.measurements.closeMs < 12_000, 'Close exceeded the native cleanup budget');
    } else {
      configure({
        roles: ['supervisor'],
        armed: via !== 'deadline',
        persistent: via === 'persistent',
        ignoreTermination: via === 'deadline',
      });
      if (via === 'deadline') {
        await wait(
          () => !fs.existsSync(path.join(root, 'ready.json')),
          'census deadline withdraws readiness',
          8000,
        );
        report.measurements.readinessWithdrawMs = Date.now() - started;
      }
      await wait(
        () => fs.existsSync(`${fault}.fired`) && !alive(supervisor) && !alive(victim.hostPid),
        'census failure stops supervisor and host',
        20_000,
      );
      const cleanup = JSON.parse(fs.readFileSync(path.join(root, 'cleanup.json'), 'utf8'));
      report.measurements.cleanup = cleanup;
      if (via === 'transient' || via === 'deadline') {
        assert.equal(cleanup.state, 'complete');
        await wait(
          () => !alive(victim.processPid) && !alive(detached.pid),
          'transient failure cleans detached descendant',
          10_000,
        );
        const recovered = await rpc('native.session.read', { sessionId: victim.id });
        assert.equal(recovered.session.state, 'failed');
        assert.equal(recovered.session.processStopped, true);
        report.checks.push(
          'transient census failure stops the host, confirms cleanup and recovers the saved session as failed',
        );
        assert.ok(
          !recovered.events.some(
            (event) =>
              event.commandId === commandId &&
              event.type === 'turn.completed' &&
              event.status === 'completed',
          ),
        );
      } else {
        assert.equal(cleanup.state, 'unknown');
        await assert.rejects(create, (error) => error.rpcCode === 'NATIVE_SESSION_ERROR');
        report.checks.push(
          'persistent census failure records unknown cleanup and refuses replacement ownership',
        );
      }
      report.measurements.faultStopMs = Date.now() - started;
    }
    if (via !== 'persistent') {
      await sleep(Math.max(0, detached.at + 31000 - Date.now()));
      assert.equal(fs.existsSync(effectFile), false, 'Detached descendant performed a late write');
      report.checks.push(
        'real native shell launches detached child; cleanup stops root and detached child before its delayed file write',
      );
    }
    report.pass = true;
  } catch (error) {
    report.error = error.message;
  } finally {
    if (fs.existsSync(fault)) fs.rmSync(fault);
    if (via === 'deadline' && fs.existsSync(`${fault}.fired`)) {
      const injected = JSON.parse(fs.readFileSync(`${fault}.fired`, 'utf8'));
      if (injected.censusPid && alive(injected.censusPid)) {
        const { stdout } = await execute('ps', [
          '-p',
          String(injected.censusPid),
          '-o',
          'command=',
        ]);
        assert.ok(stdout.includes('census-timeout-fixture') && stdout.includes(fault));
        process.kill(injected.censusPid, 'SIGKILL');
        await wait(() => !alive(injected.censusPid), 'private census fixture teardown', 10_000);
      }
    }
    // Persistent failure deliberately blocks automatic ownership recovery. Clean only
    // the exact private detached fixture, after checking its recorded start identity.
    if (detached && alive(detached.pid)) {
      const { stdout } = await execute('ps', ['-p', String(detached.pid), '-o', 'lstart=']);
      assert.equal(stdout.trim().replace(/\s+/g, ' '), detached.identity);
      process.kill(detached.pid, 'SIGKILL');
      await wait(() => !alive(detached.pid), 'private detached fixture teardown', 10_000);
    }
    if (via === 'persistent' && sessions.length) {
      const cleanup = JSON.parse(fs.readFileSync(path.join(root, 'cleanup.json'), 'utf8'));
      assert.equal(cleanup.hostPid, sessions[0].hostPid);
      report.manualCleanupPids = [];
      for (const identity of [...(cleanup.observedProcesses ?? [])].reverse()) {
        if (!alive(identity.pid)) continue;
        const { stdout } = await execute('ps', ['-p', String(identity.pid), '-o', 'lstart=']);
        if (stdout.trim().replace(/\s+/g, ' ') !== identity.identity.trim().replace(/\s+/g, ' '))
          continue;
        process.kill(identity.pid, 'SIGKILL');
        await wait(() => !alive(identity.pid), 'recorded private process teardown', 10_000);
        report.manualCleanupPids.push(identity.pid);
      }
    }
    if (via !== 'persistent') {
      const cleanupErrors = [];
      for (const session of sessions) {
        try {
          await rpc('native.session.close', { sessionId: session.id });
        } catch (error) {
          cleanupErrors.push({
            sessionId: session.id,
            error: error.message,
            rpcCode: error.rpcCode,
          });
        }
      }
      if (cleanupErrors.length) {
        report.pass = false;
        report.cleanupErrors = cleanupErrors;
      }
    }
  }
  const outPath = writeEvidence(report, `${SCENARIO_ID}-${via}`, report.runner, outDir);
  return { scenario: SCENARIO_ID, runner: report.runner, outPath, pass: report.pass, report };
}
