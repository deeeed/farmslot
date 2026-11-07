import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test, type TestContext } from 'node:test';

import { WebSocket, WebSocketServer } from 'ws';

import { type NodeLinkAuthority, NodeLinkFailure, PROTOCOL_VERSION } from '@farmslot/protocol';

import { NodeLinkAgent } from '../../../node/src/link/agent.js';

const suiteRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'node-link-rpc-suite-')));
const previousPool = process.env.FARMSLOT_POOL_DIR;
process.env.FARMSLOT_POOL_DIR = path.join(suiteRoot, 'pool');
await mkdir(process.env.FARMSLOT_POOL_DIR);
process.env.NODE_TEST_CONTEXT = '1';
process.env.FARMSLOT_TEST_STATUS_FILE = path.join(suiteRoot, 'status.json');
process.env.FARMSLOT_RUNS_DIR = path.join(suiteRoot, 'runs');
process.env.FARMSLOT_PROJECTS_DIR = path.join(suiteRoot, 'projects');
after(async () => {
  if (previousPool === undefined) delete process.env.FARMSLOT_POOL_DIR;
  else process.env.FARMSLOT_POOL_DIR = previousPool;
  await rm(suiteRoot, { recursive: true, force: true });
});
const { registerNode, unregisterByWs } = await import('./machine-registry.js');
const { acceptNodeLinkStream, invokeNodeLink } = await import('./node-link.js');
const { handleNodeResponse } = await import('./node-rpc.js');

test('typed node link streams real argv output and reuses the durable receipt without executing twice', async (t) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'node-link-rpc-')));
  const previousHome = process.env.FARMSLOT_HOME;
  process.env.FARMSLOT_HOME = root;
  const machine = 'node-link-rpc-fixture';
  const { principal } = await linkedNode(t, root, machine);
  t.after(async () => {
    if (previousHome === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  });
  const authority: NodeLinkAuthority = {
    requester: { principalId: 'operator', generation: 1 },
    executor: principal,
    grantId: 'process-policy',
    approvalId: 'fixture-approval',
    approval: 'framework',
  };
  let output = '';
  const invocation = {
    commandId: 'retained-process-command',
    target: { nodeId: machine, resourceId: 'fixture-process' },
    authority,
    assertCurrent: () => undefined,
    onOutput: (_stream: 'stdout' | 'stderr', data: string) => {
      output += data;
    },
  };
  const request = {
    operation: 'process.run' as const,
    input: {
      argv: [process.execPath, '-e', 'process.stdout.write("NODE_LINK_REAL_PROCESS")'],
      cwd: root,
      timeoutMs: 1000,
      maxOutputBytes: 1024,
    },
  };
  await writeFile(
    path.join(suiteRoot, 'pool', `${machine}.json`),
    JSON.stringify({ machine, env: {} }),
  );
  await assert.rejects(invokeNodeLink(request, invocation), { code: 'NODE_LINK_DISABLED' });
  assert.equal(output, '');
  await writeFile(
    path.join(suiteRoot, 'pool', `${machine}.json`),
    JSON.stringify({ machine, env: { FARMSLOT_NODE_LINK_ENABLED: '1' } }),
  );
  const receipt = await invokeNodeLink(request, invocation);
  assert.equal(receipt.state, 'completed');
  assert.equal(receipt.closeoutConfirmed, true);
  assert.equal(output, 'NODE_LINK_REAL_PROCESS');
  assert.deepEqual(receipt.result, { exitCode: 0, stdout: output, stderr: '' });
  // A repeat cannot emit another process output frame; it reads the settled outcome.
  output = '';
  assert.deepEqual(await invokeNodeLink(request, invocation), receipt);
  assert.equal(output, '');
  await assert.rejects(
    invokeNodeLink(
      {
        ...request,
        input: { ...request.input, argv: [process.execPath, '-e', 'process.exit(9)'] },
      },
      invocation,
    ),
    { code: 'IDEMPOTENCY_CONFLICT' },
  );
});

