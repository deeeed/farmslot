#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { openSync, closeSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile, access, cp } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import {
  GatewayClient,
  GatewayConnectionError,
  GatewayRpcError,
  type GatewayConnection,
} from '../packages/cli/src/gateway-client.js';
import type { Run, NativeSessionReadResult } from '../packages/protocol/src/index.js';
import { alive, matchesProcess } from '../packages/agent-runtime/src/native/storage.js';

// Uses the installed native reviewer and its existing account. Provider PR facts come
// from a read-only fixture; run creation, ownership and worker execution are real.
const root = fileURLToPath(new URL('../', import.meta.url));
const verifyRevocation = process.argv[3] === 'authority';
const evidence = path.resolve(
  root,
  process.argv[2] ?? `temp/workspace-review-remote/${Date.now()}`,
);
await mkdir(evidence, { recursive: true });
const fixture = await mkdtemp(path.join(tmpdir(), 'workspace-review-remote-'));
execFileSync('git', ['clone', '--shared', '--no-checkout', root, fixture], { stdio: 'pipe' });
const app = path.join(fixture, 'app');
await mkdir(app);
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: app, encoding: 'utf8', stdio: 'pipe' }).trim();
git('init');
await writeFile(path.join(app, 'message.txt'), 'hello\n');
git('add', 'message.txt');
git(
  '-c',
  'user.name=Fixture',
  '-c',
  'user.email=fixture@example.test',
  'commit',
  '-m',
  'test: seed fixture',
);
const baseSha = git('rev-parse', 'HEAD');
await writeFile(path.join(app, 'message.txt'), 'hello world\n');
git('add', 'message.txt');
git(
  '-c',
  'user.name=Fixture',
  '-c',
  'user.email=fixture@example.test',
  'commit',
  '-m',
  'test: change greeting',
);
const headSha = git('rev-parse', 'HEAD');
for (const name of ['scripts', 'services', 'packages', 'node_modules'])
  await symlink(path.join(root, name), path.join(fixture, name));
