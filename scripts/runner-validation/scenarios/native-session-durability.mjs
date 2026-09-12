import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ROOT, shSingleQuote } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';

export const SCENARIO_ID = 'native-session-durability';
// Staged proof: the operator owns gateway restart. This scenario never restarts a gateway.
const STAGES = [
  'start',
  'offline',
  'reconnect',
  'approval',
  'approval-offline',
  'approval-reconnect',
  'failure',
  'recover',
  'close',
  'uncertain-cleanup',
  'startup-failure',
];
function nativeStateRoot() {
  const root = process.env.FARMSLOT_NATIVE_STATE_DIR;
  assert.ok(
    root &&
      fs
        .realpathSync(root)
        .startsWith(fs.realpathSync(path.join(ROOT, 'temp', 'native-validation')) + path.sep),
  );
  return root;
}
function rpc(method, params = {}, token = process.env.FARMSLOT_GATEWAY_TOKEN) {
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
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, FARMSLOT_GATEWAY_TOKEN: token },
          timeout: 60_000,
        },
      ),
    );
  } catch (error) {
    const code = String(error.stderr ?? '').match(/"code":"([A-Z_]+)"/)?.[1];
    throw Object.assign(new Error(`Gateway ${method} failed: ${code ?? 'transport'}`), {
      rpcCode: code,
    });
  }
}
function alive(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}
function rejected(method, params, token) {
  assert.throws(
    () => rpc(method, params, token),
    (error) => Boolean(error.rpcCode),
    'Must reject through the gateway, not a transport error',
  );
}
function offline() {
  assert.throws(
    () => rpc('native.session.list'),
    (error) => !error.rpcCode,
    'Gateway is still serving RPC',
  );
}
async function wait(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, 'Durability stage timed out');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
function read(state, after = 0) {
  let page = rpc('native.session.read', { sessionId: state.session.id, after, limit: 31 });
  const events = [...page.events];
  while (page.hasMore) {
    page = rpc('native.session.read', {
      sessionId: state.session.id,
      after: page.cursor,
      limit: 31,
    });
    events.push(...page.events);
  }
  assert.deepEqual(
    events.map((event) => event.sequence),
    Array.from({ length: events.length }, (_, index) => after + index + 1),
  );
  return { ...page, events };
}
function requireNoPending(snapshot) {
  const pending = snapshot.pendingRequests[0];
  assert.ok(
    !pending,
    `Native approval/question pending for session ${snapshot.session.id}, request ${pending?.request.id}. Review it through native.session.read/respond, then rerun this stage. The scenario will not approve incidental actions.`,
  );
  return snapshot;
}
function send(state, text) {
  const command = { sessionId: state.session.id, commandId: randomUUID(), text };
  rpc('native.session.send', command);
  return command;
}
function boundedTool(state, name) {
  const helper = path.join(state.cwd, `${name}.cjs`);
  const begin = path.join(state.cwd, `${name}.begin`);
  const release = path.join(state.cwd, `${name}.release`);
  const effect = path.join(state.cwd, `${name}.effect`);
  fs.writeFileSync(
    helper,
    `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(begin)},String(process.pid));const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);fs.appendFileSync(${JSON.stringify(effect)},'once\\n');process.exit(0)}},100);setTimeout(()=>process.exit(1),180000);`,
  );
  return {
    begin,
    release,
    effect,
    command: `${shSingleQuote(process.execPath)} ${shSingleQuote(helper)}`,
  };
}
async function toolStarted(state, task, command, timeoutMs) {
  await wait(() => {
    const snapshot = read(state);
    assert.ok(
      !snapshot.events.some(
        (event) => event.commandId === command.commandId && event.type === 'turn.completed',
      ) || fs.existsSync(task.begin),
      'Native turn ended before the fixture tool started; inspect its response before submitting another task',
    );
    for (const pending of snapshot.pendingRequests) {
      assert.equal(pending.type, 'approval.requested');
      assert.equal(
        pending.request.detail,
        task.command,
        `Incidental approval pending: session ${state.session.id}, request ${pending.request.id}. Review it explicitly, then rerun this stage.`,
      );
      rpc('native.session.respond', {
        sessionId: state.session.id,
        requestId: pending.request.id,
        decision: 'approve',
      });
    }
    return (
      fs.existsSync(task.begin) &&
      snapshot.events.some(
        (event) => event.commandId === command.commandId && event.type === 'tool.started',
      )
    );
  }, timeoutMs);
}
export async function runScenario({ runnerAdapter, model, timeoutMs = 120000, outDir }) {
  const stage = process.env.FARMSLOT_NATIVE_DURABILITY_STAGE;
  const statePath = process.env.FARMSLOT_NATIVE_DURABILITY_STATE;
  const report = { runner: runnerAdapter.RUNNER_ID, stage, checks: [], pass: false, error: null };
  let state;
  try {
    assert.ok(
      STAGES.includes(stage),
      `Set FARMSLOT_NATIVE_DURABILITY_STAGE to ${STAGES.join(', ')}`,
    );
    assert.ok(
      statePath && path.isAbsolute(statePath),
      'Set an absolute private FARMSLOT_NATIVE_DURABILITY_STATE file',
    );
    const gateway = new URL(process.env.FARMSLOT_GATEWAY);
    assert.ok(
      ['localhost', '127.0.0.1'].includes(gateway.hostname) && gateway.port === '18777',
      'This destructive proof is restricted to isolated gateway18777',
    );
    if (stage === 'start') {
      if (fs.existsSync(statePath)) state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (!state) {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'native-live-durability-'));
        execFileSync('git', ['init', '--quiet'], { cwd });
        state = { cwd, runner: runnerAdapter.RUNNER_ID, token: `CONTEXT_${randomUUID()}`, model };
        state.session = rpc('native.session.create', {
          runner: state.runner,
          cwd,
          ...(model ? { model } : {}),
        }).session;
        state.task = boundedTool(state, 'continue');
        state.command = send(
          state,
          `Remember this conversation token: ${state.token}. Run exactly this bounded command once, wait for it to finish, then report its exit status: ${state.task.command}. Do not run it again.`,
        );
      }
      assert.equal(state.runner, runnerAdapter.RUNNER_ID);
      await toolStarted(state, state.task, state.command, timeoutMs);
      state.cursor = read(state).cursor;
      assert.equal(fs.existsSync(state.task.effect), false);
      report.checks.push('native tool began and remains active');
    } else {
      state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      assert.equal(state.runner, runnerAdapter.RUNNER_ID);
      if (stage === 'offline' || stage === 'approval-offline') {
        offline();
        assert.ok(alive(state.session.hostPid));
        assert.ok(alive(state.session.processPid));
        if (stage === 'offline') {
          assert.ok(alive(Number(fs.readFileSync(state.task.begin, 'utf8'))));
          fs.writeFileSync(state.task.release, 'continue');
          await wait(() => fs.existsSync(state.task.effect), timeoutMs);
          offline();
          assert.equal(fs.readFileSync(state.task.effect, 'utf8'), 'once\n');
          state.offlineProof = true;
          report.checks.push('side effect completed while gateway was stopped');
        } else {
          state.approvalOfflineProof = true;
          report.checks.push('approval owner survived gateway outage');
        }
      }
      if (stage === 'reconnect') {
        assert.equal(state.offlineProof, true);
        await wait(
          () =>
            requireNoPending(read(state)).events.some(
              (event) =>
                event.commandId === state.command.commandId &&
                event.type === 'turn.completed' &&
                event.status === 'completed',
            ),
          timeoutMs,
        );
        const replay = read(state, state.cursor);
        assert.ok(replay.events.length > 0);
        assert.equal(replay.session.hostPid, state.session.hostPid);
        assert.equal(replay.session.nativeSessionId, state.session.nativeSessionId);
        assert.equal(replay.session.generation, state.session.generation);
        assert.equal(read(state, replay.cursor).events.length, 0);
        assert.equal(rpc('native.session.send', state.command).state, 'completed');
        rejected('native.session.send', { ...state.command, text: 'changed payload' });
        assert.equal(fs.readFileSync(state.task.effect, 'utf8'), 'once\n');
        report.checks.push(
          'same running owner, ordered missing events once, retry without a second side effect',
        );
      }
      if (stage === 'approval') {
        if (!state.approvalCommand) {
          state.approvalTarget = path.join(state.cwd, '..', `native-approval-${randomUUID()}`);
          state.approvalCommand = send(
            state,
            `Use a shell command to write the word approved to ${state.approvalTarget}. Request permission if needed. Do nothing else.`,
          );
        }
        await wait(() => read(state).pendingRequests.length > 0, timeoutMs);
        state.approval = read(state).pendingRequests[0];
        assert.equal(state.approval.type, 'approval.requested');
        assert.notEqual(state.approval.request.id, state.approval.nativeId);
        report.checks.push('native permission request saved before gateway restart');
      }
      if (stage === 'approval-reconnect') {
        assert.equal(state.approvalOfflineProof, true);
        if (!state.approvalResponded) {
          const pending = read(state).pendingRequests.find(
            (event) => event.request.id === state.approval.request.id,
          );
          assert.ok(pending);
          assert.equal(pending.generation, state.session.generation);
          assert.ok(
            process.env.FARMSLOT_NATIVE_OTHER_TOKEN,
            'Supply a second authenticated principal for the cross-owner negative check',
          );
          // Establish valid credentials first so native ownership is the reason for rejection.
          rpc('principal.list', {}, process.env.FARMSLOT_NATIVE_OTHER_TOKEN);
          const response = {
            sessionId: state.session.id,
            requestId: pending.request.id,
            decision: 'deny',
          };
          rejected('native.session.respond', response, process.env.FARMSLOT_NATIVE_OTHER_TOKEN);
          rejected('native.session.respond', { ...response, requestId: pending.nativeId });
          rpc('native.session.respond', response);
          rejected('native.session.respond', response);
          state.approvalResponded = true;
        }
        await wait(() => requireNoPending(read(state)).session.state === 'idle', timeoutMs);
        assert.equal(fs.existsSync(state.approvalTarget), false);
        report.checks.push(
          'pending approval retained; cross-owner/native-ID/stale replies rejected; denial applied',
        );
      }
      if (stage === 'failure') {
        if (!state.crashCommand) {
          state.recoveryCommand = undefined;
          state.crashTask = boundedTool(state, `crash-${randomUUID()}`);
          state.crashCommand = send(
            state,
            `This is an authorized Farmslot process-lifetime test. The local fixture only writes its own PID marker, waits for a release file, and expires after three minutes. The test controller will stop the agent process to verify cleanup. Inspect the script first if needed, then run it once and wait: ${state.crashTask.command}`,
          );
        }
        await toolStarted(state, state.crashTask, state.crashCommand, timeoutMs);
        const killHost = process.env.FARMSLOT_NATIVE_KILL === 'host';
        if (killHost) {
          const active = rpc('native.session.list').sessions.filter(
            (session) => !['closed', 'failed'].includes(session.state),
          );
          assert.ok(
            active.every((session) => session.id === state.session.id),
            'Host also owns another validation session; close it before this stage',
          );
        }
        let victim = state.session.hostPid;
        if (!killHost) {
          // processPid identifies the registered wrapper. Kill its actual native binary.
          const children = execFileSync('ps', ['-axo', 'pid=,ppid='], {
            encoding: 'utf8',
            timeout: 1_000,
          })
            .trim()
            .split('\n')
            .map((line) => line.trim().split(/\s+/).map(Number))
            .filter(([, parent]) => parent === state.session.processPid);
          assert.equal(
            children.length,
            1,
            'Expected one native child under the registered wrapper',
          );
          victim = children[0][0];
        }
        if (process.env.FARMSLOT_NATIVE_TORN_JOURNAL === '1') {
          assert.ok(killHost, 'Torn journal proof requires host failure');
          const root = nativeStateRoot();
          assert.equal(
            JSON.parse(fs.readFileSync(path.join(root, 'ready.json'), 'utf8')).pid,
            victim,
          );
          process.kill(victim, 'SIGSTOP');
          fs.appendFileSync(
            path.join(root, 'sessions', `${state.session.id}.journal`),
            '{"event":',
          );
        }
        process.kill(victim, 'SIGKILL');
        await wait(
          () =>
            !alive(state.session.processPid) &&
            !alive(Number(fs.readFileSync(state.crashTask.begin, 'utf8'))),
          timeoutMs,
        );
        await wait(() => read(state).session.state === 'failed', timeoutMs);
        assert.equal(
          read(state).events.some(
            (event) =>
              event.commandId === state.crashCommand.commandId && event.type === 'turn.completed',
          ),
          false,
        );
        report.checks.push(
          `${killHost ? 'host' : 'runner'} death failed honestly and stopped its child tool`,
        );
        if (process.env.FARMSLOT_NATIVE_TORN_JOURNAL === '1')
          report.checks.push(
            'supervisor repaired an incomplete journal append before recording cleanup',
          );
      }
      if (stage === 'recover') {
        if (!state.recoveryCommand) {
          assert.equal(read(state).session.state, 'failed');
          const resumed = rpc('native.session.create', {
            runner: state.runner,
            cwd: state.cwd,
            resumeSessionId: state.session.nativeSessionId,
          }).session;
          assert.equal(resumed.id, state.session.id);
          assert.equal(resumed.nativeSessionId, state.session.nativeSessionId);
          assert.notEqual(resumed.generation, state.session.generation);
          if (state.approval)
            rejected('native.session.respond', {
              sessionId: resumed.id,
              requestId: state.approval.request.id,
              decision: 'approve',
            });
          rpc('native.session.send', state.crashCommand);
          assert.equal(fs.existsSync(state.crashTask.effect), false);
          state.session = resumed;
          state.recoveryCommand = send(
            state,
            'Reply with the exact conversation token I asked you to remember. Do not use tools or repeat any earlier command.',
          );
        }
        const command = state.recoveryCommand;
        await wait(
          () =>
            requireNoPending(read(state)).events.some(
              (event) => event.commandId === command.commandId && event.type === 'turn.completed',
            ),
          timeoutMs,
        );
        const output = read(state)
          .events.filter(
            (event) => event.commandId === command.commandId && event.type === 'text.delta',
          )
          .map((event) => event.text)
          .join('');
        assert.ok(
          output.includes(state.token),
          'Exact saved conversation context was not retained',
        );
        assert.equal(fs.readFileSync(state.task.effect, 'utf8'), 'once\n');
        assert.equal(fs.existsSync(state.crashTask.effect), false);
        state.crashCommand = undefined;
        state.recoveryCommand = undefined;
        report.checks.push(
          'explicit exact-context resume; accepted work not replayed; old decision rejected',
        );
      }
      if (stage === 'close') {
        rpc('native.session.close', { sessionId: state.session.id });
        assert.equal(read(state).session.state, 'closed');
        assert.equal(alive(state.session.processPid), false);
        report.checks.push('owned runner stopped');
      }
      if (stage === 'uncertain-cleanup') {
        // Seed an interrupted cleanup record only after actual native termination.
        // This proves the gateway's durable recovery gate, not process containment.
        const root = nativeStateRoot();
        const stopped = read(state).session;
        assert.equal(stopped.state, 'closed');
        assert.equal(stopped.processStopped, true);
        assert.equal(alive(stopped.processPid), false);
        assert.ok(
          rpc('native.session.list').sessions.every(
            (session) =>
              ['closed', 'failed'].includes(session.state) &&
              (!session.processPid || session.processStopped === true),
          ),
        );
        const stopHost = async () => {
          const host = JSON.parse(fs.readFileSync(path.join(root, 'host.json'), 'utf8'));
          const ready = JSON.parse(fs.readFileSync(path.join(root, 'ready.json'), 'utf8'));
          assert.equal(
            Number(
              execFileSync('ps', ['-p', String(ready.pid), '-o', 'ppid='], {
                encoding: 'utf8',
              }).trim(),
            ),
            host.pid,
          );
          process.kill(host.pid, 'SIGTERM');
          await wait(() => !alive(host.pid) && !alive(ready.pid), timeoutMs);
        };
        const journal = path.join(root, 'sessions', `${stopped.id}.journal`);
        const persist = (info) => {
          const fd = fs.openSync(journal, 'a');
          try {
            fs.writeFileSync(fd, JSON.stringify({ info }) + '\n');
            fs.fsyncSync(fd);
          } finally {
            fs.closeSync(fd);
          }
        };
        await stopHost();
        persist({ ...stopped, state: 'failed', processStopped: false });
        try {
          assert.equal(read(state).session.processStopped, false);
          rejected('native.session.create', {
            runner: state.runner,
            cwd: state.cwd,
            resumeSessionId: stopped.nativeSessionId,
          });
          rejected('native.session.close', { sessionId: stopped.id });
          report.checks.push(
            'unconfirmed durable cleanup rejects resume and terminal-close success even with no wrapper process',
          );
        } finally {
          await stopHost();
          persist(stopped);
        }
      }
      if (stage === 'startup-failure') {
        assert.equal(state.runner, 'claude', 'This fixture exercises native SessionStart hooks');
        const previous = read(state).session;
        assert.equal(previous.state, 'closed');
        const settings = path.join(state.cwd, '.claude', 'settings.json');
        const hook = path.join(state.cwd, 'initialization-barrier.cjs');
        const marker = path.join(state.cwd, 'initialization-barrier.pid');
        assert.equal(fs.existsSync(settings), false, 'Fixture must not replace existing settings');
        fs.mkdirSync(path.dirname(settings), { recursive: true });
        fs.writeFileSync(
          hook,
          `require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setTimeout(()=>process.exit(0),60000);`,
        );
        fs.writeFileSync(
          settings,
          JSON.stringify({
            hooks: {
              SessionStart: [
                {
                  matcher: 'resume',
                  hooks: [
                    {
                      type: 'command',
                      timeout: 90,
                      command: `${shSingleQuote(process.execPath)} ${shSingleQuote(hook)}`,
                    },
                  ],
                },
              ],
            },
          }),
        );
        try {
          rejected('native.session.create', {
            runner: state.runner,
            cwd: state.cwd,
            resumeSessionId: previous.nativeSessionId,
          });
          assert.ok(fs.existsSync(marker), 'Native resume did not enter its startup hook');
          const failed = read(state).session;
          assert.equal(failed.state, 'failed');
          assert.equal(failed.processStopped, true);
          assert.equal(alive(failed.processPid), false);
          assert.equal(alive(Number(fs.readFileSync(marker, 'utf8'))), false);
          report.checks.push(
            'native initialization timeout recorded failed state and confirmed child cleanup',
          );
        } finally {
          fs.rmSync(settings);
        }
        state.session = rpc('native.session.create', {
          runner: state.runner,
          cwd: state.cwd,
          resumeSessionId: previous.nativeSessionId,
        }).session;
        assert.equal(state.session.nativeSessionId, previous.nativeSessionId);
        assert.equal(state.session.state, 'idle');
        report.checks.push(
          'explicit retry after failed initialization resumed the same native conversation',
        );
      }
    }
    fs.writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
    report.pass = true;
  } catch (error) {
    if (state && statePath) fs.writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
    report.error = error.message;
  }
  const outPath = writeEvidence(report, `${SCENARIO_ID}-${stage}`, runnerAdapter.RUNNER_ID, outDir);
  return {
    scenario: SCENARIO_ID,
    runner: runnerAdapter.RUNNER_ID,
    outPath,
    pass: report.pass,
    report,
  };
}