async function linkedNode(
  t: TestContext,
  root: string,
  machine: string,
  dropCommandReply = false,
  fileReadFixture?: string,
  replyDelayMs = 0,
) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const accepted = new Promise<WebSocket>((resolve) => server.once('connection', resolve));
  const nodeSocket = new WebSocket(`ws://127.0.0.1:${address.port}`);
  const gatewaySocket = await accepted;
  await new Promise<void>((resolve) => nodeSocket.once('open', resolve));
  await writeFile(
    path.join(suiteRoot, 'pool', `${machine}.json`),
    JSON.stringify({ machine, env: { FARMSLOT_NODE_LINK_ENABLED: '1' } }),
  );
  const principal = { principalId: 'node-fixture', generation: 0 };
  const agent = new NodeLinkAgent(
    path.join(root, 'receipts'),
    machine,
    principal,
    () => nodeSocket.readyState === WebSocket.OPEN,
    (frame) => {
      nodeSocket.send(JSON.stringify(frame));
      return true;
    },
  );
  t.after(async () => {
    await agent.retire();
    unregisterByWs(gatewaySocket);
    nodeSocket.terminate();
    gatewaySocket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const calls: Array<{ method: string; params: unknown }> = [];
  nodeSocket.on('message', async (raw) => {
    const frame = JSON.parse(raw.toString());
    calls.push({ method: frame.method, params: frame.params });
    try {
      const payload =
        frame.method === 'fs.read' && fileReadFixture !== undefined
          ? { content: fileReadFixture }
          : await agent.handle(frame.method, frame.params);
      if (replyDelayMs && frame.method === 'node.link.command')
        await new Promise<void>((resolve) => setTimeout(resolve, replyDelayMs));
      if (!dropCommandReply || frame.method !== 'node.link.command')
        nodeSocket.send(JSON.stringify({ type: 'res', id: frame.id, ok: true, payload }));
    } catch (error) {
      nodeSocket.send(
        JSON.stringify({
          type: 'res',
          id: frame.id,
          ok: false,
          error: {
            code: error instanceof NodeLinkFailure ? error.code : 'EXECUTION_FAILED',
            message: error instanceof Error ? error.message : String(error),
          },
        }),
      );
    }
  });
  gatewaySocket.on('message', (raw) => {
    const frame = JSON.parse(raw.toString());
    if (frame.type === 'res')
      handleNodeResponse(
        frame.id,
        frame.ok,
        frame.payload,
        frame.error?.message,
        frame.error?.code,
        gatewaySocket,
      );
    else if (frame.event === 'node.link.stream') acceptNodeLinkStream(gatewaySocket, frame.payload);
  });
  registerNode(
    machine,
    process.pid,
    gatewaySocket,
    PROTOCOL_VERSION,
    PROTOCOL_VERSION,
    undefined,
    undefined,
    undefined,
    true,
    undefined,
    () => true,
    true,
    true,
    {
      node: { protocolVersion: PROTOCOL_VERSION },
      nodeLink: agent.capabilities,
      nodePrincipal: principal,
    },
  );
  return { agent, principal, calls };
}

test('flagged task staging uses node commands, preserves existing artifacts and publishes executable marker last', async (t) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'node-link-task-')));
  const previousHome = process.env.FARMSLOT_HOME;
  process.env.FARMSLOT_HOME = root;
  const machine = 'node-link-task-fixture';
  const { calls } = await linkedNode(t, root, machine);
  t.after(async () => {
    if (previousHome === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  });
  const task = path.join(root, 'source'),
    workspace = path.join(root, 'workspace');
  await mkdir(path.join(task, 'inputs'), { recursive: true });
  await mkdir(path.join(task, 'artifacts'));
  await mkdir(path.join(workspace, 'tasks/task/artifacts'), { recursive: true });
  await writeFile(path.join(task, 'TASK.md'), '# Task');
  await writeFile(path.join(task, 'CHECKLIST.md'), '- [ ] one');
  await writeFile(path.join(task, 'mark'), '#!/bin/sh\nexit 0\n', { mode: 0o644 });
  await writeFile(path.join(task, 'inputs/input.json'), '{"frozen":true}');
  await writeFile(path.join(task, 'inputs/checklist.md.worker'), 'gateway mirror must stay here');
  await writeFile(path.join(task, 'artifacts/existing.txt'), 'gateway must not overwrite');
  await writeFile(path.join(workspace, 'tasks/task/artifacts/existing.txt'), 'node-owned');
  const { createRun } = await import('../runs/store.js');
  const run = createRun(
    {
      project: 'fixture',
      flowType: 'dev',
      ticketOrPr: 'Node task staging',
      slotId: 'fixture-slot',
      taskFile: path.join(task, 'TASK.md'),
      runner: 'codex',
      completionPolicy: 'artifact-only',
      pipelineReview: 'none',
    },
    { deferBackgroundPersist: true },
  );
  await writeFile(
    path.join(suiteRoot, 'status.json'),
    JSON.stringify({ slots: [{ slot: run.slotId, slot_epoch: 1, current_run_id: run.id }] }),
  );
  const { makeVars } = await import('../runners/test-fixtures.js');
  const { copyTaskThroughNodeLink } = await import('./node-link-task-copy.js');
  const vars = makeVars({
    slotId: 'fixture-slot',
    machine,
    host: 'remote.invalid',
    repo: workspace,
    remoteRepo: workspace,
  });
  await copyTaskThroughNodeLink(run, vars, task, path.join(workspace, 'tasks/task'));
  assert.equal(await readFile(path.join(workspace, 'tasks/task/TASK.md'), 'utf8'), '# Task');
  await assert.rejects(readFile(path.join(workspace, 'tasks/task/inputs/checklist.md.worker')), {
    code: 'ENOENT',
  });
  assert.equal(
    await readFile(path.join(workspace, 'tasks/task/inputs/input.json'), 'utf8'),
    '{"frozen":true}',
  );
  assert.equal(
    await readFile(path.join(workspace, 'tasks/task/artifacts/existing.txt'), 'utf8'),
    'node-owned',
  );
  assert.equal((await stat(path.join(workspace, 'tasks/task/mark'))).mode & 0o777, 0o755);
  const writes = calls.flatMap((call) => {
    const value = call.params;
    if (
      call.method !== 'node.link.command' ||
      !value ||
      typeof value !== 'object' ||
      !('operation' in value) ||
      value.operation !== 'file.write-files' ||
      !('input' in value) ||
      !value.input ||
      typeof value.input !== 'object' ||
      !('files' in value.input) ||
      !Array.isArray(value.input.files)
    )
      return [];
    return value.input.files.map((file: { path: string }) => file.path);
  });
  assert.equal(writes.at(-1), 'tasks/task/mark');
  assert(
    calls.every((call) => call.method.startsWith('node.link.')),
    'Task staging must not use the legacy exec or SSH adapters',
  );
  const { updateSlotStatus } = await import('../core/state.js');
  const { createNodeLinkTaskStager } = await import('./node-link-task-copy.js');
  const stager = await createNodeLinkTaskStager(
    { runId: run.id, taskFile: run.taskFile! },
    vars,
    task,
    path.join(workspace, 'tasks/task'),
  );
  await updateSlotStatus('fixture-slot', { slot_epoch: 2, current_run_id: 'successor' });
  const beforeStaleWrite = calls.length;
  await assert.rejects(stager.upload(path.join(task, 'TASK.md'), 'TASK.md', false), {
    code: 'STALE_AUTHORITY',
  });
  assert.equal(calls.length, beforeStaleWrite);
});