await writeFile(path.join(fixture, 'CLAUDE.md'), '# Isolated workspace validation\n');
const project = path.join(fixture, 'projects/review');
await mkdir(path.join(project, 'shared/review-pr'), { recursive: true });
await writeFile(
  path.join(project, 'shared/review-pr/shared.md'),
  '---\nplatforms: [cli]\n---\n\n# Review greeting\n\n- [ ] Inspect the frozen diff and write the required static review artifacts. This small greeting-only change needs no build, runtime test or external lookup.\n',
);
async function json(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value), { mode: 0o600 });
}
await json(path.join(project, 'project.json'), {
  name: 'review',
  repo_url: app,
  ci: { repo: 'example/app' },
  default_branch: 'main',
  static_review: { template_id: 'review-pr/shared' },
  execution_templates: {
    sources: [{ id: 'workspace:shared', kind: 'workspace', root: { projectPath: 'shared' } }],
  },
  monitoring: { total_timeout_min: 5 },
});
await json(path.join(fixture, 'pool/review.json'), {
  machine: 'review-node',
  host: 'review-node.invalid',
  project: 'review',
  platform: 'cli',
  os: process.platform,
  slots: [],
  review_workspaces: { max_concurrent: 3 },
});
await mkdir(path.join(fixture, 'bin'));
await writeFile(
  path.join(fixture, 'bin/gh'),
  `#!/usr/bin/env node
const args=process.argv.slice(2);
const endpoint=args.find(value=>value.startsWith('repos/example/app/pulls/'));
if(args[0]==='api' && endpoint) {
 if(args.includes('--include')) process.stdout.write('HTTP/2.0 200 OK\\r\\ncontent-type: application/json\\r\\n\\r\\n');
 const data=${JSON.stringify({ number: 42, title: 'Greeting wording', body: 'Change hello to hello world. Review the text change only.', html_url: 'https://github.com/example/app/pull/42', state: 'open', head: { sha: headSha, ref: 'greeting', repo: { full_name: 'example/app' } }, base: { sha: baseSha, ref: 'main' } })}; data.number=Number(endpoint.split('/').pop()); process.stdout.write(JSON.stringify(data)); process.exit(0);
}
if(args[0]==='pr' && args[1]==='view'){process.stdout.write(JSON.stringify({mergeable:'MERGEABLE',mergeStateStatus:'CLEAN'}));process.exit(0);}
process.stderr.write('Unsupported fixture provider request');process.exit(2);
`,
  { mode: 0o755 },
);
const portProbe = createServer();
portProbe.listen(0, '127.0.0.1');
await once(portProbe, 'listening');
const port = (portProbe.address() as { port: number }).port;
await new Promise<void>((resolve, reject) =>
  portProbe.close((error) => (error ? reject(error) : resolve())),
);
const token = randomBytes(32).toString('hex');
const log = path.join(evidence, 'gateway.log');
const fd = openSync(log, 'w', 0o600);
const gateway = spawn('yarn', ['workspace', '@farmslot/gateway', 'start'], {
  cwd: root,
  detached: true,
  stdio: ['ignore', fd, fd],
  env: {
    ...process.env,
    PATH: `${path.join(fixture, 'bin')}${path.delimiter}${process.env.PATH}`,
    FARMSLOT_ROOT: fixture,
    FARMSLOT_HOME: path.join(fixture, 'home'),
    FARMSLOT_PROJECTS_DIR: path.join(fixture, 'projects'),
    FARMSLOT_POOL_DIR: path.join(fixture, 'pool'),
    FARMSLOT_RUNS_DIR: path.join(fixture, 'runs'),
    FARMSLOT_DISPATCH_QUEUE_FILE: path.join(fixture, 'queue.json'),
    GATEWAY_HOST: '127.0.0.1',
    GATEWAY_PORT: String(port),
    FARMSLOT_GATEWAY_TOKEN: token,
    FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID: 'legacy-env',
    FARMSLOT_NATIVE_STATE_DIR: path.join(fixture, 'home/native-sessions'),
    FARMSLOT_DISABLE_ORCHESTRATION: '1',
    FARMSLOT_DISPATCH_PRESSURE_ADMISSION: 'off',
  },
});
closeSync(fd);
let connection: GatewayConnection | undefined;
let nodeProcess: ReturnType<typeof spawn> | undefined;
let nodeToken: string | undefined;
const nodeNativeRoot = path.join(fixture, 'node-home/native-sessions');
const machine = 'review-node';
async function stopChild(child: ReturnType<typeof spawn>) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  const exited = once(child, 'exit');
  process.kill(-child.pid, 'SIGTERM');
  if (!(await Promise.race([exited.then(() => true), delay(5000).then(() => false)]))) {
    process.kill(-child.pid, 'SIGKILL');
    await exited;
  }
}
function startNode() {
  assert(nodeToken);
  const descriptor = openSync(path.join(evidence, 'node.log'), 'a', 0o600);
  const child = spawn('yarn', ['workspace', '@farmslot/node', 'start'], {
    cwd: root,
    detached: true,
    stdio: ['ignore', descriptor, descriptor],
    env: {
      ...process.env,
      FARMSLOT_ROOT: fixture,
      FARMSLOT_HOME: path.join(fixture, 'node-home'),
      FARMSLOT_NATIVE_STATE_DIR: nodeNativeRoot,
      FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID: 'legacy-env',
      FARMSLOT_NODE_TOKEN: nodeToken,
      FARMSLOT_GATEWAY_TOKEN: '',
      GATEWAY_URL: `ws://127.0.0.1:${port}`,
      MACHINE_NAME: machine,
      SCREEN_CONTROL_SOCKET: path.join(fixture, 'screen-control.sock'),
    },
  });
  closeSync(descriptor);
  return child;
}
async function waitForNode(connected: boolean) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const list = await connection!.call<{
      nodes: Array<{ machine: string; pid: number; connectedAt: string }>;
    }>('nodes.list');
    const entry = list.nodes.find((node) => node.machine === machine);
    if (Boolean(entry) === connected) return entry;
    await delay(100);
  }
  throw new Error(`Node did not become ${connected ? 'connected' : 'disconnected'}`);
}
let current: Run | undefined;
const runs: Run[] = [];
let failure: unknown;
try {
  const client = new GatewayClient({
    url: `ws://127.0.0.1:${port}`,
    timeout: 30_000,
    credential: { token },
  });
  const readyBy = Date.now() + 30_000;
  while (!connection && Date.now() < readyBy) {
    if (gateway.exitCode !== null) throw new Error('Isolated gateway exited before readiness');
    try {
      connection = await client.connect();
    } catch (error) {
      if (!(error instanceof GatewayConnectionError)) throw error;
      await delay(200);
    }
  }
  assert(connection, 'Gateway did not become ready');
  const principal = await connection.call<{ principal: { id: string } }>('principal.create', {
    subject: { type: 'node', displayName: 'Isolated workspace review node', machine },
    roles: [],
  });
  await connection.call('principal.bindNativeOwner', {
    nodePrincipalId: principal.principal.id,
    ownerPrincipalId: 'legacy-env',
  });
  const credential = await connection.call<{ secret: string; credential: { id: string } }>(
    'credential.issue',
    {
      principalId: principal.principal.id,
      displayName: 'Isolated review node',
    },
  );
  nodeToken = credential.secret;
  // The production loader prioritizes root env files; scope this credential to the fixture.
  await writeFile(path.join(fixture, '.env.local-auth'), `FARMSLOT_NODE_TOKEN=${nodeToken}\n`, {
    mode: 0o600,
  });
  nodeProcess = startNode();
  const originalNode = await waitForNode(true);
  await json(path.join(evidence, 'node-enrollment.json'), {
    nodePrincipalId: principal.principal.id,
    machine,
    node: originalNode,
    topology: 'separate production node process on same physical host',
  });
  const parameters = {
    project: 'review',
    flowType: 'review-pr',
    mode: 'autonomous',
    reviewWorkspaceTarget: { machine: 'review-node' },
    runner: 'codex',
    model: 'gpt-6-astra',
    effort: 'low',
    transport: 'native',
  };
  for (let index = 0; index < 1; index++) {
    const created = await connection.call<{ run: Run }>('run.create', {
      ...parameters,
      ticketOrPr: `example/app#${42 + index}`,
    });
    runs.push(created.run);
  }
  let restarted = false;
  let originalBinding:
    | NonNullable<NonNullable<Run['agentContexts']>[number]['nativeSession']>
    | undefined;
  const deadline = Date.now() + 6 * 60_000;
  while (Date.now() < deadline) {
    for (let index = 0; index < runs.length; index++) {
      runs[index] = (await connection.call<{ run: Run }>('run.get', { runId: runs[index].id })).run;
      await json(path.join(evidence, 'run.json'), runs[index]);
    }
    current = runs[0];
    const binding = current.agentContexts?.find(
      (context) => context.id === 'review',
    )?.nativeSession;
    if (!restarted && binding?.acceptedAt) {
      originalBinding = structuredClone(binding);
      assert.equal(binding.executionNodeId, machine);
      assert.equal(current.reviewWorkspace?.executionNodeId, machine);
      const nativeTarget = {
        executionNodeId: machine,
        sessionId: binding.sessionId,
        worker: {
          runId: current.id,
          contextId: 'review',
          leaseId: binding.leaseId,
          generation: binding.generation,
        },
      };
      const before = await connection.call<NativeSessionReadResult>(
        'native.session.read',
        nativeTarget,
      );
      await json(path.join(evidence, 'native-before-disconnect.json'), before);
      assert(
        before.commands.some(
          (command) => command.commandId === binding.commandId && command.accepted,
        ),
      );
      assert(nodeProcess);
      await stopChild(nodeProcess);
      await waitForNode(false);
      const during = (await connection.call<{ run: Run }>('run.get', { runId: current.id })).run;
      assert(!['done', 'failed', 'blocked', 'cancelled'].includes(during.status));
      await json(path.join(evidence, 'run-disconnected.json'), during);
      await delay(1500);
      nodeProcess = startNode();
      const replacement = await waitForNode(true);
      assert.notEqual(replacement?.pid, originalNode?.pid);
      const after = await connection.call<NativeSessionReadResult>(
        'native.session.read',
        nativeTarget,
      );
      await json(path.join(evidence, 'native-after-reconnect.json'), after);
      assert.equal(after.session.id, before.session.id);
      assert.equal(after.session.generation, before.session.generation);
      assert.equal(after.session.processPid, before.session.processPid);
      assert.equal(after.session.workerLeaseId, binding.leaseId);
      assert.equal(
        after.commands.filter((command) => command.commandId === binding.commandId).length,
        1,
      );
      await json(path.join(evidence, 'reconnect.json'), {
        originalNode,
        replacement,
        sessionId: binding.sessionId,
        leaseId: binding.leaseId,
        commandId: binding.commandId,
        generation: binding.generation,
        processPid: after.session.processPid,
      });
      restarted = true;
    }
    if (runs.every((run) => ['done', 'failed', 'blocked', 'cancelled'].includes(run.status))) break;
    await delay(1000);
  }
  assert(restarted && originalBinding, 'Node restart must occur during accepted review execution');
  for (const run of runs) {
    const finalBinding = run.agentContexts?.find(
      (context) => context.id === 'review',
    )?.nativeSession;
    assert.equal(finalBinding?.sessionId, originalBinding.sessionId);
    assert.equal(finalBinding?.leaseId, originalBinding.leaseId);
    assert.equal(finalBinding?.commandId, originalBinding.commandId);
    assert.equal(finalBinding?.generation, originalBinding.generation);
    const terminal = await connection.call<NativeSessionReadResult>('native.session.read', {
      executionNodeId: machine,
      sessionId: originalBinding.sessionId,
      worker: {
        runId: run.id,
        contextId: 'review',
        leaseId: originalBinding.leaseId,
        generation: originalBinding.generation,
      },
    });
    assert.equal(
      terminal.commands.filter((command) => command.commandId === originalBinding.commandId).length,
      1,
    );
    assert.equal(
      terminal.commands.find((command) => command.commandId === originalBinding.commandId)?.outcome,
      'completed',
    );
    assert.equal(terminal.session.processStopped, true);
    await json(path.join(evidence, 'native-terminal.json'), terminal);
    assert.equal(run.status, 'done', run.error ?? 'Review did not complete');
    assert.equal(run.slotId, null);
    assert.equal(run.reviewResult?.reviewSnapshot?.headSha, headSha);
    assert(run.reviewResult?.reviewMd.trim());
    assert(run.reviewWorkspace?.cleanedAt);
    await assert.rejects(access(run.reviewWorkspace!.checkoutPath));
    assert.equal(
      await readFile(path.join(path.dirname(run.taskFile!), 'artifacts/review.md'), 'utf8'),
      run.reviewResult!.reviewMd,
    );
    const checklist = await readFile(
      path.join(path.dirname(run.taskFile!), 'CHECKLIST.md'),
      'utf8',
    );
    assert(!checklist.includes('- [ ]'), 'Retained checklist must show completed review work');
    const signal = JSON.parse(
      await readFile(path.join(path.dirname(run.taskFile!), 'SIGNAL.json'), 'utf8'),
    );
    assert(['done', 'complete'].includes(signal.status));
    assert.equal(signal.outcome, 'success');
    await cp(path.dirname(run.taskFile!), path.join(evidence, 'task'), {
      recursive: true,
      dereference: false,
    });
  }
  if (verifyRevocation) {
    await connection.call('credential.revoke', { credentialId: credential.credential.id });
    const rejected = (error: unknown) =>
      error instanceof GatewayRpcError && error.code === 'NATIVE_SESSION_ERROR';
    await assert.rejects(
      connection.call('dispatch.preview', { ...parameters, ticketOrPr: 'example/app#42' }),
      rejected,
    );
    await assert.rejects(
      connection.call('native.session.read', {
        executionNodeId: machine,
        sessionId: originalBinding.sessionId,
        worker: {
          runId: runs[0].id,
          contextId: 'review',
          leaseId: originalBinding.leaseId,
          generation: originalBinding.generation,
        },
      }),
      rejected,
    );
    const after = (await connection.call<{ run: Run }>('run.get', { runId: runs[0].id })).run;
    assert.equal(after.status, 'done', 'Revocation must preserve the completed review outcome');
    await json(path.join(evidence, 'authority-revoked.json'), {
      nodePrincipalId: principal.principal.id,
      credentialId: credential.credential.id,
      newReviewRefused: true,
      nativeSessionReadRefused: true,
      completedOutcomePreserved: true,
    });
  }
  console.log(
    JSON.stringify({
      passed: true,
      runIds: runs.map((run) => run.id),
      scenario: 'remote-node-restart',
      topology: 'separate production node process on same physical host',
      headSha,
      slotsUsed: 0,
      runner: current?.metrics.runner,
      evidence,
    }),
  );
} catch (error) {
  failure = error;
  await json(path.join(evidence, 'failure.json'), {
    error: String(error),
    runId: current?.id,
    fixture,
  });
} finally {
  for (const current of runs.filter((run) => run.status !== 'done')) {
    if (!connection) break;
    try {
      const cancelled = await connection.call<{
        effects: Array<{ status: string; detail?: string }>;
      }>('run.cancel', { runId: current.id, reason: 'Workspace lifecycle validation cleanup' });
      await json(path.join(evidence, 'cancel.json'), cancelled);
      if (cancelled.effects.some((effect) => effect.status === 'failed'))
        throw new Error('Workspace validation cleanup has failed effects');
    } catch (error) {
      failure = new AggregateError(
        [...(failure ? [failure] : []), error],
        'Workspace validation or cleanup failed',
      );
      await json(path.join(evidence, 'cleanup-failure.json'), { error: String(error), fixture });
    }
  }
  connection?.close();
  try {
    if (nodeProcess) await stopChild(nodeProcess);
  } catch (error) {
    failure = new AggregateError(
      [...(failure ? [failure] : []), error],
      'Fixture node cleanup failed',
    );
    await json(path.join(evidence, 'node-cleanup-failure.json'), { error: String(error), fixture });
  }
  const nativeRoot = path.join(nodeNativeRoot, 'nodes', machine);
  try {
    let host: { pid: number } | undefined;
    try {
      host = JSON.parse(await readFile(path.join(nativeRoot, 'host.json'), 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (host && alive(host.pid)) {
      assert(matchesProcess(host.pid, nativeRoot), 'Fixture native supervisor identity changed');
      process.kill(host.pid, 'SIGTERM');
      const stoppedBy = Date.now() + 10_000;
      while (alive(host.pid) && Date.now() < stoppedBy) await delay(100);
      assert(!alive(host.pid), 'Fixture native supervisor did not stop');
    }
  } catch (error) {
    failure = new AggregateError(
      [...(failure ? [failure] : []), error],
      'Fixture native cleanup failed',
    );
    await json(path.join(evidence, 'native-cleanup-failure.json'), {
      error: String(error),
      fixture,
    });
  }
  if (gateway.exitCode === null && gateway.pid) {
    const exited = once(gateway, 'exit');
    process.kill(-gateway.pid, 'SIGTERM');
    if (!(await Promise.race([exited.then(() => true), delay(5000).then(() => false)]))) {
      process.kill(-gateway.pid, 'SIGKILL');
      await exited;
    }
  }
  // Preserve failed fixture state for diagnosis and any unconfirmed native cleanup.
  if (!failure) await rm(fixture, { recursive: true, force: true });
}
if (failure) throw failure;
