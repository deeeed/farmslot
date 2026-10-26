// Opt-in local Git + authenticated RPC proof. No product checkout or model is used.
// TSX_TSCONFIG_PATH=services/gateway/tsconfig.json node --import tsx --test --test-force-exit <this-file>
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { hostname, userInfo } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import type { Run } from '@farmslot/protocol';

test(
  'publication pushes exact Git objects and finalize checks origin through authenticated replay',
  { timeout: 180_000 },
  async (t) => {
    const out = process.env.FARMSLOT_PUBLICATION_PROOF_OUT;
    assert.ok(out, 'set FARMSLOT_PUBLICATION_PROOF_OUT to retain evidence');
    const root = await realpath(await mkdtemp('/tmp/pub-head-'));
    const code = fileURLToPath(new URL('../../../../', import.meta.url));
    const repo = path.join(root, 'repo');
    const project = 'publication-proof';
    const slotId = 'publication-proof-slot';
    const branch = 'fix/publication-proof';
    await mkdir(out, { recursive: true });
    const save = (name: string, value: unknown) =>
      writeFile(path.join(out, name), JSON.stringify(value, null, 2) + '\n');
    await save('owned-root.json', { root, code });
    for (const key of Object.keys(process.env))
      if (/^FARMSLOT_|^GATEWAY_|^GW_URL$|^NODE_TOKEN$|^TMUX/.test(key)) delete process.env[key];
    Object.assign(process.env, {
      FARMSLOT_ROOT: root,
      FARMSLOT_POOL_DIR: path.join(root, 'pool'),
      FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
      FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
      FARMSLOT_HOME: path.join(root, 'home'),
      FARMSLOT_GATEWAY_AUTH_MODE: 'token',
      TMUX_TMPDIR: path.join(root, 'tmux'),
      NODE_TEST_CONTEXT: '1',
    });
    for (const dir of ['repo', 'pool', 'runs', 'home', 'tmux', 'bin', `projects/${project}`])
      await mkdir(path.join(root, dir), { recursive: true });
    for (const name of ['scripts', 'packages', 'services', 'schemas', 'node_modules', 'CLAUDE.md'])
      await symlink(path.join(code, name), path.join(root, name));
    await writeFile(
      path.join(root, `projects/${project}/project.json`),
      JSON.stringify({
        name: project,
        task_dir: '.task',
        default_branch: 'main',
        ci: { repo: 'fixture/publication-proof' },
        review: { enabled: false },
        scripted: { commands: { proof: { command: 'true' } } },
        hooks: {},
      }),
    );
    await writeFile(
      path.join(root, 'pool/proof.json'),
      JSON.stringify({
        machine: hostname(),
        host: 'localhost',
        ssh_user: userInfo().username,
        project,
        platform: 'cli',
        slots: [{ id: slotId, enabled: true, repo, session: slotId }],
      }),
    );
    // Block all external GitHub access. This proof checks Git and run settlement, not GitHub hosting.
    await writeFile(
      path.join(root, 'bin/gh'),
      '#!/bin/sh\ncase "$*" in\n*reviews*) echo "[]";;\n*"pr checks"*) echo "[]";;\n*"pr view"*) echo \'{"number":255,"state":"OPEN","author":{"login":"fixture"}}\';;\n*) echo "{}";;\nesac\n',
      { mode: 0o755 },
    );
    process.env.PATH = `${path.join(root, 'bin')}:${process.env.PATH}`;
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@example.invalid');
    git('config', 'commit.gpgsign', 'false');
    await writeFile(path.join(repo, 'proof.txt'), 'base\n');
    git('add', '.');
    git('commit', '-qm', 'test: seed publication');
    execFileSync('git', ['init', '-q', '--bare', path.join(root, 'origin.git')]);
    git('remote', 'add', 'origin', path.join(root, 'origin.git'));
    git('push', '-q', 'origin', 'main');
    git('switch', '-qc', branch);
    git('push', '-qu', 'origin', branch);
    const old = git('rev-parse', 'HEAD');
    await writeFile(path.join(repo, 'proof.txt'), 'published proof\n');
    git('add', '.');
    git('commit', '-qm', 'fix: publish final proof');
    const head = git('rev-parse', 'HEAD');
    // A real pre-push hook must run, and its refusal must prevent publication.
    const hookReceipt = path.join(root, 'hook-ran');
    await writeFile(
      path.join(repo, '.git/hooks/pre-push'),
      `#!/bin/sh\nprintf hook >> '${hookReceipt}'\ntest ! -f '${root}/refuse-push'\n`,
      { mode: 0o755 },
    );
    await writeFile(
      path.join(root, '.farm-status.json'),
      JSON.stringify({
        slots: [
          {
            slot: slotId,
            machine: hostname(),
            project,
            platform: 'cli',
            lifecycle: 'ready',
            slot_epoch: 1,
          },
        ],
      }),
    );
    const { runScriptedRunner } =
      await import('../../../../packages/cli/src/commands/scripted-runner.js');
    const taskDir = path.join(repo, '.task/proof');
    const dispatchedAt = new Date().toISOString();
    const originalCwd = process.cwd();
    process.chdir(repo);
    try {
      assert.equal(
        await runScriptedRunner({ mode: 'command', taskDir, commandRef: 'proof', project }),
        0,
      );
    } finally {
      process.chdir(originalCwd);
    }
    const signal = JSON.parse(await readFile(path.join(taskDir, 'SIGNAL.json'), 'utf8'));
    await writeFile(path.join(taskDir, 'TASK.md'), '# Local publication proof\n');
    const { createGatewayAuthRuntime } = await import('../security/auth.js');
    const auth = createGatewayAuthRuntime({ FARMSLOT_HOME: path.join(root, 'home') });
    const person = auth.writer.createPrincipal(
      { type: 'person', displayName: 'Publication proof' },
      [{ role: 'admin', scope: { kind: 'global' } }],
    );
    const credential = auth.writer.issueCredential(person.id, 'Local proof');
    const grant = auth.writer.exchangePersonCredential(credential.secret, {
      deviceName: 'Local proof',
      deviceKind: 'cli',
    });
    const { createWebSocketServer, broadcastEvent } = await import('../server.js');
    const { initRunEngine } = await import('../run-engine/orchestrator.js');
    const { createRun, updateRun, getRun, persistRunNow } = await import('../runs/store.js');
    const { GatewayClient } = await import('../../../../packages/cli/src/gateway-client.js');
    const { assertPublicationRemoteHead, pushPublicationBranch } =
      await import('./publication-push.js');
    const { updateSlotStatus } = await import('../core/index.js');
    initRunEngine(broadcastEvent);
    const { isTerminalTeardownInFlight } =
      await import('../run-engine/terminal-teardown-registry.js');
    const waitCleanup = async () => {
      const deadline = Date.now() + 30_000;
      while (isTerminalTeardownInFlight(slotId)) {
        assert.ok(Date.now() < deadline, 'owned terminal cleanup must settle');
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };
    const http = createServer();
    const wss = createWebSocketServer(http, auth);
    t.after(async () => {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      if (http.listening) await new Promise<void>((resolve) => http.close(() => resolve()));
      await waitCleanup();
      const { makeOwnerWritable } = await import('../core/owned-copy.js');
      await makeOwnerWritable(root);
      await rm(root, { recursive: true, force: true });
    });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const address = http.address();
    assert.ok(address && typeof address !== 'string');
    const client = await new GatewayClient({
      url: `ws://127.0.0.1:${address.port}/ws`,
      timeout: 60_000,
      credential: { token: grant.accessToken },
    }).connect();
    t.after(() => client.close());
    const created = createRun({
      flowType: 'pr-complete',
      mode: 'autonomous',
      project,
      ticketOrPr: 'fixture/publication-proof#255',
      slotId,
      branch,
    });
    updateRun(created.id, {
      status: 'failed',
      prNumber: 255,
      taskFile: path.join(taskDir, 'TASK.md'),
      // Earlier stages use the completed real local command receipt; no model was launched.
      scripted: { mode: 'command', commandRef: 'proof' },
      metrics: { ...created.metrics, runner: 'scripted' },
      agentContexts: [
        {
          id: 'primary',
          runId: created.id,
          slotId,
          role: 'primary',
          label: 'Local proof',
          runner: 'scripted',
          status: 'waiting',
          taskFile: path.join(taskDir, 'TASK.md'),
          signalFile: path.join(taskDir, 'SIGNAL.json'),
        },
      ],
      steps: created.steps.map((step) => ({
        ...step,
        status: step.name === 'finalize' ? 'failed' : 'done',
        ...(step.name === 'dispatch' ? { startedAt: dispatchedAt } : {}),
        ...(step.name === 'monitor'
          ? { outputs: { workerSignal: { ...signal, role: 'primary', contextId: 'primary' } } }
          : {}),
        ...(step.name === 'complete' ? { outputs: { publishedHeadSha: head } } : {}),
      })),
    });
    await updateSlotStatus(slotId, {
      lifecycle: 'busy',
      phase: 'ci-watch',
      current_run_id: created.id,
      branch,
    });
    const current = () => getRun(created.id)!;
    const { resolveWorkerTerminalContract } = await import('../tasks/worker-terminal-contract.js');
    const { WORKER_TERMINAL_CONTRACT_INPUT } = await import('@farmslot/protocol');
    await mkdir(path.join(taskDir, 'inputs'), { recursive: true });
    await writeFile(
      path.join(taskDir, 'inputs/handoff.json'),
      JSON.stringify({
        attemptId: created.id,
        project,
        flow: 'pr-complete',
        task: { acceptanceCriteria: [] },
      }),
    );
    await writeFile(
      path.join(taskDir, WORKER_TERMINAL_CONTRACT_INPUT),
      JSON.stringify({
        ...resolveWorkerTerminalContract(null, 'pr-complete', { mode: 'autonomous' }),
        recordedEvidenceContractVersion: 1,
      }),
    );
    const config = await import('../core/config.js');
    const { projectJson } = await config.loadProjectVars(project);
    const orchTask = path.join(config.getOrchestratorTaskRoot(project, projectJson), 'proof');
    await cp(taskDir, orchTask, { recursive: true });
    updateRun(created.id, { taskFile: path.join(orchTask, 'TASK.md') });
    const { retainRunFixture } = await import('../run-engine/test-fixtures.js');
    await retainRunFixture(current());
    updateRun(created.id, { artifactBundle: current().artifactBundle });
    const { loadSlotVars } = await import('../core/config.js');
    const { readScriptedCommandProgress } = await import('../runners/scripted-progress.js');
    assert.equal(
      await readScriptedCommandProgress({
        run: current(),
        context: current().agentContexts![0],
        vars: await loadSlotVars(slotId),
      }),
      'idle',
    );
    await assert.rejects(assertPublicationRemoteHead(current(), head), /remote HEAD mismatch/);
    // Prove the supported finalize endpoint rejects an unpublished commit.
    await client.call('run.replayStep', { runId: created.id, stepName: 'finalize' });
    const untilFinalize = async () => {
      const deadline = Date.now() + 60_000;
      for (;;) {
        const result = await client.call<{ run: Run }>('run.get', { runId: created.id });
        const run = result.run;
        const step = run.steps.find((entry) => entry.name === 'finalize');
        if (step?.status === 'done' || step?.status === 'failed') return run;
        assert.ok(Date.now() < deadline, 'finalize must settle');
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };
    const refused = await untilFinalize();
    await save('remote-behind-refused.json', refused);
    assert.equal(refused.steps.find((step) => step.name === 'finalize')?.status, 'failed');
    assert.match(refused.error ?? '', /remote HEAD mismatch/);
    await waitCleanup();
    // Push exactly the publication HEAD through the production helper and real hook.
    await pushPublicationBranch(current(), head);
    assert.equal(git('ls-remote', 'origin', `refs/heads/${branch}`).split(/\s+/)[0], head);
    assert.match(await readFile(hookReceipt, 'utf8'), /hook/);
    await client.call('run.replayStep', { runId: created.id, stepName: 'finalize' });
    const published = await untilFinalize();
    await save('remote-current-finalize.json', published);
    assert.equal(published.steps.find((step) => step.name === 'finalize')?.status, 'done');
    if (!['done', 'failed', 'cancelled'].includes(current().status))
      await client.call('run.cancel', {
        runId: created.id,
        reason: 'Owned publication proof complete',
      });
    await save('PASS.json', {
      pass: true,
      old,
      head,
      remote: git('ls-remote', 'origin', `refs/heads/${branch}`),
      hookRan: true,
      authenticatedReplay: true,
      fixtureBeginsAtFinalize: true,
      githubHostingSubstituted: true,
      productionMethodsSubstituted: false,
    });
    await waitCleanup();
    await persistRunNow(current(), 'publication proof teardown');
  },
);