test(
  'real WebSocket PTY confirms start, resize, streamed data and cancelled closeout',
  { timeout: 10_000 },
  async (t) => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'node-link-pty-rpc-')));
    const previousHome = process.env.FARMSLOT_HOME;
    process.env.FARMSLOT_HOME = root;
    const machine = 'node-link-pty-fixture';
    const { principal } = await linkedNode(t, root, machine);
    t.after(async () => {
      if (previousHome === undefined) delete process.env.FARMSLOT_HOME;
      else process.env.FARMSLOT_HOME = previousHome;
      await rm(root, { recursive: true, force: true });
    });
    const controller = new AbortController();
    t.after(() => controller.abort());
    let started!: () => void;
    let readable!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const data = new Promise<void>((resolve) => {
      readable = resolve;
    });
    let command: import('@farmslot/protocol').NodeLinkCommand | undefined;
    let text = '';
    const result = invokeNodeLink(
      {
        operation: 'process.run',
        input: {
          argv: [
            process.execPath,
            '-e',
            'process.stdout.write("PTY_BEGIN");process.on("SIGWINCH",()=>process.stdout.write("COLS="+process.stdout.columns));setInterval(()=>{},1000)',
          ],
          cwd: root,
          timeoutMs: 5000,
          maxOutputBytes: 65536,
          terminal: { cols: 80, rows: 24 },
        },
      },
      {
        commandId: 'pty-command',
        target: { nodeId: machine, resourceId: 'pty-observer' },
        authority: {
          requester: { principalId: 'operator', generation: 1 },
          executor: principal,
          grantId: 'pty-policy',
          approvalId: 'pty-approval',
          approval: 'framework',
        },
        assertCurrent: () => undefined,
        signal: controller.signal,
        timeoutMs: 6000,
        onStarted: (value) => {
          command = value;
          started();
        },
        onOutput: (_stream, value) => {
          text += value;
          if (text.includes('PTY_BEGIN')) readable();
        },
      },
    );
    await ready;
    await data;
    const { getNode } = await import('./machine-registry.js');
    const { sendNodeRequest } = await import('./node-rpc.js');
    const node = getNode(machine);
    assert(node);
    await sendNodeRequest(
      node,
      'node.link.terminal.resize',
      { command, size: { cols: 110, rows: 30 } },
      { requireSameConnection: true },
    );
    controller.abort();
    const receipt = await result;
    assert.equal(receipt.state, 'cancelled');
    assert.equal(receipt.closeoutConfirmed, true);
    assert.match(text, /PTY_BEGIN/);
  },
);

