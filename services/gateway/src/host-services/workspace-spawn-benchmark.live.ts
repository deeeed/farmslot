// Opt-in isolated before/after workload. Run identical file on the base and proposed trees.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';

const root = await mkdtemp(path.join(os.tmpdir(), 'workspace-spawn-benchmark-'));
const count = 8;
const remoteRefs = process.argv.includes('--remote-refs');
const rounds = remoteRefs ? 21 : 4;
const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const sourceChanges = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim();
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
const originalNow = Date.now;
let offset = 0;
let background: typeof import('./background/client.js').backgroundHost | undefined;
const lag = monitorEventLoopDelay({ resolution: 10 });
try {
  for (const dir of [
    'scripts',
    'services/gateway',
    'projects/proof',
    'pool',
    'home',
    'runs',
    'seed',
  ])
    await mkdir(path.join(root, dir), { recursive: true });
  await writeFile(path.join(root, 'CLAUDE.md'), '# Disposable performance fixture\n');
  await writeFile(path.join(root, 'scripts/dev.sh'), 'exit 1\n');
  await writeFile(path.join(root, 'services/gateway/package.json'), '{}');
  await writeFile(
    path.join(root, 'projects/proof/project.json'),
    JSON.stringify({ name: 'proof', default_branch: 'main' }),
  );
  const seed = path.join(root, 'seed');
  git(seed, 'init', '-q', '-b', 'main');
  await writeFile(path.join(seed, 'file.txt'), 'unchanged fixture\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-qm', 'fixture');
  const origin = path.join(root, 'origin.git');
  git(root, 'clone', '-q', '--bare', seed, origin);
  if (remoteRefs) {
    git(seed, 'remote', 'add', 'origin', origin);
    for (let i = 0; i < 2; i++) {
      git(seed, 'checkout', '-qb', `published-${i}`, 'main');
      await writeFile(path.join(seed, 'published.txt'), `published-${i}\n`);
      git(seed, 'add', '.');
      git(seed, 'commit', '-qm', `published-${i}`);
      git(seed, 'push', '-q', 'origin', `published-${i}`);
    }
  }
  const slots = [];
  const rows = [];
  const expectedHeads = new Map<string, string>();
  for (let i = 0; i < count; i++) {
    const id = `proof-${i}`;
    const repo = path.join(root, id);
    git(root, 'clone', '-q', origin, repo);
    const branch = remoteRefs ? `published-${i % 2}` : i % 2 ? `unpublished-${i}` : 'main';
    if (remoteRefs) git(repo, 'checkout', '-q', branch);
    else if (i % 2) {
      git(repo, 'checkout', '-qb', branch);
      await writeFile(path.join(repo, 'local.txt'), `unpublished-${i}\n`);
      git(repo, 'add', 'local.txt');
      git(repo, 'commit', '-qm', `local-${i}`);
    }
    const slotHead = git(repo, 'rev-parse', 'HEAD');
    expectedHeads.set(id, slotHead);
    slots.push({ id, repo, session: id });
    rows.push({
      slot: id,
      machine: 'fixture',
      project: 'proof',
      platform: 'cli',
      ssh: 'LOCAL',
      branch,
      head_sha: slotHead,
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
  const performance = await import('../observability/performance.js');
  background = (await import('./background/client.js')).backgroundHost;
  const gitCount = path.join(root, 'git-count');
  if (remoteRefs) {
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const bin = path.join(root, 'bin');
    await mkdir(bin);
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    await writeFile(
      path.join(bin, 'git'),
      `#!/bin/sh\nprintf 'git\\n' >> ${quote(gitCount)}\nexec ${quote(realGit)} "$@"\n`,
    );
    await chmod(path.join(bin, 'git'), 0o755);
    process.env.PATH = `${bin}:${process.env.PATH}`;
  }
  background.start();
  await background.request('decisions.scan', {}, { deadlineMs: 10000 });
  const loaded = await state.loadFleetStatus(true);
  const before = performance.gatewayPerformance.snapshot();
  if (remoteRefs) await writeFile(gitCount, '');
  const observations: string[][] = [];
  Date.now = () => originalNow() + offset;
  lag.enable();
  const started = globalThis.performance.now();
  for (let round = 0; round < rounds; round++) {
    offset = round * (remoteRefs ? 30000 : 16000);
    const sampled = {
      ...loaded,
      slots: loaded.slots.map((slot) =>
        round % 2 ? { ...slot, branch: '-', headSha: undefined } : slot,
      ),
    };
    const observed = remoteRefs
      ? {
          ...sampled,
          slots: await Promise.all(
            sampled.slots.map(async (slot) => ({
              ...slot,
              workspace: await workspace.inspectSlotWorkspace(slot.slot, { passive: true }),
            })),
          ),
        }
      : await workspace.enrichFleetWorkspaces(sampled);
    observations.push(
      observed.slots.map((slot) => {
        assert.equal(slot.workspaceError, undefined);
        if (remoteRefs) assert.equal(slot.workspace?.publication, 'pushed');
        assert.equal(slot.workspace?.headSha, expectedHeads.get(slot.slot));
        assert.equal(slot.workspace?.dirtyCount, 0);
        return slot.workspace.observedAt;
      }),
    );
  }
  const elapsedMs = globalThis.performance.now() - started;
  lag.disable();
  const after = performance.gatewayPerformance.snapshot();
  const counter = (snapshot: typeof before, method: string) =>
    snapshot.counters
      .filter(
        (row) =>
          row.name === 'farmslot_exec_calls_total' &&
          row.labels.method === method &&
          row.labels.kind === 'shell',
      )
      .reduce((sum, row) => sum + row.value, 0);
  const parentShells = counter(after, '_background') - counter(before, '_background');
  const childShells = background.status().exec['commands.read']?.shell?.calls ?? 0;
  const changedObservationRounds = observations
    .slice(1)
    .filter((values, index) =>
      values.some((value, slot) => value !== observations[index][slot]),
    ).length;
  const gitProcesses = remoteRefs
    ? (await readFile(gitCount, 'utf8')).trim().split('\n').filter(Boolean).length
    : undefined;
  if (process.argv.includes('--assert-ref-budget')) {
    assert.ok(parentShells + childShells <= 720, 'passive ref shell budget exceeded');
    assert.ok(gitProcesses !== undefined && gitProcesses <= 2400, 'nested Git budget exceeded');
  }
  console.log(
    JSON.stringify(
      {
        sourceHead,
        sourceChanges,
        slots: count,
        unpublishedSlots: remoteRefs ? 0 : count / 2,
        remoteRefCase: remoteRefs,
        gitProcesses,
        rounds,
        logicalSampleSeconds: remoteRefs ? rounds * 30 : 48,
        elapsedMs,
        parentShells,
        childShells,
        totalShells: parentShells + childShells,
        shellsPerLogicalMinute:
          ((parentShells + childShells) / (remoteRefs ? rounds * 30 : 48)) * 60,
        changedObservationRounds,
        maxLoopLagMs: lag.max / 1e6,
        p99LoopLagMs: lag.percentile(99) / 1e6,
        result: 'PASS',
      },
      null,
      2,
    ),
  );
} finally {
  lag.disable();
  Date.now = originalNow;
  await background?.stop();
  await rm(root, { recursive: true, force: true });
}
