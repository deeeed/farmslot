// Same frozen 67-remote-slot workload on base and candidate. Actual loopback node exec, no mocks.
import assert from 'node:assert/strict';
import { type ChildProcess, execFileSync, fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mock } from 'node:test';

import { WebSocket, WebSocketServer } from 'ws';

import { isRecord } from '@farmslot/protocol/recipe';

const root = await mkdtemp(path.join(os.tmpdir(), 'workspace-metadata-proof-'));
const farm = path.join(root, 'farm');
const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const sourceTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim();
const git = (repo: string, ...args: string[]) =>
  execFileSync(
    'git',
    [
      '-C',
      repo,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      ...args,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
const children: ChildProcess[] = [];
const sockets: WebSocket[] = [];
let server: WebSocketServer | undefined;
let unregister: ((socket: WebSocket) => unknown) | undefined;
try {
  for (const dir of ['scripts', 'services/gateway', 'projects/proof', 'pool', 'home', 'runs'])
    await mkdir(path.join(farm, dir), { recursive: true });
  await writeFile(path.join(farm, 'CLAUDE.md'), '# Disposable metadata proof\n');
  await writeFile(path.join(farm, 'scripts/dev.sh'), 'exit 1\n');
  await writeFile(path.join(farm, 'services/gateway/package.json'), '{}');
  await writeFile(
    path.join(farm, 'projects/proof/project.json'),
    '{"name":"proof","default_branch":"main"}',
  );
  Object.assign(process.env, {
    NODE_TEST_CONTEXT: '1',
    FARMSLOT_ROOT: farm,
    FARMSLOT_HOME: path.join(farm, 'home'),
    FARMSLOT_POOL_DIR: path.join(farm, 'pool'),
    FARMSLOT_PROJECTS_DIR: path.join(farm, 'projects'),
    FARMSLOT_RUNS_DIR: path.join(farm, 'runs'),
    FARMSLOT_TEST_STATUS_FILE: path.join(farm, 'status.json'),
  });
  delete process.env.TMUX;
  delete process.env.TMUX_PANE;
  const seed = path.join(root, 'seed');
  await mkdir(seed);
  git(seed, 'init', '-q', '-b', 'main');
  await writeFile(path.join(seed, 'base'), 'base\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-qm', 'fixture base');
  const oldHead = git(seed, 'rev-parse', 'HEAD');
  git(seed, 'checkout', '-qb', 'published');
  await writeFile(path.join(seed, 'feature'), 'feature\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-qm', 'fixture feature');
  const featureHead = git(seed, 'rev-parse', 'HEAD');
  git(seed, 'checkout', '-q', 'main');
  git(seed, 'commit', '--allow-empty', '-qm', 'fixture main');
  git(seed, 'cherry-pick', featureHead);
  const currentHead = git(seed, 'rev-parse', 'HEAD');
  const origin = path.join(root, 'origin.git');
  git(root, 'clone', '-q', '--bare', seed, origin);
  const rows = [];
  const expected = new Map<string, string>();
  for (let node = 0; node < 2; node++) {
    const slots = [];
    const count = node === 0 ? 47 : 20;
    for (let n = 0; n < count; n++) {
      const index = node === 0 ? n : 47 + n;
      const id = `metadata-${node}-${n}`;
      const repo = path.join(root, id);
      git(root, 'clone', '-q', origin, repo);
      const head = index < 40 ? oldHead : index < 47 ? featureHead : currentHead;
      if (index < 40) git(repo, 'reset', '--hard', oldHead);
      else if (index < 47) git(repo, 'checkout', '-q', 'published');
      expected.set(id, head);
      slots.push({ id, repo, session: id });
      rows.push({
        slot: id,
        machine: `metadata-node-${node}`,
        platform: 'cli',
        project: 'proof',
        ssh: 'OK',
        branch: index >= 40 && index < 47 ? 'published' : 'main',
        head_sha: head,
        agent: 'idle',
        enabled: true,
        lifecycle: 'ready',
        slot_epoch: 1,
      });
    }
    await writeFile(
      path.join(farm, `pool/node-${node}.json`),
      JSON.stringify({
        machine: `metadata-node-${node}`,
        host: 'remote.invalid',
        ssh_user: 'fixture',
        platform: 'cli',
        project: 'proof',
        slots,
      }),
    );
  }
  await writeFile(
    path.join(farm, 'status.json'),
    JSON.stringify({ checked_at: new Date().toISOString(), slots: rows }),
  );
  const registry = await import('../fleet/machine-registry.js');
  unregister = registry.unregisterByWs;
  const rpc = await import('../fleet/node-rpc.js');
  server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  let connected = 0;
  let allConnected: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    allConnected = resolve;
  });
  server.on('connection', (socket) => {
    sockets.push(socket);
    socket.setMaxListeners(100); // The fixed 67-slot replay intentionally has concurrent reads.
    socket.on('message', (raw) => {
      const frame: unknown = JSON.parse(String(raw));
      assert.ok(isRecord(frame));
      if (typeof frame.machine === 'string') {
        assert.ok(['metadata-node-0', 'metadata-node-1'].includes(frame.machine));
        assert.equal(typeof frame.pid, 'number');
        registry.registerNode(
          frame.machine,
          Number(frame.pid),
          socket,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          true,
        );
        if (++connected === 2) allConnected();
      } else {
        assert.equal(typeof frame.id, 'string');
        assert.equal(typeof frame.ok, 'boolean');
        rpc.handleNodeResponse(
          String(frame.id),
          frame.ok === true,
          frame.result,
          typeof frame.error === 'string' ? frame.error : undefined,
          undefined,
          socket,
        );
      }
    });
  });
  for (let node = 0; node < 2; node++)
    children.push(
      fork(
        new URL('./workspace-metadata-node.test-support.ts', import.meta.url),
        [`ws://127.0.0.1:${address.port}`, `metadata-node-${node}`],
        { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] },
      ),
    );
  await ready;
  for (let node = 0; node < 2; node++)
    assert.equal(
      (await rpc.nodeExec(`metadata-node-${node}`, 'true', root, { timeout: 10000 })).exitCode,
      0,
    );
  const state = await import('../fleet/state.js');
  const workspace = await import('../methods/slot/workspace.js');
  const metrics = (await import('../observability/performance.js')).gatewayPerformance;
  const fleet = await state.loadFleetStatus(false, true);
  const total = () =>
    metrics
      .snapshot()
      .counters.filter((row) => row.name === 'farmslot_exec_calls_total')
      .reduce((n, row) => n + row.value, 0);
  const before = total();
  const started = performance.now();
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  for (let round = 0; round < 21; round++) {
    if (round) mock.timers.tick(30000);
    const observed = await workspace.enrichFleetWorkspaces(fleet);
    for (const slot of observed.slots) {
      assert.equal(slot.workspace?.headSha, expected.get(slot.slot));
      assert.equal(
        slot.workspace?.publication,
        slot.workspace?.headSha === currentHead ? 'baseline' : 'merged',
        slot.workspaceError ?? slot.workspace?.error,
      );
    }
  }
  mock.timers.tick(30000); // Include the final polling interval in the 630-second window.
  mock.timers.reset();
  const executions = total() - before;
  const nodeStats = await Promise.all(
    children.map(
      (child) =>
        new Promise<unknown>((resolve) => {
          child.once('message', resolve);
          child.send({ type: 'stats' });
        }),
    ),
  );
  const shellsPerMinute = executions / 10.5;
  const enforceBudget = process.argv.includes('--assert-budget');
  for (const stats of nodeStats) assert.ok(isRecord(stats) && typeof stats.executions === 'number');
  const physicalExecutions =
    nodeStats.reduce<number>((sum, stats) => {
      assert.ok(isRecord(stats) && typeof stats.executions === 'number');
      return sum + stats.executions;
    }, 0) - 2;
  assert.equal(
    executions,
    physicalExecutions,
    'gateway accounting matches node executions after the two warmups',
  );
  console.log(
    JSON.stringify(
      {
        sourceHead,
        sourceTree,
        slots: 67,
        nodes: 2,
        mix: { mergedAncestor: 40, mergedPatch: 7, baseline: 20 },
        rounds: 21,
        logicalSeconds: 630,
        wallSeconds: (performance.now() - started) / 1000,
        executions,
        shellsPerLogicalMinute: shellsPerMinute,
        nodeStats,
        result: !enforceBudget || shellsPerMinute <= 115 ? 'PASS' : 'FAIL',
      },
      null,
      2,
    ),
  );
  if (enforceBudget)
    assert.ok(shellsPerMinute <= 115, `metadata reuse shell budget exceeded: ${shellsPerMinute}`);
} finally {
  mock.timers.reset();
  for (const socket of sockets) unregister?.(socket);
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const closed = once(child, 'exit', { signal: AbortSignal.timeout(10000) });
    if (child.connected) child.send({ type: 'shutdown' });
    else child.kill('SIGTERM');
    await closed;
  }
  await new Promise<void>((resolve, reject) =>
    server ? server.close((error) => (error ? reject(error) : resolve())) : resolve(),
  );
  await rm(root, { recursive: true, force: true });
}