test(
  'lost mutation reply preserves the lifecycle unconfirmed-closeout contract and reconciles without replay',
  { timeout: 10_000 },
  async (t) => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'node-link-lost-reply-')));
    const previousHome = process.env.FARMSLOT_HOME;
    process.env.FARMSLOT_HOME = root;
    const machine = 'node-link-lost-reply-fixture';
    const { principal } = await linkedNode(t, root, machine, true);
    t.after(async () => {
      if (previousHome === undefined) delete process.env.FARMSLOT_HOME;
      else process.env.FARMSLOT_HOME = previousHome;
      await rm(root, { recursive: true, force: true });
    });
    const { NodeExecUnconfirmedError } = await import('./node-rpc.js');
    const request = {
      operation: 'file.write' as const,
      input: { root, relPath: 'once.txt', content: 'once', expectedHash: null },
    };
    const invocation = {
      commandId: 'lost-mutation',
      target: { nodeId: machine, resourceId: 'workspace' },
      root,
      authority: {
        requester: { principalId: 'operator', generation: 1 },
        executor: principal,
        grantId: 'file-policy',
        approvalId: 'file-approval',
        approval: 'framework' as const,
      },
      timeoutMs: 1000,
      assertCurrent: () => undefined,
    };
    await assert.rejects(invokeNodeLink(request, invocation), NodeExecUnconfirmedError);
    assert.equal(await readFile(path.join(root, 'once.txt'), 'utf8'), 'once');
    const receipt = await invokeNodeLink(request, invocation);
    assert.equal(receipt.state, 'completed');
    assert.equal(receipt.closeoutConfirmed, true);
  },
);

test(
  'failed output consumer cancels its producer and retains confirmed closeout',
  { timeout: 5000 },
  async (t) => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'node-link-consumer-failure-')));
    const previousHome = process.env.FARMSLOT_HOME;
    process.env.FARMSLOT_HOME = root;
    const machine = 'node-link-consumer-failure';
    const { principal } = await linkedNode(t, root, machine);
    t.after(async () => {
      if (previousHome === undefined) delete process.env.FARMSLOT_HOME;
      else process.env.FARMSLOT_HOME = previousHome;
      await rm(root, { recursive: true, force: true });
    });
    const commandId = 'consumer-failure';
    const failure = new Error('Owned fixture consumer failed');
    await assert.rejects(
      invokeNodeLink(
        {
          operation: 'process.run',
          input: {
            argv: [
              process.execPath,
              '-e',
              'process.stdout.write("x".repeat(100000));setInterval(()=>{},1000)',
            ],
            cwd: root,
            timeoutMs: 1000,
            maxOutputBytes: 1024 * 1024,
          },
        },
        {
          commandId,
          target: { nodeId: machine, resourceId: 'process' },
          authority: {
            requester: { principalId: 'operator', generation: 1 },
            executor: principal,
            grantId: 'process-policy',
            approvalId: 'process-approval',
            approval: 'framework',
          },
          assertCurrent: () => undefined,
          timeoutMs: 2000,
          onOutput: () => {
            throw failure;
          },
        },
      ),
      (error: unknown) => error === failure,
    );
    const { createHash } = await import('node:crypto');
    const stored = JSON.parse(
      await readFile(
        path.join(
          root,
          'node-link-intents',
          machine,
          createHash('sha256').update(commandId).digest('hex') + '.json',
        ),
        'utf8',
      ),
    );
    assert.equal(stored.receipt.state, 'cancelled');
    assert.equal(stored.receipt.closeoutConfirmed, true);
  },
);

