// Manual proof: real Pi, loopback stalled provider, private tmux, production gateway RPC.
// TSX_TSCONFIG_PATH=services/gateway/tsconfig.json node --import tsx --experimental-test-module-mocks --test scripts/runner-validation/pi-request-abort.live.mts
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import type { RunGetResult } from '@farmslot/protocol';

import { createNativeProofFixture } from '../../services/gateway/src/runtime/native-proof-fixture.live-support.js';

const source = fileURLToPath(new URL('../../', import.meta.url));
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 15_000;
  while (!(await check())) {
    if (Date.now() >= deadline) {
      console.error(label);
      console.error(
        execFileSync(
          'tmux',
          ['capture-pane', '-p', '-t', 'review-fixture-workspace', '-S', '-100'],
          { encoding: 'utf8' },
        ),
      );
      throw new Error(label);
    }
    await pause(25);
  }
}

test(
  'Pi first-request retry exhaustion fails a monitored static review without a task mark',
  { timeout: 60_000 },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pi-abort-rpc-'));
    const socket = await mkdtemp('/tmp/pia-');
    Object.assign(process.env, {
      NODE_TEST_CONTEXT: '1',
      FARMSLOT_ROOT: root,
      FARMSLOT_HOME: path.join(root, 'home'),
      FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
      FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
      FARMSLOT_POOL_DIR: path.join(root, 'pool'),
      FARMSLOT_TEST_STATUS_FILE: path.join(root, 'status.json'),
      FARMSLOT_DISABLE_ORCHESTRATION: '1',
      TMUX_TMPDIR: socket,
    });
    delete process.env.TMUX;
    delete process.env.TMUX_PANE;
    const tmux = (...args: string[]) => execFileSync('tmux', args, { encoding: 'utf8' });
    let ownsServer = false;
    const provider = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/models')
        res.end(
          JSON.stringify({
            data: [{ id: 'synthetic-model', context_length: 8192, max_output_tokens: 1024 }],
          }),
        );
      else {
        requests++;
        // Headers arrive, then the provider stalls forever. Client cancellation closes it.
        res.setHeader('content-type', 'text/event-stream');
        res.flushHeaders();
      }
    });
    let requests = 0;
    t.after(async () => {
      if (ownsServer && spawnSync('tmux', ['list-sessions']).status === 0) tmux('kill-server');
      provider.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        provider.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(socket, { recursive: true, force: true });
    });
    for (const name of [
      'scripts',
      'packages',
      'services',
      'node_modules',
      'schemas',
      'package.json',
      'CLAUDE.md',
    ])
      await symlink(path.join(source, name), path.join(root, name));
    for (const name of ['home', 'pool', 'projects/fixture/templates/worker', 'source', 'agent'])
      await mkdir(path.join(root, name), { recursive: true });
    await writeFile(
      path.join(root, 'agent/settings.json'),
      JSON.stringify({
        packages: [],
        skills: [],
        retry: { enabled: true, maxRetries: 1, baseDelayMs: 10 },
      }),
    );
    await writeFile(
      path.join(root, 'status.json'),
      JSON.stringify({ updated_at: new Date().toISOString(), slots: [] }),
    );
    await writeFile(
      path.join(root, 'pool/local.json'),
      JSON.stringify({
        machine: 'local',
        host: 'localhost',
        ssh_user: os.userInfo().username,
        project: 'fixture',
        platform: 'cli',
        slots: [],
        review_workspaces: { max_concurrent: 2 },
      }),
    );
    await writeFile(
      path.join(root, 'projects/fixture/project.json'),
      JSON.stringify({
        name: 'fixture',
        execution_templates: {},
        static_review: { template_id: 'review-pr/default' },
        monitoring: { total_timeout_min: 1 },
      }),
    );
    await writeFile(
      path.join(root, 'projects/fixture/templates/worker/review-pr.md'),
      '# Synthetic review\n\n- [ ] Review the synthetic diff.\n- [ ] Write artifacts.\n',
    );
    const fixture = await createNativeProofFixture(t, root);
    const store = await import('../../services/gateway/src/runs/store.js');
    const { initServerGlobals, resetServerGlobalsForTests } =
      await import('../../services/gateway/src/server.js');
    initServerGlobals();
    delete process.env.FARMSLOT_DISABLE_RUN_ENGINE_START;
    t.after(resetServerGlobalsForTests);
    const connection = await fixture.client.connect();
    t.after(() => connection.close());
    const project = await (
      await import('../../services/gateway/src/core/config.js')
    ).loadProjectVars('fixture');
    const selection = (
      await import('../../services/gateway/src/tasks/execution-template-catalog.js')
    ).resolveConfiguredExecutionTemplate(project, {
      flow: 'review-pr',
      platform: 'web',
      runMode: 'autonomous',
    });
    const subject = {
      repository: 'example/fixture',
      repositoryUrl: 'https://github.com/example/fixture.git',
      headSha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40),
      branch: 'fixture',
      title: 'Synthetic review',
      body: '',
      capturedAt: new Date().toISOString(),
    };
    const run = store.createRun(
      {
        project: 'fixture',
        flowType: 'review-pr',
        mode: 'autonomous',
        ticketOrPr: 'example/fixture#1',
        runner: 'pi',
        model: 'router/synthetic-model',
        transport: 'tmux',
        reviewWorkspaceTarget: { machine: 'local' },
      },
      { nativeOwnerPrincipalId: fixture.person.id },
    );
    const task = path.join(root, 'task');
    store.updateRun(run.id, {
      executionTemplate: selection.reference,
      reviewWorkspaceSubject: subject,
      reviewWorkspace: {
        workspaceId: 'fixture-workspace',
        machine: 'local',
        executionNodeId: 'local',
        checkoutPath: path.join(root, 'source'),
        taskPath: task,
        artifactPath: path.join(task, 'artifacts'),
      },
    });
    const taskApi = await import('../../services/gateway/src/review-workspaces/task.js');
    const materialized = await taskApi.materializeReviewWorkspaceTask(run.id, subject);
    const started = new Date().toISOString();
    assert.equal(await taskApi.readReviewWorkspaceSignal(run.id), null);
    store.updateRun(run.id, {
      status: 'paused',
      taskFile: materialized.taskFile,
      steps: [
        { name: 'find-slot', status: 'done' },
        { name: 'write-task', status: 'done' },
        { name: 'prepare', status: 'done' },
        { name: 'dispatch', status: 'done' },
        { name: 'monitor', status: 'running', startedAt: started },
        { name: 'human-gate', status: 'pending' },
        { name: 'complete', status: 'pending' },
      ],
      agentContexts: [
        {
          id: 'review',
          role: 'review',
          label: 'Synthetic Pi reviewer',
          slotId: null,
          runId: run.id,
          status: 'launching',
          runner: 'pi',
          model: 'router/synthetic-model',
          target: { session: 'review-fixture-workspace', target: 'review-fixture-workspace' },
          promptDeliveryStartedAt: started,
          attemptStartedAt: started,
        },
      ],
    });
    await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
    const address = provider.address();
    assert.ok(address && typeof address !== 'string');
    tmux(
      '-f',
      '/dev/null',
      'new-session',
      '-d',
      '-s',
      'review-fixture-workspace',
      '-x',
      '140',
      '-y',
      '42',
      '/bin/sh',
    );
    ownsServer = true;
    tmux(
      'set-option',
      '-t',
      'review-fixture-workspace',
      '@farmslot-review-workspace',
      'fixture-workspace',
    );
    const pi =
      process.env.FARMSLOT_PI_PROOF_CLI ??
      path.join(
        os.homedir(),
        '.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js',
      );
    const environment = {
      PATH: `${path.dirname(process.execPath)}:/opt/homebrew/bin:/usr/bin:/bin`,
      TMUX_PANE: tmux(
        'display-message',
        '-p',
        '-t',
        'review-fixture-workspace',
        '#{pane_id}',
      ).trim(),
      PI_OFFLINE: '1',
      HOME: root,
      TERM: 'xterm-256color',
      PI_CODING_AGENT_DIR: path.join(root, 'agent'),
      FARMSLOT_PI_OLLAMA: '0',
      FARMSLOT_PI_ROUTER_URL: `http://127.0.0.1:${address.port}/v1`,
      FARMSLOT_PI_ROUTER_KEY: 'synthetic-key',
      FARMSLOT_PI_REQUEST_TIMEOUT_MS: '3000',
      FARMSLOT_PI_REQUEST_TIMEOUT_MODE: 'total',
      FARMSLOT_OBS_DIR: path.join(task, '.observability'),
    };
    const command = [
      'env',
      '-i',
      ...Object.entries(environment).map(([k, v]) => `${k}=${v}`),
      process.execPath,
      pi,
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-themes',
      '--no-mcp',
      '-e',
      path.join(source, 'scripts/runners/pi-farmslot-observability.ts'),
      '--provider',
      'router',
      '--model',
      'synthetic-model',
      '--thinking',
      'off',
      'Read the synthetic fixture.',
    ];
    const launch = path.join(root, 'launch.sh');
    await writeFile(
      launch,
      `#!/bin/sh\ncd ${quote(path.join(root, 'source'))}\nexec ${command.map(quote).join(' ')}\n`,
    );
    tmux('send-keys', '-t', 'review-fixture-workspace', '-l', `/bin/sh ${quote(launch)}`);
    tmux('send-keys', '-t', 'review-fixture-workspace', 'Enter');
    const hooksFile = path.join(task, '.observability/hooks.jsonl');
    let hooks: Array<Record<string, unknown>> = [];
    const read = async () =>
      (await connection.call<RunGetResult>('run.get', { runId: run.id })).run;
    await until(async () => requests === 1, 'Pi did not start its first request');
    await connection.call('run.resume', { runId: run.id });
    await until(
      async () => (await read()).status === 'monitoring',
      'Review did not begin monitoring',
    );
    await until(async () => requests === 2, 'Pi did not retry its stalled first request');
    const retrying = await read();
    assert.equal(retrying.status, 'monitoring', retrying.error);
    assert.equal(await taskApi.readReviewWorkspaceSignal(run.id), null, 'no pre-seeded mark start');
    assert.equal(retrying.agentContexts?.[0].promptAcceptance, undefined);
    await until(async () => {
      hooks = (await readFile(hooksFile, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      return hooks.some((hook) => hook.event === 'StopFailure');
    }, 'Pi did not emit StopFailure');
    assert.equal(requests, 2, 'one retry, no paid requests');
    const failure = hooks.find((hook) => hook.event === 'StopFailure')!;
    assert.match(String(failure.failure), /timed out after 3000ms and one retry/);
    const { isRunEngineDriven } =
      await import('../../services/gateway/src/run-engine/orchestrator.js');
    try {
      await until(
        async () => ['failed', 'blocked', 'reconciling'].includes((await read()).status),
        'Static review stayed monitoring',
      );
    } catch (error) {
      await connection.call('run.cancel', { runId: run.id });
      await until(async () => !isRunEngineDriven(run.id), 'Cancelled fixture engine did not stop');
      await store.persistRunNow(store.getRun(run.id)!, 'flush cancelled proof');
      throw error;
    }
    const observed = await read();
    assert.equal(observed.status, 'failed', observed.error);
    assert.match(observed.error ?? '', /timed out after 3000ms and one retry/);
    assert.equal(observed.steps.find((step) => step.name === 'monitor')?.status, 'failed');

    await until(async () => !isRunEngineDriven(run.id), 'Fixture engine did not finish cleanup');
    await store.persistRunNow(store.getRun(run.id)!, 'flush proof before teardown');
    console.log(
      JSON.stringify({
        requests,
        firstRequest: 'monitoring',
        retry: retrying.status,
        taskMark: 'absent',
        staticReview: observed.status,
        reason: observed.error,
        hook: failure.event,
      }),
    );
  },
);
