// Manual native-worker and Command Center proof. Owns every run and process it creates.
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { hostname, tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { NativeSessionReadResult, Run, WorkerSignal } from '@farmslot/protocol';
import { CredentialStoreRuntime } from '@farmslot/credential-store';
import { NativeSessionClient } from '@farmslot/agent-runtime/native';

import { matchesProcess } from '../../../packages/agent-runtime/src/native/storage.js';
import { RUNNER_OBSERVABILITY_SUPPORT_PATHS } from '../../../services/gateway/src/runners/runner-observability.js';
import { testGatewayIdentity } from '../../lib/test-gateway-identity-source.mts';
import { writeNativeFixtureTask } from '../lib/native-task.mjs';
import { proveCompanionOperatorWait } from './operator-wait-companion.mts';

const source = fileURLToPath(new URL('../../../', import.meta.url));
const temporary = mkdtempSync(path.join(tmpdir(), 'operator-wait-'));
const root = path.join(temporary, 'root');
const repo = path.join(root, 'checkout');
const nativeRoot = path.join(temporary, 'native');
const project = 'operator-wait-fixture';
const slotId = `operator-wait-${randomUUID()}`;
const out = path.resolve(
  process.env.FARMSLOT_OPERATOR_WAIT_OUT ?? 'temp/operator-wait-proof',
  randomUUID(),
);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const writeJson = (file: string, value: unknown) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
};
const checks: string[] = [];
const cleanupErrors: unknown[] = [];
let failure: unknown;
let gateway: ChildProcess | undefined;
let ui: ChildProcess | undefined;
let metro: ChildProcess | undefined;
let runId: string | undefined;
let env: NodeJS.ProcessEnv;
let logs = '';
let route: string | undefined;
const helper = (...args: string[]) => {
  const result = execFileSync(
    process.execPath,
    [path.join(source, 'apps/command-center/scripts/cdp.mjs'), ...args],
    {
      cwd: source,
      env,
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  return result.trim() ? JSON.parse(result) : null;
};
const rpc = <T,>(method: string, params: unknown): T =>
  helper('gateway', method, JSON.stringify(params));
const readRun = () => rpc<{ run: Run }>('run.get', { runId }).run;
async function waitFor<T>(
  read: () => T | Promise<T>,
  predicate: (value: T) => boolean,
  label: string,
  timeout = 120_000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    assert.ok(!gateway || gateway.exitCode === null, logs.slice(-3000));
    const value = await read();
    if (predicate(value)) return value;
    await pause(100);
  }
  throw new Error(`Timed out: ${label}`);
}
async function port() {
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}
function log(child: ChildProcess) {
  for (const stream of [child.stdout, child.stderr])
    stream?.on('data', (data) => {
      logs += String(data);
    });
}
async function stop(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await Promise.race([exited, pause(3000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await exited;
  }
}
try {
  mkdirSync(out, { recursive: true });
  mkdirSync(root);
  mkdirSync(repo);
  symlinkSync(path.join(source, 'packages'), path.join(root, 'packages'), 'dir');
  mkdirSync(path.join(root, 'scripts'));
  writeFileSync(path.join(root, 'scripts/dev.sh'), '#!/bin/sh\n');
  for (const relative of RUNNER_OBSERVABILITY_SUPPORT_PATHS) {
    if (relative.startsWith('packages/')) continue;
    const target = path.join(root, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    symlinkSync(path.join(source, relative), target);
  }
  writeFileSync(path.join(root, 'CLAUDE.md'), '# Isolated operator wait fixture\n');
  writeJson(path.join(root, 'services/gateway/package.json'), {
    name: 'fixture',
    version: '0.0.0',
  });
  execFileSync('git', ['init', '-q', '-b', 'fixture-root'], { cwd: root });
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'operator-wait-proof');
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'test: create native operator wait source',
  );
  git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD'));
  writeFileSync(path.join(repo, '.git/info/exclude'), 'tasks/\n.task/\n.omc/\n');
  const ticket = `WAIT-${Date.now()}`;
  const taskFile = path.join(root, 'projects', project, 'tasks/dev', ticket, 'TASK.md');
  await writeNativeFixtureTask(
    taskFile,
    '# Worker: dev\n\n- Task profile: dev\n\n## Checklist\n\n' +
      '- [ ] Wait for fixture-operator to approve this approach\n- [ ] Continue only when the operator asks\n\n' +
      'The exact operator name for this task is fixture-operator. Follow TASK.md when waiting for its input, then end your turn. ' +
      'Keep both checklist boxes unchecked. Do not modify source, write terminal signals, commit, publish or contact services. ' +
      'Only when the operator later asks, resume using TASK.md and end that turn.\n',
    project,
    {
      markCommand: `node '${path.join(source, 'packages/agent-runtime/scripts/mark-checklist-step.cjs')}'`,
    },
  );
  writeJson(path.join(root, 'projects', project, 'project.json'), {
    name: project,
    runtime_dir: 'tasks',
    task_dir_name: 'tasks',
    default_branch: 'main',
    hooks: {},
    review: { enabled: false },
    monitoring: {
      poll_interval_min: 1 / 60,
      stuck_timeout_min: 0.5,
      idle_timeout_min: 0.5,
      total_timeout_min: 5,
      max_nudges: 0,
    },
    vars: {
      mark_cmd: `node '${path.join(source, 'packages/agent-runtime/scripts/mark-checklist-step.cjs')}'`,
    },
  });
  const templates = path.join(root, 'projects', project, 'templates');
  mkdirSync(path.join(templates, 'worker'), { recursive: true });
  for (const name of ['dev.md', 'dev-interactive.md']) {
    writeFileSync(
      path.join(templates, 'worker', name),
      readFileSync(path.join(path.dirname(taskFile), 'CHECKLIST.md')),
    );
  }
  mkdirSync(path.join(templates, 'prompts'), { recursive: true });
  writeFileSync(
    path.join(templates, 'prompts/worker-dispatch.md'),
    'Read {{TASK_FILE}} first. Follow {{TASK_DIR}}/CHECKLIST.md and use {{TASK_DIR}}/mark.\n',
  );
  writeJson(path.join(root, 'pool/local.json'), {
    machine: hostname(),
    host: 'localhost',
    ssh_user: userInfo().username,
    os: process.platform,
    project,
    platform: 'cli',
    slots: [{ id: slotId, enabled: true, mode: 'dispatch', repo, session: slotId }],
  });
  writeJson(path.join(root, '.farm-status.json'), {
    checked_at: new Date().toISOString(),
    slots: [
      {
        slot: slotId,
        project,
        machine: hostname(),
        platform: 'cli',
        lifecycle: 'ready',
        current_run_id: null,
        slot_epoch: 1,
      },
    ],
  });
  const gatewayPort = await port();
  const uiPort = await port();
  const token = testGatewayIdentity(path.join(temporary, 'home'), `ws://127.0.0.1:${gatewayPort}`);
  const owner = new CredentialStoreRuntime({ FARMSLOT_HOME: path.join(temporary, 'home') })
    .snapshot()
    .principals.find((principal) => principal.subject.displayName === 'test-automation');
  assert.ok(owner && owner.subject.type === 'service');
  assert.ok(process.env.FARMSLOT_CDP_PORT, 'Select the owned Agent Chrome CDP port');
  env = {
    ...process.env,
    FARMSLOT_ROOT: root,
    FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
    FARMSLOT_POOL_DIR: path.join(root, 'pool'),
    FARMSLOT_RUNS_DIR: path.join(root, '.runs'),
    FARMSLOT_HOME: path.join(temporary, 'home'),
    FARMSLOT_GATEWAY_PROFILE: 'proof',
    FARMSLOT_RPC_TIMEOUT_MS: '120000',
    FARMSLOT_GATEWAY: `ws://127.0.0.1:${gatewayPort}`,
    FARMSLOT_GATEWAY_PASSWORD: '',
    GATEWAY_HOST: '127.0.0.1',
    GATEWAY_PORT: String(gatewayPort),
    FARMSLOT_UI_URL: `http://127.0.0.1:${uiPort}`,
    FARMSLOT_NATIVE_STATE_DIR: nativeRoot,
    FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID: owner.id,
    FARMSLOT_DISABLE_ORCHESTRATION: '0',
    FARMSLOT_DEMO_POOL: '0',
    TMUX: '',
    TMUX_TMPDIR: path.join(temporary, 'tmux'),
    TSX_TSCONFIG_PATH: path.join(source, 'services/gateway/tsconfig.json'),
  };
  delete env.FARMSLOT_DISABLE_RUN_ENGINE_START;
  mkdirSync(env.TMUX_TMPDIR!, { recursive: true });
  writeJson(path.join(out, 'fixture.json'), {
    root,
    nativeRoot,
    slotId,
    project,
    gatewayPort,
    uiPort,
    home: env.FARMSLOT_HOME,
  });
  const startGateway = async () => {
    gateway = spawn(process.execPath, ['--import', 'tsx', 'services/gateway/src/index.ts'], {
      cwd: source,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    log(gateway);
    await waitFor(
      async () => {
        try {
          return (await fetch(`http://127.0.0.1:${gatewayPort}/health`)).ok;
        } catch (error) {
          if (error instanceof TypeError) return false;
          throw error;
        }
      },
      Boolean,
      'private gateway',
    );
  };
  await startGateway();
  const created = rpc<{ run: Run }>('run.createNative', {
    project,
    flowType: 'dev',
    ticketOrPr: ticket,
    slotId,
    allowedSlots: [slotId],
    branch: 'operator-wait-proof',
    taskFile,
    runner: 'codex',
    mode: 'interactive',
    skipPrepare: true,
    safetyTier: 'full-auto',
  });
  runId = created.run.id;
  console.log(`Native operator-wait fixture created: ${runId}`);
  writeJson(path.join(out, 'created.json'), created);
  const waiting = await waitFor(
    readRun,
    (run) => {
      assert.ok(
        !['failed', 'cancelled', 'blocked'].includes(run.status),
        `${run.status}: ${run.error}`,
      );
      return run.waitingForOperator?.who === 'fixture-operator';
    },
    'validated worker operator wait',
  );
  const context = waiting.agentContexts?.find((item) => item.role === 'dev');
  const binding = context?.nativeSession;
  assert.ok(context && binding && binding.leaseId && binding.generation);
  const nativeTarget = {
    sessionId: binding.sessionId,
    executionNodeId: binding.executionNodeId,
    worker: {
      runId,
      contextId: context.id,
      generation: binding.generation,
      leaseId: binding.leaseId,
    },
  };
  const read = () => rpc<NativeSessionReadResult>('native.session.read', nativeTarget);
  const idle = await waitFor(
    read,
    (snapshot) => snapshot.session.state === 'idle',
    'native turn idle while waiting',
  );
  const attempt = waiting.waitingForOperator!.attemptId;
  assert.equal(idle.session.processStopped, false);
  const since = Date.parse(waiting.waitingForOperator!.since);
  const healthy = await waitFor(
    readRun,
    (run) => {
      assert.equal(run.status, 'monitoring');
      assert.equal(run.waitingForOperator?.attemptId, attempt);
      assert.equal(run.metrics.nudgeCount, 0);
      assert.equal(run.decisions.length, 0);
      return Date.now() - since >= 62_000;
    },
    'healthy wait beyond two inactivity windows',
    80_000,
  );
  writeJson(path.join(out, 'healthy-wait.json'), { run: healthy, session: idle.session });
  checks.push(
    'real mark wait remains healthy beyond two inactivity windows with a live idle worker',
  );
  ui = spawn(
    process.execPath,
    [
      path.join(source, 'node_modules/vite/bin/vite.js'),
      '--host',
      '127.0.0.1',
      '--port',
      String(uiPort),
    ],
    { cwd: path.join(source, 'apps/command-center/ui'), env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  log(ui);
  await waitFor(
    async () => {
      try {
        return (await fetch(env.FARMSLOT_UI_URL!)).ok;
      } catch (error) {
        if (error instanceof TypeError) return false;
        throw error;
      }
    },
    Boolean,
    'Command Center',
  );
  route = `run/${runId}`;
  helper('goto', route, '--new');
  helper('login', route);
  helper(
    'eval',
    route,
    "const walk = r => [...r.querySelectorAll('*')].flatMap(e => [e, ...(e.shadowRoot ? walk(e.shadowRoot) : [])]); const dismiss = walk(document).find(e => e.localName === 'button' && e.textContent.trim() === 'Got it'); if (dismiss) dismiss.click(); return true;",
  );
  const label = () =>
    helper(
      'eval',
      route!,
      "const walk = r => [...r.querySelectorAll('*')].flatMap(e => [e, ...(e.shadowRoot ? walk(e.shadowRoot) : [])]); return walk(document).some(e => e.textContent?.includes('Waiting on operator: fixture-operator'));",
    );
  await waitFor(label, Boolean, 'shared waiting label in Command Center');
  helper('screenshot', route, path.join(out, 'waiting.png'));
  checks.push('real Command Center renders the shared waiting label without state injection');
  const simulator = process.env.FARMSLOT_OPERATOR_WAIT_SIMULATOR;
  const nativeResume = simulator
    ? await proveCompanionOperatorWait({
        source,
        env,
        simulator,
        port: await port(),
        runId,
        ticket,
        token,
        out,
        waitFor,
        onProcess: (child) => {
          metro = child;
          log(child);
        },
      })
    : undefined;
  if (nativeResume) checks.push('native Companion renders the live operator dependency');
  const commandId = randomUUID();
  const target = {
    sessionId: binding.sessionId,
    executionNodeId: binding.executionNodeId,
    generation: binding.generation,
    leaseId: binding.leaseId,
  };
  await stop(gateway);
  gateway = undefined;
  const native = new NativeSessionClient(nativeRoot, binding.executionNodeId);
  await native.sendWorker(
    owner.id,
    target,
    commandId,
    'The fixture operator approves continuing. Resume according to TASK.md, then end your turn. Keep both checklist boxes unchecked and do not write terminal signals or change source.',
  );
  const resumedSession = await waitFor(
    () => native.readWorker(owner.id, binding.sessionId, binding.leaseId),
    (snapshot) =>
      snapshot.session.state === 'idle' &&
      snapshot.commands.some(
        (command) => command.commandId === commandId && command.outcome === 'completed',
      ),
    'same native worker resumes while gateway is offline',
  );
  const signalFile = path.resolve(repo, context.signalFile!);
  const resumedSignal: WorkerSignal = JSON.parse(readFileSync(signalFile, 'utf8'));
  const resumeUntil = resumedSignal.operatorWaitIntervals?.at(-1)?.until;
  assert.ok(resumeUntil && !resumedSignal.waitingForOperator);
  writeJson(path.join(out, 'offline-resume.json'), {
    signal: resumedSignal,
    session: resumedSession.session,
  });
  await startGateway();
  const resumed = await waitFor(
    readRun,
    (run) => {
      assert.ok(
        !['blocked', 'failed', 'cancelled'].includes(run.status),
        `${run.status}: ${run.error}`,
      );
      return (
        run.status === 'monitoring' &&
        !run.waitingForOperator &&
        run.monitorState?.operatorResumedAt === resumeUntil
      );
    },
    'recovered monitor restores the offline resume clock',
  );
  assert.equal(resumed.status, 'monitoring');
  assert.equal(resumedSession.session.processPid, idle.session.processPid);
  assert.equal(resumedSession.session.generation, idle.session.generation);
  assert.equal(resumedSession.session.nativeSessionId, idle.session.nativeSessionId);
  assert.equal(
    resumed.agentContexts?.find((item) => item.id === context.id)?.signalAttemptId,
    attempt,
  );
  assert.ok((resumed.monitorState?.operatorWaitMs ?? 0) >= 60_000);
  await waitFor(label, (shown) => !shown, 'waiting label clears');
  await nativeResume?.();
  writeJson(path.join(out, 'resumed.json'), { run: resumed, session: resumedSession.session });
  checks.push(
    'mark resume retains native process, session, generation and signal attempt while clearing the wait',
  );
  checks.push(
    'gateway restart restores the original offline resume time without an immediate inactivity gate',
  );
} catch (error) {
  failure = error;
} finally {
  if (runId) {
    try {
      const run = readRun();
      writeJson(path.join(out, 'final-run.json'), run);
      if (!['done', 'cancelled', 'failed'].includes(run.status)) {
        const cancelled = rpc<{ effects: Array<{ status: string }> }>('run.cancel', {
          runId,
          reason: 'Operator wait fixture cleanup',
        });
        assert.ok(cancelled.effects.every((effect) => effect.status !== 'failed'));
      } else if (run.status === 'failed') rpc('slot.release', { slotId, keepWork: true });
      const context = run.agentContexts?.find((item) => item.nativeSession);
      const binding = context?.nativeSession;
      if (context && binding) {
        const closed = rpc<NativeSessionReadResult>('native.session.read', {
          sessionId: binding.sessionId,
          executionNodeId: binding.executionNodeId,
          worker: {
            runId,
            contextId: context.id,
            generation: binding.generation,
            leaseId: binding.leaseId,
          },
        });
        assert.equal(closed.session.processStopped, true, 'fixture cleanup stops the owned worker');
        writeJson(path.join(out, 'closed-worker.json'), closed.session);
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (route) {
    try {
      helper('close', route);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  await stop(ui);
  await stop(metro);
  await stop(gateway);
  const hostFile = path.join(nativeRoot, 'host.json');
  if (existsSync(hostFile)) {
    try {
      const host = JSON.parse(readFileSync(hostFile, 'utf8'));
      if (matchesProcess(host.pid, nativeRoot)) {
        process.kill(host.pid, 'SIGTERM');
        const deadline = Date.now() + 5000;
        while (matchesProcess(host.pid, nativeRoot) && Date.now() < deadline) await pause(50);
        assert.equal(matchesProcess(host.pid, nativeRoot), false, 'owned native host stops');
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  writeFileSync(path.join(out, 'gateway.log'), logs);
  writeJson(path.join(out, 'result.json'), {
    pass: !failure && !cleanupErrors.length,
    checks,
    error: failure instanceof Error ? failure.message : failure,
    cleanupErrors: cleanupErrors.map(String),
    ...(failure || cleanupErrors.length ? { retainedFixture: temporary } : {}),
  });
  if (!failure && !cleanupErrors.length) rmSync(temporary, { recursive: true, force: true });
}
if (failure || cleanupErrors.length)
  throw new AggregateError(
    [...(failure ? [failure] : []), ...cleanupErrors],
    `Operator wait proof failed; evidence ${out}`,
  );
console.log(`Operator wait native/UI proof PASS: ${out}`);