test(
  'changed resource authority stops stream delivery before applying successor output',
  { timeout: 5000 },
  async (t) => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'node-link-stream-authority-')));
    const previousHome = process.env.FARMSLOT_HOME;
    process.env.FARMSLOT_HOME = root;
    const machine = 'node-link-stream-authority';
    const { principal } = await linkedNode(t, root, machine);
    t.after(async () => {
      if (previousHome === undefined) delete process.env.FARMSLOT_HOME;
      else process.env.FARMSLOT_HOME = previousHome;
      await rm(root, { recursive: true, force: true });
    });
    let current = true;
    let applied = 0;
    await assert.rejects(
      invokeNodeLink(
        {
          operation: 'process.run',
          input: {
            argv: [process.execPath, '-e', 'setInterval(()=>process.stdout.write("chunk"),10)'],
            cwd: root,
            timeoutMs: 1000,
            maxOutputBytes: 65536,
          },
        },
        {
          commandId: 'authority-output',
          target: { nodeId: machine, resourceId: 'leased-workspace' },
          authority: {
            requester: { principalId: 'operator', generation: 1 },
            executor: principal,
            grantId: 'process-policy',
            approvalId: 'process-approval',
            approval: 'framework',
          },
          timeoutMs: 2000,
          assertCurrent: () => {
            if (!current)
              throw new NodeLinkFailure('STALE_AUTHORITY', 'Owned fixture lease changed');
          },
          onOutput: () => {
            applied++;
            current = false;
          },
        },
      ),
      { code: 'STALE_AUTHORITY' },
    );
    assert.equal(applied, 1);
  },
);

test('gateway-local pilot resolves node support on its execution node', async () => {
  const machine = 'node-link-colocated-support';
  await writeFile(
    path.join(suiteRoot, 'pool', `${machine}.json`),
    JSON.stringify({ machine, env: { FARMSLOT_NODE_LINK_ENABLED: '1' } }),
  );
  const { makeVars } = await import('../runners/test-fixtures.js');
  const { selectedNodeSupportDir } = await import('../node-support/ensure.js');
  let calls = 0;
  const selected = await selectedNodeSupportDir(
    makeVars({ machine, host: '127.0.0.1' }),
    '.agent',
    undefined,
    {
      exec: async () => {
        calls++;
        return { exitCode: 0, stdout: '/node/support/exact-source', stderr: '' };
      },
    },
  );
  assert.equal(selected, '/node/support/exact-source');
  assert.equal(calls, 1);
});

