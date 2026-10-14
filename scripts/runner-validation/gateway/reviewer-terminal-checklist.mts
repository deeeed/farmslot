import { testGatewayIdentity } from '../../lib/test-gateway-identity.mjs';
// Manual proof against an existing tmux server. Never starts or kills the server.
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
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

import type { ReadyGatePayload, Run } from '@farmslot/protocol';

const scenario = process.env.FARMSLOT_TERMINAL_PROOF_SCENARIO ?? 'completion';
assert.ok(['completion', 'runner-exit'].includes(scenario), 'known terminal proof scenario');
const source = fileURLToPath(new URL('../../../', import.meta.url));
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const json = (file: string, value: unknown) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};

if (process.argv[2] === 'serve') {
  const [out, runId] = process.argv.slice(3);
  await import('../../../services/gateway/src/index.js');
  const { getRun } = await import('../../../services/gateway/src/runs/store.js');
  const { broadcastEvent } = await import('../../../services/gateway/src/server.js');
  const { createEngineDecision, setEngineDecisionRuntime } =
    await import('../../../services/gateway/src/run-engine/engine-decisions.js');
  const { executePublishGateReviewPlan } =
    await import('../../../services/gateway/src/run-engine/ready-gate.js');
  const deadline = Date.now() + 15_000;
  while (!getRun(runId)) {
    assert.ok(Date.now() < deadline, 'persisted proof run loads');
    await pause(20);
  }
  setEngineDecisionRuntime({
    broadcast: broadcastEvent,
    stepToStatus: { human_gate: 'human-gating' },
  });
  const payload: ReadyGatePayload = {
    kind: 'ready',
    repo: null,
    prNumber: null,
    branch: 'review-control',
    workerReport: 'Reviewer terminal control',
    diffStat: { files: 1, additions: 1, deletions: 0 },
  };
  assert.equal(
    await createEngineDecision(
      runId,
      'human_gate',
      'Request reviewer terminal control.',
      [{ id: 'request-review', label: 'Review', style: 'secondary' }],
      payload,
    ),
    'request-review',
  );
  try {
    const result = await executePublishGateReviewPlan(
      runId,
      getRun(runId)!.slotId!,
      [{ runner: 'claude', model: 'sonnet', effort: null, mode: 'cold' }],
      'dispatch',
    );
    json(path.join(out, 'review-finished.json'), { result, run: getRun(runId) });
  } catch (error) {
    if (scenario !== 'runner-exit') throw error;
    json(path.join(out, 'review-exited.json'), {
      error: error instanceof Error ? { name: error.name, message: error.message } : error,
      run: getRun(runId),
    });
  }
} else {
  execFileSync('tmux', ['-N', 'has-session']);
  const temporary = mkdtempSync(path.join(tmpdir(), 'review-terminal-proof-'));
  const root = path.join(temporary, 'root');
  const repo = path.join(root, 'checkout');
  const project = 'review-terminal-proof';
  const runId = randomUUID();
  const slotId = `terminal-${runId}`;
  const session = `proof-terminal-${runId}`;
  const out = path.resolve(
    process.env.FARMSLOT_TERMINAL_PROOF_OUT ?? 'temp/reviewer-terminal',
    randomUUID(),
  );
  let gateway: ChildProcess | undefined;
  let sessionCreated = false;
  const logs: string[] = [];
  let env = { ...process.env };
  const hostPath = path.join(temporary, 'proof-harness.mts');
  const host = (...args: string[]) =>
    execFileSync(process.execPath, ['--import', 'tsx', hostPath, ...args], {
      cwd: source,
      env: { ...env, TSX_TSCONFIG_PATH: path.join(source, 'packages/recipe-cli/tsconfig.json') },
      encoding: 'utf8',
      timeout: 30_000,
    });
  const rpc = (method: string, params: unknown) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [
          path.join(source, 'apps/command-center/scripts/cdp.mjs'),
          'gateway',
          method,
          JSON.stringify(params),
        ],
        { cwd: source, env, encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
      ),
    );
  const readRun = () => (rpc('run.get', { runId }) as { run: Run }).run;
  const wait = async (read: () => boolean | Promise<boolean>, label: string, timeout = 120_000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      assert.ok(!gateway || gateway.exitCode === null, logs.join('').slice(-3000));
      if (await read()) return;
      await pause(50);
    }
    throw new Error(`Timed out: ${label}`);
  };
  try {
    mkdirSync(repo, { recursive: true });
    mkdirSync(out, { recursive: true });
    symlinkSync(path.join(source, 'packages'), path.join(root, 'packages'), 'dir');
    symlinkSync(path.join(source, 'scripts'), path.join(root, 'scripts'), 'dir');
    writeFileSync(path.join(root, 'CLAUDE.md'), '# Disposable terminal proof\n');
    json(path.join(root, 'services/gateway/package.json'), { name: 'proof', version: '0.0.0' });
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
    git('init', '-b', 'main');
    writeFileSync(path.join(repo, 'example.js'), 'export const one = 1;\n');
    git('add', 'example.js');
    git('commit', '-S', '-m', 'test: seed terminal review baseline');
    git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD'));
    git('checkout', '-b', 'review-control');
    writeFileSync(path.join(repo, 'example.js'), 'export const one = 1;\nexport const two = 2;\n');
    git('add', 'example.js');
    git('commit', '-S', '-m', 'test: add terminal review control');
    writeFileSync(path.join(repo, '.git/info/exclude'), 'tasks/\n.task/\n');
    writeFileSync(
      hostPath,
      `import {handleChecklist} from ${JSON.stringify(path.join(source, 'packages/recipe-cli/src/harness/commands/checklist.ts'))}; process.exitCode = await handleChecklist(process.argv.slice(2));`,
    );
    const task = path.join(repo, '.task/control');
    const retained = path.join(root, 'projects', project, 'tasks/control');
    for (const dir of [task, retained]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'TASK.md'), '# Control\n\n## Steps\n- [x] Worker done\n');
      json(path.join(dir, 'SIGNAL.json'), {
        status: 'complete',
        outcome: 'success',
        disposition: 'fixed',
        timestamp: new Date().toISOString(),
      });
      json(path.join(dir, 'inputs/handoff.json'), { task: { acceptanceCriteria: [] } });
    }
    const mark = path.join(temporary, 'proof-mark');
    writeFileSync(
      mark,
      `#!/bin/sh\nexec env TSX_TSCONFIG_PATH=${quote(path.join(source, 'packages/recipe-cli/tsconfig.json'))} ${quote(process.execPath)} --import ${quote(path.join(source, 'node_modules/tsx/dist/loader.mjs'))} ${quote(hostPath)} mark "$@"\n`,
      { mode: 0o755 },
    );
    json(path.join(root, 'projects', project, 'project.json'), {
      name: project,
      task_dir_name: '.task',
      runtime_dir: '.task',
      default_branch: 'main',
      hooks: {},
      vars: { mark_cmd: mark },
      review: {
        enabled: true,
        runner: 'claude',
        model: 'sonnet',
        max_retries: 0,
        review_timeout_min: 2,
      },
    });
    const template = path.join(root, 'projects', project, 'templates/worker/review.static-code.md');
    mkdirSync(path.dirname(template), { recursive: true });
    writeFileSync(
      template,
      `# Review terminal control\n\nRead the captured diff and example.js. Write your required feedback and structured result first, while your reviewer checklist stays incomplete. Then run a Node command that writes ${JSON.stringify(path.join(out, 'result-written'))} and waits up to 45 seconds, polling every 50ms, for ${JSON.stringify(path.join(out, 'allow-terminal'))}. After that file exists, finish your own checklist with the provided mark commands. Do not change source or publish.\n\n## Steps\n- [ ] Read the diff and write the required artifacts\n- [ ] Finish the review after the proof controller releases the terminal mark\n`,
    );
    const prompt = path.join(root, 'projects', project, 'templates/prompts/worker-dispatch.md');
    mkdirSync(path.dirname(prompt), { recursive: true });
    writeFileSync(
      prompt,
      'Read {{TASK_FILE}} and execute its reviewer contract. Use {{TASK_DIR}}/mark after each step. Do not run /review.\n',
    );
    const bin = path.join(temporary, 'bin');
    mkdirSync(bin);
    const actualTmux = execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim();
    writeFileSync(path.join(bin, 'tmux'), `#!/bin/sh\nexec '${actualTmux}' -N "$@"\n`, {
      mode: 0o755,
    });
    env = {
      ...env,
      PATH: `${bin}:${env.PATH}`,
      FARMSLOT_ROOT: root,
      FARMSLOT_OPERATOR_CHECKOUT: repo,
      FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
      FARMSLOT_POOL_DIR: path.join(root, 'pool'),
      FARMSLOT_RUNS_DIR: path.join(root, '.runs'),
      FARMSLOT_HOME: path.join(temporary, 'home'),
      FARMSLOT_GATEWAY_PROFILE: 'proof',
      FARMSLOT_GATEWAY_PASSWORD: '',
      FARMSLOT_DISABLE_ORCHESTRATION: '1',
      FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
      FARMSLOT_DEMO_POOL: '0',
      NODE_TEST_CONTEXT: '1',
      TSX_TSCONFIG_PATH: path.join(source, 'services/gateway/tsconfig.json'),
    };
    // Public host control checks precede gateway/reviewer startup.
    writeFileSync(path.join(task, 'CI-FIX.md'), '# Fix\n\n## Steps\n- [ ] Verify\n');
    const originalWorker = readFileSync(path.join(task, 'SIGNAL.json'), 'utf8');
    host('mark', task, '--checklist', 'CI-FIX.md', '1');
    assert.match(readFileSync(path.join(task, 'CI-FIX.md'), 'utf8'), /\[x\] Verify/);
    assert.equal(readFileSync(path.join(task, 'SIGNAL.json'), 'utf8'), originalWorker);
    json(path.join(out, 'override.json'), {
      worker: JSON.parse(originalWorker),
      fix: JSON.parse(readFileSync(path.join(task, 'CI-FIX-SIGNAL.json'), 'utf8')),
    });
    host(
      'mark',
      task,
      '--checklist',
      'CI-FIX.md',
      'blocked',
      '--reason',
      'Cleared external blocker',
    );
    host('mark', task, '--checklist', 'CI-FIX.md', 'start');
    assert.equal(
      JSON.parse(readFileSync(path.join(task, 'CI-FIX-SIGNAL.json'), 'utf8')).status,
      'running',
    );
    json(
      path.join(out, 'resumed.json'),
      JSON.parse(readFileSync(path.join(task, 'CI-FIX-SIGNAL.json'), 'utf8')),
    );
    json(path.join(root, 'pool/local.json'), {
      schema_version: 2,
      machine: hostname(),
      host: 'localhost',
      ssh_user: userInfo().username,
      os: process.platform,
      project,
      platform: 'cli',
      slots: [
        { id: slotId, project, platform: 'cli', repo, session, enabled: true, mode: 'dispatch' },
      ],
    });
    json(path.join(root, '.farm-status.json'), {
      checked_at: new Date().toISOString(),
      slots: [
        {
          slot: slotId,
          machine: hostname(),
          project,
          platform: 'cli',
          lifecycle: 'busy',
          phase: 'review-gate',
          current_run_id: runId,
        },
      ],
    });
    const now = new Date().toISOString();
    json(path.join(root, '.runs', `${runId}.json`), {
      id: runId,
      familyId: randomUUID(),
      flowType: 'dev',
      mode: 'interactive',
      status: 'human-gating',
      project,
      ticketOrPr: 'MANUAL-TERMINAL-PROOF',
      slotId,
      branch: 'review-control',
      taskFile: path.join(retained, 'TASK.md'),
      createdAt: now,
      updatedAt: now,
      transport: 'tmux',
      safetyTier: 'dangerous',
      metrics: {
        runner: 'claude',
        model: 'sonnet',
        nudgeCount: 0,
        runnerSessionId: null,
        runnerSessionPath: null,
      },
      steps: [
        { name: 'dispatch', status: 'done' },
        { name: 'human-gate', status: 'running' },
      ],
      decisions: [],
      agentContexts: [],
      engineState: { generation: 0 },
    });
    execFileSync(actualTmux, ['-N', 'new-session', '-d', '-s', session, '-c', repo]);
    sessionCreated = true;
    const server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    await new Promise<void>((resolve) => server.close(() => resolve()));
    env = {
      ...env,
      GATEWAY_HOST: '127.0.0.1',
      FARMSLOT_GATEWAY_PROFILE:
        (testGatewayIdentity(path.join(temporary, 'home'), `ws://127.0.0.1:${address.port}`),
        'proof'),
      GATEWAY_PORT: String(address.port),
      FARMSLOT_GATEWAY: `ws://127.0.0.1:${address.port}`,
    };
    // Observe the real completion loop without changing its decision. This marker
    // proves a result-first turn has crossed the production polling boundary.
    const loader = path.join(temporary, 'observe.mjs');
    const signalObservation = `if (await import('node:fs').then(fs => fs.existsSync(${JSON.stringify(path.join(out, 'result-written'))}))) { const fs = await import('node:fs'); fs.writeFileSync(${JSON.stringify(path.join(out, 'result-first-polled'))}, 'observed'); }\nconst signalRaw = (`;
    // Only the shared provider's observed PID is eligible for the crash control.
    const processObservation = `reviewerWasObservedActive ||= reviewerActive; if (runnerProbe.state === 'present') { const fs = await import('node:fs'); fs.writeFileSync(${JSON.stringify(path.join(out, 'runner-observed.json'))}, JSON.stringify(runnerProbe)); }`;
    writeFileSync(
      loader,
      `import {registerHooks} from 'node:module'; import assert from 'node:assert/strict'; registerHooks({load(url,context,nextLoad){const result=nextLoad(url,context);if(!url.endsWith('/services/gateway/src/review/review-agent.ts'))return result;const before=String(result.source);const observed=before.replace('const signalRaw = (', ${JSON.stringify(signalObservation)}); assert.notEqual(observed,before);const after=observed.replace('reviewerWasObservedActive ||= reviewerActive;', ${JSON.stringify(processObservation)}); assert.notEqual(after,observed);return {...result,source:after};}});`,
    );
    env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --import ${loader}`;
    gateway = spawn(
      process.execPath,
      ['--import', 'tsx', fileURLToPath(import.meta.url), 'serve', out, runId],
      { cwd: source, env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    for (const stream of [gateway.stdout, gateway.stderr])
      stream?.on('data', (data) => logs.push(String(data)));
    await wait(async () => {
      try {
        return (await fetch(`http://127.0.0.1:${address.port}/health`)).ok;
      } catch (error) {
        if (error instanceof TypeError) return false;
        throw error;
      }
    }, 'gateway');
    await wait(() => readRun().decisions.some((decision) => !decision.resolvedAt), 'request gate');
    const decision = readRun().decisions.find((decision) => !decision.resolvedAt)!;
    rpc('run.resolveDecision', {
      runId,
      decisionId: decision.id,
      actionId: 'request-review',
      selectionData: {
        reviewRequest: { runner: 'claude', model: 'sonnet', effort: null, mode: 'cold' },
      },
    });
    await wait(() => {
      if (existsSync(path.join(out, 'review-finished.json'))) {
        const finished = JSON.parse(readFileSync(path.join(out, 'review-finished.json'), 'utf8'));
        assert.equal(
          finished.run.engineState.publishGate.reviews[0].verdict,
          'pass',
          JSON.stringify(finished),
        );
        throw new Error('Reviewer finished before its own terminal mark was released');
      }
      return existsSync(path.join(out, 'result-first-polled'));
    }, 'result-first actual review poll');
    assert.equal(
      existsSync(path.join(out, 'review-finished.json')),
      false,
      'result file alone must not finish/archive the reviewer',
    );
    const active = readRun();
    const reviewer = active.agentContexts!.find((context) => context.role === 'review')!;
    assert.notEqual(reviewer.status, 'complete');
    const target = JSON.parse(readFileSync(path.join(task, 'checklist-target.json'), 'utf8'));
    assert.equal(target.checklist, path.basename(reviewer.taskFile!));
    json(path.join(out, 'result-first.json'), { run: active, target });
    const checks = [
      'public harness honors explicit CI-FIX despite complete worker',
      'blocked start resumes through same host',
      'actual tmux reviewer result-first waits with own checklist target',
    ];
    if (scenario === 'runner-exit') {
      await wait(() => existsSync(path.join(out, 'runner-observed.json')), 'own runner observed');
      const observed = JSON.parse(readFileSync(path.join(out, 'runner-observed.json'), 'utf8'));
      assert.equal(observed.state, 'present');
      assert.ok(Number.isSafeInteger(Number(observed.pid)) && Number(observed.pid) > 1);
      const exitStartedAt = Date.now();
      process.kill(Number(observed.pid), 'SIGTERM');
      await wait(
        () => existsSync(path.join(out, 'review-exited.json')),
        'prompt crash refusal',
        25_000,
      );
      const exited = JSON.parse(readFileSync(path.join(out, 'review-exited.json'), 'utf8'));
      assert.equal(exited.error.name, 'TerminalReviewArtifactError');
      assert.match(
        exited.error.message,
        /terminal mark|signal.*missing after the reviewer runner exited/i,
      );
      assert.equal(
        exited.run.agentContexts.find((context: { id: string }) => context.id === reviewer.id)
          .status,
        'blocked',
      );
      assert.equal(existsSync(path.join(out, 'review-finished.json')), false);
      assert.ok(
        !(exited.run.engineState.publishGate?.reviews ?? []).some(
          (review: { verdict: string }) => review.verdict === 'pass',
        ),
      );
      json(path.join(out, 'runner-exit.json'), {
        elapsedMs: Date.now() - exitStartedAt,
        observed,
        exited,
      });
      checks.push(
        'observed runner crash refuses promptly with blocked context and no passing archive',
      );
    } else {
      writeFileSync(path.join(out, 'allow-terminal'), 'continue');
      await wait(
        () => existsSync(path.join(out, 'review-finished.json')),
        'reviewer own terminal finishes',
      );
      const finished = JSON.parse(readFileSync(path.join(out, 'review-finished.json'), 'utf8'));
      assert.equal(finished.run.engineState.publishGate.reviews[0].verdict, 'pass');
      const archivedSignal = finished.run.engineState.publishGate.reviews[0].artifactPaths.find(
        (file: string) => file.endsWith('/review-signal.json'),
      );
      assert.ok(archivedSignal, 'completed review archives its own terminal signal');
      const archived = JSON.parse(
        readFileSync(path.join(repo, '.task/control', archivedSignal), 'utf8'),
      );
      assert.equal(archived.status, 'complete');
      checks.push('own terminal mark completes and archives signal');
    }
    const hashes = Object.fromEntries(
      [
        'services/gateway/src/review/review-agent.ts',
        'packages/recipe-cli/src/harness/commands/checklist.ts',
        'scripts/runner-validation/gateway/reviewer-terminal-checklist.mts',
      ].map((file) => [
        file,
        createHash('sha256')
          .update(readFileSync(path.join(source, file)))
          .digest('hex'),
      ]),
    );
    json(path.join(out, 'receipt.json'), {
      runId,
      scenario,
      hashes,
      checks,
      limits: [
        'Existing tmux server only; -N refuses server startup. Disposable detached session only; no UI target, HUD not applicable.',
      ],
    });
    console.log(JSON.stringify({ pass: true, out, runId }));
  } finally {
    const cleanups = await Promise.allSettled([
      (async () => {
        if (gateway && gateway.exitCode === null && gateway.signalCode === null) {
          gateway.kill('SIGTERM');
          await Promise.race([once(gateway, 'exit'), pause(3000)]);
          if (gateway.exitCode === null && gateway.signalCode === null) gateway.kill('SIGKILL');
        }
      })(),
      (async () => {
        if (sessionCreated) execFileSync('tmux', ['-N', 'kill-session', '-t', `=${session}`]);
      })(),
    ]);
    json(path.join(out, 'logs.json'), logs);
    // The reviewer hook can finish its final local write just after the pane exits.
    rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    const failures = cleanups.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (failures.length) throw new AggregateError(failures, 'Terminal proof cleanup failed');
  }
}
