// Manual gateway proof. Setup fixtures are isolated; derived task bytes are not injected.
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { hostname, tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../../../', import.meta.url));
if (process.argv[2] === 'serve') {
  await import('../../../services/gateway/src/index.js');
} else {
  execFileSync('tmux', ['-N', 'has-session']);
  const scratch = mkdtempSync(path.join(tmpdir(), 'stack-base-proof-'));
  const root = path.join(scratch, 'root');
  const repo = path.join(root, 'checkout');
  const out = path.resolve(
    process.env.FARMSLOT_STACK_BASE_PROOF_OUT ?? 'temp/stack-base-proof',
    randomUUID(),
  );
  const session = `stack-base-${randomUUID()}`;
  const slotId = `stack-base-${randomUUID()}`;
  const project = 'stack-base-proof';
  const json = (file: string, value: unknown) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
  };
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const logs: string[] = [];
  let gateway: ChildProcess | undefined;
  let ownedSession = false;
  let env = { ...process.env };
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
  const wait = async (read: () => boolean | Promise<boolean>, label: string) => {
    const until = Date.now() + 90_000;
    while (Date.now() < until) {
      assert.ok(!gateway || gateway.exitCode === null, logs.join('').slice(-2500));
      if (await read()) return;
      await pause(50);
    }
    throw new Error(`Timed out: ${label}`);
  };
  try {
    mkdirSync(repo, { recursive: true });
    mkdirSync(out, { recursive: true });
    symlinkSync(path.join(source, 'scripts'), path.join(root, 'scripts'), 'dir');
    symlinkSync(path.join(source, 'packages'), path.join(root, 'packages'), 'dir');
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
    git('init', '-b', 'trunk');
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@example.invalid');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(path.join(repo, 'common.txt'), 'base\n');
    git('add', '.');
    git('commit', '-m', 'test: seed common base');
    const remote = path.join(scratch, 'origin.git');
    git('init', '--bare', remote);
    git('remote', 'add', 'origin', remote);
    git('push', 'origin', 'trunk');
    git('checkout', '-b', 'feat/upstream');
    writeFileSync(path.join(repo, 'parent.txt'), 'parent\n');
    git('add', '.');
    git('commit', '-m', 'test: seed published upstream');
    const parentSha = git('rev-parse', 'HEAD');
    git('push', 'origin', 'feat/upstream');
    git('checkout', '-b', 'feat/child');
    writeFileSync(path.join(repo, 'child.txt'), 'child\n');
    git('add', '.');
    git('commit', '-m', 'test: seed child contribution');
    git('push', 'origin', 'feat/child');
    writeFileSync(path.join(root, 'CLAUDE.md'), '# Stack base proof\n');
    json(path.join(root, 'services/gateway/package.json'), { name: 'proof', version: '0.0.0' });
    json(path.join(root, 'projects', project, 'project.json'), {
      name: project,
      task_dir_name: '.task',
      runtime_dir: '.task',
      default_branch: 'trunk',
      hooks: {},
    });
    for (const flow of ['pr-complete', 'update-branch']) {
      const target = path.join(root, 'projects', project, 'templates/worker', flow + '.md');
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(
        target,
        '# Branch maintenance\n\n- [ ] Rebase onto origin/{{PUBLICATION_BASE}}\n',
      );
    }
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
    const parentId = randomUUID();
    const retargetedId = randomUUID();
    const now = new Date().toISOString();
    const stack = {
      upstreamNodeId: 'upstream-node',
      upstreamRunId: randomUUID(),
      baseBranch: 'feat/upstream',
      upstreamPrNumber: 41,
      upstreamPrUrl: 'https://example.invalid/pull/41',
      resolvedSha: parentSha,
    };
    const baseRun = (id: string, flowType: string) => ({
      id,
      familyId: id,
      flowType,
      mode: 'autonomous',
      transport: 'tmux',
      status: 'failed',
      project,
      ticketOrPr: 'fixture/missing#41',
      slotId,
      branch: 'feat/child',
      taskFile: null,
      createdAt: now,
      updatedAt: now,
      metrics: {
        runner: 'scripted',
        nudgeCount: 0,
        model: null,
        runnerSessionId: null,
        runnerSessionPath: null,
      },
      steps: [
        { name: 'find-slot', status: 'done' },
        { name: 'write-task', status: 'failed' },
        ...[
          'prepare',
          'dispatch',
          'monitor',
          'review',
          'complete',
          'human-gate',
          'finalize',
          'ci-watch',
        ].map((name) => ({ name, status: 'pending' })),
      ],
      decisions: [],
      agentContexts: [],
      engineState: { generation: 0 },
      ticketData: {
        source: 'manual',
        title: 'Stack base proof',
        description: 'Verify derived branch maintenance base.',
        acceptanceCriteria: [],
        affectedArea: '',
        stepsToReproduce: [],
        screenshots: [],
        labels: [],
      },
    });
    json(path.join(root, '.runs', parentId + '.json'), {
      ...baseRun(parentId, 'dev'),
      status: 'done',
      completedAt: now,
      stack,
    });
    json(path.join(root, '.runs', retargetedId + '.json'), {
      ...baseRun(retargetedId, 'dev'),
      status: 'done',
      completedAt: now,
      stack: { ...stack, retargetedTo: 'trunk' },
    });
    const cases = [
      { id: randomUUID(), flow: 'pr-complete', parentRunId: parentId, expected: 'feat/upstream' },
      { id: randomUUID(), flow: 'update-branch', parentRunId: parentId, expected: 'feat/upstream' },
      { id: randomUUID(), flow: 'pr-complete', parentRunId: retargetedId, expected: 'trunk' },
      { id: randomUUID(), flow: 'pr-complete', parentRunId: null, expected: 'trunk' },
    ];
    for (const entry of cases)
      json(path.join(root, '.runs', entry.id + '.json'), {
        ...baseRun(entry.id, entry.flow),
        parentRunId: entry.parentRunId,
      });
    json(path.join(root, '.farm-status.json'), {
      checked_at: now,
      slots: [
        {
          slot: slotId,
          machine: hostname(),
          project,
          platform: 'cli',
          lifecycle: 'warm',
          phase: 'idle',
        },
      ],
    });
    execFileSync('tmux', ['-N', 'new-session', '-d', '-s', session, '-c', repo]);
    ownedSession = true;
    const port = createServer();
    port.listen(0, '127.0.0.1');
    await once(port, 'listening');
    const address = port.address();
    assert.ok(address && typeof address !== 'string');
    await new Promise<void>((resolve) => port.close(() => resolve()));
    const loader = path.join(scratch, 'checkpoint.mjs');
    const checkpoint = `{ const result = await executeWriteTaskStep(runId, run, {broadcastFn,stepPartialIO}); const fs=await import('node:fs');fs.writeFileSync(${JSON.stringify(out)}+'/'+runId+'.written','written');const until=Date.now()+90000;while(!fs.existsSync(${JSON.stringify(out)}+'/'+runId+'.release')){if(Date.now()>until)throw new Error('Proof checkpoint timed out');await new Promise(resolve=>setTimeout(resolve,50));}return result;}`;
    writeFileSync(
      loader,
      `import{registerHooks}from'node:module';import assert from'node:assert/strict';registerHooks({load(url,context,next){const result=next(url,context);const before=String(result.source);if(process.env.FARMSLOT_STACK_BASE_PROOF_BREAK==='writer'&&url.endsWith('/services/gateway/src/tasks/writer.ts')){const after=before.replace('? await publicationBaseForRun(run, defaultBranch)', '? defaultBranch');assert.notEqual(after,before);return{...result,source:after};}if(!url.endsWith('/services/gateway/src/run-engine/orchestrator.ts'))return result;const after=before.replace('return executeWriteTaskStep(runId, run, { broadcastFn, stepPartialIO });',${JSON.stringify(checkpoint)});assert.notEqual(after,before);return{...result,source:after};}});`,
    );
    env = {
      ...env,
      FARMSLOT_ROOT: root,
      FARMSLOT_OPERATOR_CHECKOUT: repo,
      FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
      FARMSLOT_POOL_DIR: path.join(root, 'pool'),
      FARMSLOT_RUNS_DIR: path.join(root, '.runs'),
      FARMSLOT_HOME: path.join(scratch, 'home'),
      FARMSLOT_GATEWAY_TOKEN: randomUUID(),
      FARMSLOT_GATEWAY_PASSWORD: '',
      FARMSLOT_DISABLE_ORCHESTRATION: '1',
      FARMSLOT_DISABLE_RUN_ENGINE_START: '0',
      FARMSLOT_DEMO_POOL: '0',
      NODE_TEST_CONTEXT: '1',
      TSX_TSCONFIG_PATH: path.join(source, 'services/gateway/tsconfig.json'),
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_PORT: String(address.port),
      FARMSLOT_GATEWAY: `ws://127.0.0.1:${address.port}`,
      NODE_OPTIONS: `${env.NODE_OPTIONS ?? ''} --import ${loader}`,
    };
    gateway = spawn(
      process.execPath,
      ['--import', 'tsx', fileURLToPath(import.meta.url), 'serve'],
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
    const results = [];
    for (const entry of cases) {
      rpc('run.replayStep', { runId: entry.id, stepName: 'write-task', triggeredBy: 'operator' });
      await wait(() => {
        const run = rpc('run.get', { runId: entry.id }).run;
        if (run.status === 'failed') throw new Error(run.error);
        return existsSync(path.join(out, entry.id + '.written'));
      }, 'write-task');
      const run = rpc('run.get', { runId: entry.id }).run;
      assert.ok(run.taskFile);
      const task = readFileSync(run.taskFile, 'utf8');
      const checklist = readFileSync(path.join(path.dirname(run.taskFile), 'CHECKLIST.md'), 'utf8');
      const publicationBase = task.match(/^PUBLICATION_BASE: (.+)$/m)?.[1];
      assert.equal(publicationBase, entry.expected);
      assert.ok(checklist.includes('origin/' + entry.expected));
      assert.ok(
        run.steps
          .filter((step: { name: string }) => ['prepare', 'dispatch'].includes(step.name))
          .every((step: { startedAt?: string }) => !step.startedAt),
      );
      json(path.join(out, entry.id + '.json'), { run, task, checklist });
      results.push({
        flow: entry.flow,
        expected: entry.expected,
        publicationBase,
        runId: entry.id,
      });
      rpc('run.cancel', { runId: entry.id });
      writeFileSync(path.join(out, entry.id + '.release'), 'cancelled');
      await wait(() => rpc('run.get', { runId: entry.id }).run.status === 'cancelled', 'cancel');
    }
    git('fetch', 'origin', 'feat/child');
    const remoteHead = git('rev-parse', 'origin/feat/child');
    git('merge-base', '--is-ancestor', remoteHead, 'HEAD');
    const rebaseBase = results[0].publicationBase;
    git('checkout', 'feat/upstream');
    writeFileSync(path.join(repo, 'upstream-new.txt'), 'advance\n');
    git('add', '.');
    git('commit', '-m', 'test: advance upstream');
    git('push', 'origin', 'feat/upstream');
    git('checkout', 'feat/child');
    git('fetch', 'origin', rebaseBase);
    git('rebase', 'origin/' + rebaseBase);
    git(
      'push',
      'origin',
      'HEAD:refs/heads/feat/child',
      `--force-with-lease=refs/heads/feat/child:${remoteHead}`,
    );
    assert.equal(git('rev-list', '--count', 'origin/' + rebaseBase + '..HEAD'), '1');
    assert.equal(readFileSync(path.join(repo, 'upstream-new.txt'), 'utf8'), 'advance\n');
    json(path.join(out, 'receipt.json'), {
      pass: true,
      results,
      rebaseBase,
      childCommits: 1,
      originalRunsUntouched: true,
      limits: [
        'Seeded immutable fixture input before gateway start; production replay RPC and writer derive task values.',
        'Checkpoint holds only scheduling after the native writer; no computed task or run result is substituted.',
        'No preparation, worker launch, UI or original run changes; existing server and one owned detached session only.',
      ],
    });
    console.log(JSON.stringify({ pass: true, out }));
  } finally {
    if (gateway && gateway.exitCode === null && gateway.signalCode === null) {
      gateway.kill('SIGTERM');
      await Promise.race([once(gateway, 'exit'), pause(3000)]);
      if (gateway.exitCode === null && gateway.signalCode === null) {
        gateway.kill('SIGKILL');
        await once(gateway, 'exit');
      }
    }
    if (ownedSession) execFileSync('tmux', ['-N', 'kill-session', '-t', `=${session}`]);
    json(path.join(out, 'logs.json'), logs);
    // Retain isolated fixture input and packages for the receipt; no real checkouts changed.
  }
}