test(
  'output exceeding stream credit drains with integrity while metadata remains usable',
  { timeout: 10_000 },
  async (t) => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'node-link-bulk-')));
    const previousHome = process.env.FARMSLOT_HOME;
    process.env.FARMSLOT_HOME = root;
    const machine = 'node-link-bulk-fixture';
    const { principal } = await linkedNode(t, root, machine);
    t.after(async () => {
      if (previousHome === undefined) delete process.env.FARMSLOT_HOME;
      else process.env.FARMSLOT_HOME = previousHome;
      await rm(root, { recursive: true, force: true });
    });
    const { inspectNodeLinkPrograms } = await import('./node-link.js');
    let metadata: Promise<unknown> | undefined;
    let delivered = 0;
    const receipt = await invokeNodeLink(
      {
        operation: 'process.run',
        input: {
          argv: [
            process.execPath,
            '-e',
            'process.stdout.write("X".repeat(600000));process.stderr.write("Y".repeat(500000))',
          ],
          cwd: root,
          timeoutMs: 5000,
          maxOutputBytes: 2 * 1024 * 1024,
        },
      },
      {
        commandId: 'bulk-output',
        target: { nodeId: machine, resourceId: 'bulk-process' },
        authority: {
          requester: { principalId: 'operator', generation: 1 },
          executor: principal,
          grantId: 'bulk-policy',
          approvalId: 'bulk-approval',
          approval: 'framework',
        },
        assertCurrent: () => undefined,
        timeoutMs: 6000,
        onOutput: (_stream, text) => {
          delivered += Buffer.byteLength(text);
          metadata ??= inspectNodeLinkPrograms(machine, ['node']);
        },
      },
    );
    assert(metadata);
    await metadata;
    assert.equal(receipt.state, 'completed');
    assert.equal(delivered, 1_100_000);
    const result = receipt.result;
    assert(
      result &&
        typeof result === 'object' &&
        'stdout' in result &&
        typeof result.stdout === 'string' &&
        'stderr' in result &&
        typeof result.stderr === 'string',
    );
    assert.equal(result.stdout.length, 600000);
    assert.equal(result.stderr.length, 500000);
    assert.equal(result.stdout.replaceAll('X', ''), '');
    assert.equal(result.stderr.replaceAll('Y', ''), '');
  },
);

test('explicit account import uses the connected pilot node without reading real credentials', async (t) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'node-link-import-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const machine = 'node-link-import-fixture';
  const fixture = '{"version":1,"profiles":{}}';
  const { calls } = await linkedNode(t, root, machine, false, fixture);
  const { userInfo } = await import('node:os');
  await writeFile(
    path.join(suiteRoot, 'pool', `${machine}.json`),
    JSON.stringify({
      machine,
      host: `${machine}.invalid`,
      ssh_user: userInfo().username,
      env: { FARMSLOT_NODE_LINK_ENABLED: '1' },
      slots: [],
    }),
  );
  const { importRemoteOpenClaw } = await import('../llm/auth-resolve.js');
  assert.deepEqual(
    await importRemoteOpenClaw(`${machine}.invalid`, userInfo().username),
    JSON.parse(fixture),
  );
  assert.deepEqual(
    calls.filter((call) => call.method === 'fs.read').map((call) => call.params),
    [{ root: '~', relPath: '.openclaw/agents/main/agent/auth-profiles.json' }],
  );
});

test('repeated task staging applies A to B to A rather than reusing an old completed receipt', async (t) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'node-link-task-generations-')));
  const previousHome = process.env.FARMSLOT_HOME;
  process.env.FARMSLOT_HOME = root;
  const machine = 'node-link-task-generations';
  await linkedNode(t, root, machine);
  t.after(async () => {
    if (previousHome === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  });
  const { makeVars } = await import('../runners/test-fixtures.js');
  const { createNodeLinkTaskStager } = await import('./node-link-task-copy.js');
  const slotId = 'staging-generation-slot';
  await writeFile(
    path.join(suiteRoot, 'status.json'),
    JSON.stringify({ slots: [{ slot: slotId, slot_epoch: 1 }] }),
  );
  const task = path.join(root, 'source');
  const workspace = path.join(root, 'workspace');
  await mkdir(task);
  await mkdir(workspace);
  const source = path.join(task, 'TASK.md');
  const vars = makeVars({
    slotId,
    machine,
    host: 'remote.invalid',
    repo: workspace,
    remoteRepo: workspace,
  });
  for (const content of ['A', 'B', 'A']) {
    await writeFile(source, content);
    const stager = await createNodeLinkTaskStager(
      { taskFile: source },
      vars,
      task,
      path.join(workspace, 'tasks/task'),
    );
    await stager.upload(source, 'TASK.md', false);
    assert.equal(await readFile(path.join(workspace, 'tasks/task/TASK.md'), 'utf8'), content);
  }
});

