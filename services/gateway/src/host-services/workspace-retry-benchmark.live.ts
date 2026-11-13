// Isolated unavailable-checkout replay. Clock offsets exercise retry deadlines without waits.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(os.tmpdir(), 'workspace-retry-benchmark-'));
const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const originalNow = Date.now;
let offset = 0;
let background: typeof import('./background/client.js').backgroundHost | undefined;
try {
  for (const dir of ['scripts', 'services/gateway', 'projects/proof', 'pool', 'home', 'runs'])
    await mkdir(path.join(root, dir), { recursive: true });
  await writeFile(path.join(root, 'CLAUDE.md'), '# Disposable retry fixture\n');
  await writeFile(path.join(root, 'scripts/dev.sh'), 'exit 1\n');
  await writeFile(path.join(root, 'services/gateway/package.json'), '{}');
  await writeFile(
    path.join(root, 'projects/proof/project.json'),
    JSON.stringify({ name: 'proof', default_branch: 'main' }),
  );
  const slots = [];
  const rows = [];
  for (let i = 0; i < 8; i++) {
    const id = `unavailable-${i}`;
    const repo = path.join(root, id);
    await mkdir(repo);
    // An incomplete checkout has stable metadata but cannot produce verified HEAD evidence.
    execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main']);
    slots.push({ id, repo, session: id });
    rows.push({
      slot: id,
      machine: 'fixture',
      project: 'proof',
      platform: 'cli',
      ssh: 'LOCAL',
      branch: '-',
      agent: 'idle',
      enabled: true,
      dispatchable: true,
      lifecycle: 'ready',
      phase: null,
      slot_epoch: 1,
      current_run_id: null,
    });
  }
  await writeFile(
    path.join(root, 'pool/local.json'),
    JSON.stringify({
      machine: 'fixture',
      host: 'localhost',
      project: 'proof',
      platform: 'cli',
      slots,
    }),
  );
  const status = path.join(root, 'status.json');
  await writeFile(status, JSON.stringify({ checked_at: new Date().toISOString(), slots: rows }));
  Object.assign(process.env, {
    NODE_TEST_CONTEXT: '1',
    FARMSLOT_ROOT: root,
    FARMSLOT_HOME: path.join(root, 'home'),
    FARMSLOT_POOL_DIR: path.join(root, 'pool'),
    FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
    FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
    FARMSLOT_TEST_STATUS_FILE: status,
    FARMSLOT_GATEWAY_BACKGROUND: '1',
  });
  delete process.env.TMUX;
  delete process.env.TMUX_PANE;
  const state = await import('../fleet/state.js');
  const workspace = await import('../methods/slot/workspace.js');
  const metrics = (await import('../observability/performance.js')).gatewayPerformance;
  background = (await import('./background/client.js')).backgroundHost;
  const trace = path.join(root, 'git-trace.jsonl');
  process.env.GIT_TRACE2_EVENT = trace;
  background.start();
  await background.request('decisions.scan', {}, { deadlineMs: 10000 });
  const loaded = await state.loadFleetStatus(true);
  const before = metrics.snapshot();
  await writeFile(trace, '');
  Date.now = () => originalNow() + offset;
  for (let round = 0; round < 21; round++) {
    offset = round * 30_000;
    const observed = await workspace.enrichFleetWorkspaces(loaded);
    for (const slot of observed.slots) {
      assert.equal(slot.workspace, undefined);
      assert.ok(slot.workspaceError, 'unavailable checkouts stay unverified');
    }
  }
  const counter = (snapshot: typeof before, method: string) =>
    snapshot.counters
      .filter(
        (row) =>
          row.name === 'farmslot_exec_calls_total' &&
          row.labels.method === method &&
          row.labels.kind === 'shell',
      )
      .reduce((sum, row) => sum + row.value, 0);
  const parentShells = counter(metrics.snapshot(), '_background') - counter(before, '_background');
  const childShells = background.status().exec['commands.read']?.shell?.calls ?? 0;
  const totalShells = parentShells + childShells;
  const gitProcesses = (await readFile(trace, 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((event) => event.event === 'start').length;
  if (process.argv.includes('--assert-budget')) {
    assert.ok(totalShells <= 88, 'unavailable inspection retry budget exceeded');
    assert.ok(gitProcesses <= 176, 'unavailable inspection Git budget exceeded');
  }
  console.log(
    JSON.stringify(
      {
        sourceHead,
        slots: 8,
        rounds: 21,
        gitProcesses,
        logicalSampleSeconds: 630,
        parentShells,
        childShells,
        totalShells,
        shellsPerLogicalMinute: totalShells / 10.5,
        result: 'PASS',
      },
      null,
      2,
    ),
  );
} finally {
  Date.now = originalNow;
  await background?.stop();
  await rm(root, { recursive: true, force: true });
}
