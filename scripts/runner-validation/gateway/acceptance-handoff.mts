// Manual production gateway intake proof. Uses an existing tmux server only.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
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
import { createServer } from 'node:http';
import { createServer as portServer } from 'node:net';
import { hostname, tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Run, RunTicketData } from '@farmslot/protocol';
import { shSingleQuote } from '../../lib/shell-quote.mjs';

const source = fileURLToPath(new URL('../../../', import.meta.url));
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const json = (file: string, value: unknown) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
};
if (process.argv[2] === 'serve') {
  await import('../../../services/gateway/src/index.js');
} else {
  execFileSync('tmux', ['-N', 'has-session']);
  const scratch = mkdtempSync(path.join(tmpdir(), 'acceptance-handoff-proof-'));
  const root = path.join(scratch, 'root');
  const repo = path.join(root, 'checkout');
  const out = path.resolve(
    process.env.FARMSLOT_HANDOFF_PROOF_OUT ?? 'temp/acceptance-handoff',
    randomUUID(),
  );
  const project = 'acceptance-handoff-proof';
  const session = `handoff-${randomUUID()}`;
  const slotId = `handoff-${randomUUID()}`;
  const expected = process.env.FARMSLOT_HANDOFF_PROOF_INPUT
    ? (JSON.parse(readFileSync(process.env.FARMSLOT_HANDOFF_PROOF_INPUT, 'utf8')) as Pick<
        RunTicketData,
        'description' | 'acceptanceCriteria'
      >)
    : {
        description:
          'Scope.\n\nAC1: The current amount shows a loading placeholder.\n\nAC2: The quote belongs to the amount on screen.\n\nAC3: Invalid input is handled explicitly.\n\nAC4: Capture loading and resolved states.\n\nRelease notes stay prose.',
        acceptanceCriteria: [
          'The current amount shows a loading placeholder.',
          'The quote belongs to the amount on screen.',
          'Invalid input is handled explicitly.',
          'Capture loading and resolved states.',
        ],
      };
  let gateway: ChildProcess | undefined;
  let sessionCreated = false;
  const logs: string[] = [];
  const retired = 'A retired criterion.';
  const emptyHeading = {
    type: 'doc',
    version: 1,
    content: [
      {
        type: 'heading',
        attrs: { level: 2 },
        content: [{ type: 'text', text: 'Acceptance Criteria' }],
      },
      {
        type: 'heading',
        attrs: { level: 2 },
        content: [{ type: 'text', text: 'Previous requirements' }],
      },
      { type: 'paragraph', content: [{ type: 'text', text: 'AC1: ' + retired }] },
    ],
  };
  const emptyLabel = 'Acceptance criteria:\n\nPrevious requirements:\nAC1: ' + retired;
  const jira = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify(
        request.url?.includes('/comment')
          ? { comments: [] }
          : {
              fields: {
                summary: 'Acceptance handoff proof',
                description: request.url?.includes('HANDOFF-103')
                  ? emptyHeading
                  : request.url?.includes('HANDOFF-104')
                    ? emptyLabel
                    : expected.description,
                issuetype: { name: 'Task' },
                labels: [],
                components: [],
                attachment: [],
              },
            },
      ),
    );
  });
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
  const readRun = (runId: string): Run => rpc('run.get', { runId }).run;
  const wait = async (read: () => boolean | Promise<boolean>, label: string) => {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
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
    git('init', '-b', 'main');
    writeFileSync(path.join(repo, 'example.txt'), 'proof\n');
    git('add', 'example.txt');
    git('commit', '-S', '-m', 'test: seed acceptance handoff fixture');
    git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD'));
    git('checkout', '-b', 'proof-handoff');
    writeFileSync(path.join(root, 'CLAUDE.md'), '# Acceptance metadata proof\n');
    json(path.join(root, 'services/gateway/package.json'), { name: 'proof', version: '0.0.0' });
    jira.listen(0, '127.0.0.1');
    await once(jira, 'listening');
    const jiraAddress = jira.address();
    assert.ok(jiraAddress && typeof jiraAddress !== 'string');
    json(path.join(root, 'projects', project, 'project.json'), {
      name: project,
      task_dir_name: '.task',
      runtime_dir: '.task',
      default_branch: 'main',
      hooks: {},
      jira: {
        base_url: `http://127.0.0.1:${jiraAddress.port}`,
        email_env: 'FARMSLOT_PROOF_JIRA_EMAIL',
        api_token_env: 'FARMSLOT_PROOF_JIRA_TOKEN',
      },
    });
    const template = path.join(root, 'projects', project, 'templates/worker/dev.md');
    mkdirSync(path.dirname(template), { recursive: true });
    writeFileSync(
      template,
      '# Worker: Dev\n\n## Description\n{{DESCRIPTION}}\n\n## Acceptance Criteria\n{{ACCEPTANCE_CRITERIA}}\n\n## Steps\n- [ ] Verify declared criteria\n',
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
    const runs = [
      { id: randomUUID(), ticket: 'HANDOFF-101', cached: false },
      { id: randomUUID(), ticket: 'HANDOFF-102', cached: true },
      { id: randomUUID(), ticket: 'HANDOFF-103', cached: false },
      { id: randomUUID(), ticket: 'HANDOFF-104', cached: false },
    ];
    const now = new Date().toISOString();
    for (const run of runs)
      json(path.join(root, '.runs', run.id + '.json'), {
        id: run.id,
        familyId: run.id,
        flowType: 'dev',
        mode: 'autonomous',
        transport: 'tmux',
        status: 'failed',
        project,
        ticketOrPr: run.ticket,
        slotId,
        branch: 'proof-handoff',
        taskFile: null,
        summary: 'Acceptance handoff proof',
        createdAt: now,
        updatedAt: now,
        metrics: {
          runner: 'codex',
          nudgeCount: 0,
          model: null,
          runnerSessionId: null,
          runnerSessionPath: null,
        },
        steps: [
          { name: 'find-slot', status: 'done' },
          { name: 'write-task', status: 'failed' },
          { name: 'prepare', status: 'pending' },
          { name: 'dispatch', status: 'pending' },
          { name: 'monitor', status: 'pending' },
          { name: 'review', status: 'pending' },
          { name: 'complete', status: 'pending' },
          { name: 'human-gate', status: 'pending' },
          { name: 'finalize', status: 'pending' },
          { name: 'ci-watch', status: 'pending' },
        ],
        decisions: [],
        agentContexts: [],
        engineState: { generation: 0 },
        ...(run.cached
          ? {
              ticketData: {
                source: 'jira',
                jiraKey: run.ticket,
                title: 'Acceptance handoff proof',
                description: expected.description,
                acceptanceCriteria: [],
                affectedArea: '',
                stepsToReproduce: [],
                screenshots: [],
                labels: [],
              },
            }
          : {}),
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
    sessionCreated = true;
    const bin = path.join(scratch, 'bin');
    mkdirSync(bin);
    const tmux = execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim();
    writeFileSync(path.join(bin, 'tmux'), `#!/bin/sh\nexec ${shSingleQuote(tmux)} -N "$@"\n`, {
      mode: 0o755,
    });
    const ports = portServer();
    ports.listen(0, '127.0.0.1');
    await once(ports, 'listening');
    const address = ports.address();
    assert.ok(address && typeof address !== 'string');
    await new Promise<void>((resolve) => ports.close(() => resolve()));
    // Hold only scheduling after the real writer returns, so public cancellation
    // can stop before preparation. No outcome or persisted value is changed.
    const loader = path.join(scratch, 'observe.mjs');
    writeFileSync(
      loader,
      `import {registerHooks} from 'node:module';import assert from 'node:assert/strict';registerHooks({load(url,context,next){const result=next(url,context);if(!url.endsWith('/services/gateway/src/run-engine/orchestrator.ts'))return result;const before=String(result.source);const after=before.replace('return executeWriteTaskStep(runId, run, { broadcastFn, stepPartialIO });',${JSON.stringify(`{ const result = await executeWriteTaskStep(runId, run, {broadcastFn,stepPartialIO}); const fs = await import('node:fs'); fs.writeFileSync(${JSON.stringify(out)}+'/'+runId+'.written','written'); const until=Date.now()+90000; while(!fs.existsSync(${JSON.stringify(out)}+'/'+runId+'.release')) { if(Date.now()>until)throw new Error('Proof controller did not cancel writer checkpoint'); await new Promise(resolve=>setTimeout(resolve,50)); } return result; }`)});assert.notEqual(after,before);return {...result,source:after};}});`,
    );
    env = {
      ...env,
      PATH: `${bin}:${env.PATH}`,
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
      FARMSLOT_PROOF_JIRA_EMAIL: 'fixture@example.invalid',
      FARMSLOT_PROOF_JIRA_TOKEN: 'fixture-only',
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
    const cases = [];
    for (const entry of runs) {
      const criteria = ['HANDOFF-103', 'HANDOFF-104'].includes(entry.ticket)
        ? []
        : expected.acceptanceCriteria;
      rpc('run.replayStep', { runId: entry.id, stepName: 'write-task', triggeredBy: 'operator' });
      await wait(() => {
        const run = readRun(entry.id);
        if (run.status === 'failed') throw new Error(run.error);
        return existsSync(path.join(out, entry.id + '.written'));
      }, 'production write-task');
      const run = readRun(entry.id);
      for (const step of ['prepare', 'dispatch']) {
        assert.equal(
          run.steps.find((candidate) => candidate.name === step)?.startedAt,
          undefined,
          'checkpoint precedes preparation and worker launch',
        );
      }
      assert.deepEqual(run.ticketData?.acceptanceCriteria, criteria);
      assert.ok(run.taskFile);
      const task = readFileSync(run.taskFile, 'utf8');
      const handoff = JSON.parse(
        readFileSync(path.join(path.dirname(run.taskFile), 'inputs/handoff.json'), 'utf8'),
      );
      assert.deepEqual(handoff.task.acceptanceCriteria ?? [], criteria);
      const formal = task.split('## Acceptance Criteria')[1]?.split('\n## ')[0] ?? '';
      for (const criterion of criteria) assert.ok(formal.includes(criterion));
      json(path.join(out, entry.id + '.json'), { cached: entry.cached, run, handoff, task });
      cases.push({
        runId: entry.id,
        cached: entry.cached,
        count: criteria.length,
      });
      rpc('run.cancel', { runId: entry.id });
      writeFileSync(path.join(out, entry.id + '.release'), 'cancelled');
      await wait(() => readRun(entry.id).status === 'cancelled', 'public cancellation');
    }
    const hashes = Object.fromEntries(
      [
        'services/gateway/src/external/ticket-markdown.ts',
        'services/gateway/src/external/jira.ts',
        'services/gateway/src/external/github.ts',
        'services/gateway/src/run-engine/task-steps.ts',
        'scripts/runner-validation/gateway/acceptance-handoff.mts',
      ].map((file) => [
        file,
        createHash('sha256')
          .update(readFileSync(path.join(source, file)))
          .digest('hex'),
      ]),
    );
    json(path.join(out, 'receipt.json'), {
      cases,
      hashes,
      checks: [
        'public replay fetches labeled Jira criteria',
        'cached empty criteria are recovered by production write-task',
        'stored run, formal task and handoff match authored criteria',
        'explicit empty heading and label suppress retired criteria',
        'public cancel precedes preparation/worker launch',
      ],
      limits: [
        'Temporary local Jira source transports authored input; real gateway/RPC and writer derive all outputs. Existing tmux server only, one detached owned session. No UI target, HUD not applicable.',
      ],
    });
    console.log(JSON.stringify({ pass: true, out }));
  } finally {
    const cleanup = await Promise.allSettled([
      (async () => {
        if (gateway && gateway.exitCode === null && gateway.signalCode === null) {
          gateway.kill('SIGTERM');
          await Promise.race([once(gateway, 'exit'), pause(3000)]);
          if (gateway.exitCode === null && gateway.signalCode === null) {
            gateway.kill('SIGKILL');
            await once(gateway, 'exit');
          }
        }
      })(),
      (async () => {
        if (sessionCreated) {
          const status = spawnSync('tmux', ['-N', 'has-session', '-t', `=${session}`]);
          if (status.status === 0)
            execFileSync('tmux', ['-N', 'kill-session', '-t', `=${session}`]);
          else assert.equal(status.status, 1, 'owned session existence check');
        }
      })(),
      (async () => {
        if (jira.listening)
          await new Promise<void>((resolve, reject) =>
            jira.close((error) => (error ? reject(error) : resolve())),
          );
      })(),
    ]);
    json(path.join(out, 'logs.json'), logs);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    const errors = cleanup.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (errors.length) throw new AggregateError(errors, 'Handoff proof cleanup failed');
  }
}