test('a process timeout returns its confirmed result after teardown rather than a transport timeout', async (t) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'node-link-deadline-')));
  const previousHome = process.env.FARMSLOT_HOME;
  process.env.FARMSLOT_HOME = root;
  const machine = 'node-link-deadline';
  const { principal } = await linkedNode(t, root, machine);
  t.after(async () => {
    if (previousHome === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  });
  const receipt = await invokeNodeLink(
    {
      operation: 'process.run',
      input: {
        argv: [process.execPath, '-e', 'setInterval(()=>{},1000)'],
        cwd: root,
        timeoutMs: 100,
        maxOutputBytes: 1024,
      },
    },
    {
      commandId: 'process-deadline',
      target: { nodeId: machine, resourceId: 'process' },
      authority: {
        requester: { principalId: 'operator', generation: 1 },
        executor: principal,
        grantId: 'policy',
        approvalId: 'approval',
        approval: 'framework',
      },
      assertCurrent: () => undefined,
      timeoutMs: 100,
    },
  );
  assert.equal(receipt.closeoutConfirmed, true);
  assert(receipt.result && typeof receipt.result === 'object' && 'exitCode' in receipt.result);
  assert.equal(receipt.result.exitCode, 124);
});

test('historical completed task can stage artifacts after an explicit destination claim', async (t) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'node-link-historical-bind-')));
  const previousHome = process.env.FARMSLOT_HOME;
  process.env.FARMSLOT_HOME = root;
  const machine = 'node-link-historical-bind';
  await linkedNode(t, root, machine);
  t.after(async () => {
    if (previousHome === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  });
  const { createRun, updateRun } = await import('../runs/store.js');
  const { makeVars } = await import('../runners/test-fixtures.js');
  const { copyTaskThroughNodeLink } = await import('./node-link-task-copy.js');
  const task = path.join(root, 'source');
  const destination = path.join(root, 'destination');
  await mkdir(path.join(task, 'artifacts'), { recursive: true });
  await mkdir(destination);
  await writeFile(path.join(task, 'TASK.md'), 'Historical task');
  await writeFile(path.join(task, 'artifacts/report.md'), 'Retained proof');
  const run = createRun(
    {
      project: 'fixture',
      flowType: 'dev',
      ticketOrPr: 'Historical bind',
      slotId: 'original-slot',
      taskFile: path.join(task, 'TASK.md'),
      runner: 'codex',
      completionPolicy: 'artifact-only',
      pipelineReview: 'none',
    },
    { deferBackgroundPersist: true },
  );
  updateRun(run.id, { status: 'done' });
  const vars = makeVars({
    slotId: 'destination-slot',
    machine,
    host: 'remote.invalid',
    repo: destination,
    remoteRepo: destination,
  });
  await writeFile(
    path.join(suiteRoot, 'status.json'),
    JSON.stringify({ slots: [{ slot: vars.slotId, slot_epoch: 1, current_run_id: run.id }] }),
  );
  await copyTaskThroughNodeLink(run, vars, task, path.join(destination, 'tasks/task'), true);
  assert.equal(
    await readFile(path.join(destination, 'tasks/task/artifacts/report.md'), 'utf8'),
    'Retained proof',
  );
  await assert.rejects(readFile(path.join(destination, 'tasks/task/TASK.md')), { code: 'ENOENT' });
  await writeFile(
    path.join(suiteRoot, 'status.json'),
    JSON.stringify({
      slots: [{ slot: vars.slotId, slot_epoch: 1, current_run_id: 'another-run' }],
    }),
  );
  await assert.rejects(
    copyTaskThroughNodeLink(run, vars, task, path.join(destination, 'tasks/task'), true),
    { code: 'STALE_AUTHORITY' },
  );
});

test(
  'authored process cancellation retains its thirty-second cleanup budget',
  { timeout: 15_000 },
  async (t) => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'node-link-long-closeout-')));
    const previousHome = process.env.FARMSLOT_HOME;
    process.env.FARMSLOT_HOME = root;
    const machine = 'node-link-long-closeout';
    const { principal } = await linkedNode(t, root, machine);
    const controller = new AbortController();
    t.after(() => controller.abort());
    t.after(async () => {
      if (previousHome === undefined) delete process.env.FARMSLOT_HOME;
      else process.env.FARMSLOT_HOME = previousHome;
      await rm(root, { recursive: true, force: true });
    });
    const cleanup = path.join(root, 'cleanup-complete');
    const receipt = await invokeNodeLink(
      {
        operation: 'process.run',
        input: {
          argv: [
            process.execPath,
            '-e',
            'const fs=require("node:fs");process.on("SIGTERM",()=>setTimeout(()=>{fs.writeFileSync(process.argv[1],"closed");process.exit(0)},6000));process.stdout.write("READY");setInterval(()=>{},1000)',
            cleanup,
          ],
          cwd: root,
          timeoutMs: 10000,
          closeoutTimeoutMs: 30_000,
          maxOutputBytes: 1024,
        },
      },
      {
        commandId: 'long-closeout',
        target: { nodeId: machine, resourceId: 'recipe' },
        authority: {
          requester: { principalId: 'operator', generation: 1 },
          executor: principal,
          grantId: 'policy',
          approvalId: 'approval',
          approval: 'framework',
        },
        assertCurrent: () => undefined,
        timeoutMs: 10000,
        signal: controller.signal,
        onOutput: () => controller.abort(),
      },
    );
    assert.equal(receipt.state, 'cancelled');
    assert.equal(receipt.closeoutConfirmed, true);
    assert.equal(await readFile(cleanup, 'utf8'), 'closed');
  },
);

test(
  'a late original response resolves the unconfirmed closeout on the same socket',
  { timeout: 9000 },
  async (t) => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'node-link-late-closeout-')));
    const previousHome = process.env.FARMSLOT_HOME;
    process.env.FARMSLOT_HOME = root;
    const machine = 'node-link-late-closeout';
    const { principal } = await linkedNode(t, root, machine, false, undefined, 5500);
    t.after(async () => {
      if (previousHome === undefined) delete process.env.FARMSLOT_HOME;
      else process.env.FARMSLOT_HOME = previousHome;
      await rm(root, { recursive: true, force: true });
    });
    const { NodeExecUnconfirmedError } = await import('./node-rpc.js');
    let unconfirmed: InstanceType<typeof NodeExecUnconfirmedError> | undefined;
    try {
      await invokeNodeLink(
        {
          operation: 'file.write',
          input: { root, relPath: 'once', content: 'written', expectedHash: null },
        },
        {
          commandId: 'late-closeout',
          target: { nodeId: machine, resourceId: 'workspace' },
          root,
          timeoutMs: 100,
          authority: {
            requester: { principalId: 'operator', generation: 1 },
            executor: principal,
            grantId: 'policy',
            approvalId: 'approval',
            approval: 'framework',
          },
          assertCurrent: () => undefined,
        },
      );
      assert.fail('Expected the deliberately delayed exchange to time out');
    } catch (error) {
      assert(error instanceof NodeExecUnconfirmedError);
      unconfirmed = error;
    }
    await unconfirmed.closeout;
    assert.equal(await readFile(path.join(root, 'once'), 'utf8'), 'written');
  },
);

test('pruned gateway intents cannot renew an expired command key and repeat its effect', async (t) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'node-link-expired-key-')));
  const previousHome = process.env.FARMSLOT_HOME;
  process.env.FARMSLOT_HOME = root;
  const machine = 'node-link-expired-key';
  const { principal } = await linkedNode(t, root, machine);
  t.after(async () => {
    if (previousHome === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  });
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const { createNodeLinkCommandId, inspectNodeLinkPrograms } = await import('./node-link.js');
  const { createHash } = await import('node:crypto');
  const commandId = createNodeLinkCommandId(1000);
  const request = {
    operation: 'file.write' as const,
    input: { root, relPath: 'once', content: 'first', expectedHash: null },
  };
  const invocation = {
    commandId,
    target: { nodeId: machine, resourceId: 'workspace' },
    root,
    authority: {
      requester: { principalId: 'operator', generation: 1 },
      executor: principal,
      grantId: 'once',
      approvalId: 'once',
      approval: 'framework' as const,
    },
    assertCurrent: () => undefined,
  };
  await invokeNodeLink(request, invocation);
  t.mock.timers.tick(10 * 60_000);
  await inspectNodeLinkPrograms(machine, ['node']);
  const intent = path.join(
    root,
    'node-link-intents',
    machine,
    createHash('sha256').update(commandId).digest('hex') + '.json',
  );
  await assert.rejects(readFile(intent), { code: 'ENOENT' });
  await assert.rejects(invokeNodeLink(request, invocation), { code: 'COMMAND_EXPIRED' });
  assert.equal(await readFile(path.join(root, 'once'), 'utf8'), 'first');
});
