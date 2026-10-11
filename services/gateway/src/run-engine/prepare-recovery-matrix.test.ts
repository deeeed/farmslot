import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

import { FLOW_STEPS } from '@farmslot/protocol';

// Each cell crosses the real store/replay/assignment/prepare boundaries. Only
// command transport is replaced: Git still operates on private temporary repos,
// tmux is trapped, and an offline source returns the transport's real failure shape.
const root = mkdtempSync(path.join(tmpdir(), 'prepare-matrix-'));
for (const name of [
  'scripts',
  'services/gateway',
  'projects/farm',
  'pool',
  'home',
  'runs',
  'bin',
  'seed',
])
  mkdirSync(path.join(root, name), { recursive: true });
writeFileSync(path.join(root, 'CLAUDE.md'), 'fixture');
writeFileSync(path.join(root, 'scripts/dev.sh'), '');
writeFileSync(path.join(root, 'services/gateway/package.json'), '{}');
writeFileSync(path.join(root, 'bin/tmux'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
Object.assign(process.env, {
  FARMSLOT_ROOT: root,
  FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  FARMSLOT_HOME: path.join(root, 'home'),
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
  FARMSLOT_TEST_STATUS_FILE: path.join(root, '.farm-status.json'),
  FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
  NODE_TEST_CONTEXT: '1',
  PATH: path.join(root, 'bin') + path.delimiter + process.env.PATH,
});
const commands: { slot: string; command: string }[] = [];
let sourceOffline = false;
const realExec = await import('../core/exec.js');
const transport = async (vars: import('../core/config.js').SlotVars, command: string) => {
  commands.push({ slot: vars.slotId, command });
  if (sourceOffline && vars.slotId === 'source')
    return { stdout: '', stderr: 'fixture source offline', exitCode: 255 };
  const result = spawnSync('bash', ['-c', command], { encoding: 'utf8' });
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.status ?? 1 };
};
mock.module('../core/exec.js', { namedExports: { ...realExec, execOnSlot: transport } });
const realCore = await import('../core/index.js');
mock.module('../core/index.js', { namedExports: { ...realCore, execOnSlot: transport } });
const { createRun, deleteRun, getAllRuns, getRun, loadAllRuns, persistRunNow, updateRun } =
  await import('../runs/store.js');
const { runReplayStep } = await import('../methods/run/replay-step.js');
const { updateRunSummaryAndBranch, recordInitialPrepareBranchState } =
  await import('./prepare-branch-state.js');
const { executePrepareStep } = await import('./dispatch-lifecycle-steps.js');
after(async () => {
  for (const run of getAllRuns()) await persistRunNow(run, 'matrix teardown');
  rmSync(root, { recursive: true, force: true });
});
const git = (repo: string, ...args: string[]) =>
  execFileSync(
    'git',
    [
      '-C',
      repo,
      '-c',
      'core.hooksPath=.git/hooks',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      ...args,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
const seed = path.join(root, 'seed');
const branch = 'feature/recovery';
git(seed, 'init', '-b', 'main');
writeFileSync(path.join(seed, 'file.txt'), 'base\n');
git(seed, 'add', '.');
git(seed, 'commit', '-m', 'test: base');
const base = git(seed, 'rev-parse', 'HEAD');
git(seed, 'checkout', '-b', branch);
writeFileSync(path.join(seed, 'file.txt'), 'published\n');
git(seed, 'commit', '-am', 'test: published');
const published = git(seed, 'rev-parse', 'HEAD');
writeFileSync(path.join(seed, 'file.txt'), 'unpublished\n');
git(seed, 'commit', '-am', 'test: unpublished');
const unpublished = git(seed, 'rev-parse', 'HEAD');
git(seed, 'checkout', 'main');
writeFileSync(
  path.join(root, 'projects/farm/project.json'),
  JSON.stringify({
    name: 'farm',
    repo_url: 'https://github.com/example/app.git',
    default_branch: 'main',
    prepare: { default_profile: 'git-only', profiles: { 'git-only': { phases: ['git'] } } },
  }),
);

type Presence = 'local' | 'published' | 'missing';
const fixtureTemplates = new Map<string, { source: string; destination: string }>();
function fixture(label: string, slot: 'same' | 'cross', presence: Presence, unpushed: boolean) {
  const dir = path.join(root, label);
  mkdirSync(dir);
  const key = `${slot}/${presence}/${unpushed}`;
  const template = fixtureTemplates.get(key);
  if (template) {
    const source = path.join(dir, 'source');
    cpSync(template.source, source, { recursive: true });
    const destination = slot === 'same' ? source : path.join(dir, 'destination');
    if (slot === 'cross') cpSync(template.destination, destination, { recursive: true });
    installPool(source, destination);
    return { source, destination };
  }
  const origin = path.join(dir, 'origin.git');
  execFileSync('git', ['clone', '--bare', seed, origin], { stdio: 'ignore' });
  if (presence === 'missing') git(origin, 'update-ref', '-d', `refs/heads/${branch}`);
  else git(origin, 'update-ref', `refs/heads/${branch}`, published);
  const source = path.join(dir, 'source');
  cpSync(seed, source, { recursive: true });
  git(source, 'remote', 'add', 'origin', origin);
  git(source, 'update-ref', 'refs/remotes/origin/main', base);
  git(source, 'update-ref', '-d', `refs/heads/${branch}`);
  if (presence !== 'missing') git(source, 'update-ref', `refs/remotes/origin/${branch}`, published);
  if (presence === 'local' || (slot === 'cross' && presence === 'published')) {
    git(source, 'checkout', '-b', branch, unpushed ? unpublished : published);
  } else if (unpushed) git(source, 'checkout', '--detach', unpublished);
  const destination = slot === 'same' ? source : path.join(dir, 'destination');
  if (slot === 'cross') {
    cpSync(source, destination, { recursive: true });
    git(destination, 'checkout', '--detach', base);
    if (presence !== 'missing') git(destination, 'branch', '-D', branch);
    git(destination, 'checkout', 'main');
    if (presence === 'local') git(destination, 'checkout', '-b', branch, published);
  }
  const templateSource = path.join(dir, 'template-source');
  cpSync(source, templateSource, { recursive: true });
  const templateDestination =
    slot === 'same' ? templateSource : path.join(dir, 'template-destination');
  if (slot === 'cross') cpSync(destination, templateDestination, { recursive: true });
  fixtureTemplates.set(key, { source: templateSource, destination: templateDestination });
  installPool(source, destination);
  return { source, destination };
}

function installPool(source: string, destination: string) {
  writeFileSync(
    path.join(root, 'pool/local.json'),
    JSON.stringify({
      machine: 'fixture',
      host: 'localhost',
      project: 'farm',
      platform: 'cli',
      slots: [
        { id: 'source', repo: source, session: 'source', enabled: true, resources: {} },
        {
          id: 'destination',
          repo: destination,
          session: 'destination',
          enabled: true,
          resources: {},
        },
      ],
    }),
  );
  writeFileSync(path.join(root, '.farm-status.json'), JSON.stringify({ slots: [] }));
}

const prepare = (runId: string) =>
  executePrepareStep(runId, {
    activeMonitors: new Map(),
    broadcastFn: () => {},
    getRunFlags: () => undefined,
    normalizeEvalReplayForTaskWrite: async (_id, run) => run,
    stepPartialIO: new Map(),
  });

// Column order: worker launched / slot / branch availability / unpushed / outcome.
// First assignment cannot authorize recovery of an unnamed, previously launched
// worker. A prepare-only replay cannot reach grade/write-task to assign a name.
const table = [
  [false, 'same', 'local', false, 'preserve'],
  [false, 'same', 'local', true, 'preserve'],
  [false, 'same', 'published', false, 'preserve'],
  [false, 'same', 'published', true, 'fail-closed'],
  [false, 'same', 'missing', false, 'fresh'],
  [false, 'same', 'missing', true, 'fail-closed'],
  [false, 'cross', 'local', false, 'preserve'],
  [false, 'cross', 'local', true, 'fail-closed'],
  [false, 'cross', 'published', false, 'preserve'],
  [false, 'cross', 'published', true, 'fail-closed'],
  [false, 'cross', 'missing', false, 'fresh'],
  [false, 'cross', 'missing', true, 'fail-closed'],
  [true, 'same', 'local', false, 'preserve'],
  [true, 'same', 'local', true, 'preserve'],
  [true, 'same', 'published', false, 'preserve'],
  [true, 'same', 'published', true, 'fail-closed'],
  [true, 'same', 'missing', false, 'fail-closed'],
  [true, 'same', 'missing', true, 'fail-closed'],
  [true, 'cross', 'local', false, 'preserve'],
  [true, 'cross', 'local', true, 'fail-closed'],
  [true, 'cross', 'published', false, 'preserve'],
  [true, 'cross', 'published', true, 'fail-closed'],
  [true, 'cross', 'missing', false, 'fail-closed'],
  [true, 'cross', 'missing', true, 'fail-closed'],
] as const;
let cells = 0;
for (const assignment of ['before', 'during'] as const) {
  for (const step of ['find-slot', 'grade', 'write-task', 'prepare'] as const) {
    for (const [workerStarted, slot, presence, unpushed, branchOutcome] of table) {
      const expected =
        assignment === 'during' && (step === 'prepare' || workerStarted)
          ? 'fail-closed'
          : branchOutcome;
      const label = `${assignment}/${step}/worker=${workerStarted}/${slot}/${presence}/unpushed=${unpushed}`;
      const index = ++cells;
      test(
        `recovery ${label} => ${expected}`,
        {
          skip:
            process.env.FARMSLOT_LIVE_RECOVERY_MATRIX !== '1' &&
            'full production recovery table runs in the manual live tier',
        },
        async () => {
          const { source, destination } = fixture(String(index), slot, presence, unpushed);
          commands.length = 0;
          const run = createRun(
            {
              flowType: 'fix-bug',
              project: 'farm',
              ticketOrPr: 'TEST-930',
              slotId: 'source',
              prepareProfile: 'git-only',
            },
            { deferBackgroundPersist: true },
          );
          if (assignment === 'before') {
            await updateRunSummaryAndBranch(run.id, { branch });
            await recordInitialPrepareBranchState(run.id);
          }
          updateRun(run.id, {
            status: 'paused',
            taskFile: path.join(root, 'TASK.md'),
            engineState: {
              ...getRun(run.id)!.engineState,
              workerLaunchStarted: workerStarted,
              ...(assignment === 'before'
                ? { prepareBranch: { slotId: 'source', branch, started: true } }
                : {}),
            },
            steps: run.steps.map((row) => ({ ...row, status: 'done' })),
          });
          const sourceHead = git(source, 'rev-parse', 'HEAD');
          const destinationHead = git(destination, 'rev-parse', 'HEAD');
          await runReplayStep({ runId: run.id, stepName: step, triggeredBy: 'operator' }, () => {});
          const replayed = getRun(run.id)!;
          const entry = FLOW_STEPS['fix-bug'].indexOf(step);
          assert.equal(replayed.steps.find((row) => row.name === step)?.status, 'pending');
          for (const name of FLOW_STEPS['fix-bug'].slice(0, entry))
            assert.equal(replayed.steps.find((row) => row.name === name)?.status, 'done');
          assert.equal(
            replayed.slotId,
            entry <= FLOW_STEPS['fix-bug'].indexOf('find-slot') ? null : 'source',
          );
          assert.equal(replayed.taskFile, step === 'prepare' ? path.join(root, 'TASK.md') : null);
          assert.equal(replayed.engineState?.workerLaunchStarted, workerStarted);
          assert.equal(replayed.engineState?.prepareBranch?.slotId, 'source');
          if (assignment === 'during')
            assert.equal(replayed.engineState?.prepareBranch?.started, undefined);
          let failure: unknown;
          try {
            if (assignment === 'during' && step !== 'prepare')
              await updateRunSummaryAndBranch(run.id, { branch });
            // Selection/task I/O is outside this table. Persist its result without
            // touching the original branch intent or durable launch history.
            updateRun(run.id, {
              slotId: slot === 'same' ? 'source' : 'destination',
              taskFile: path.join(root, 'TASK.md'),
            });
            await prepare(run.id);
          } catch (error) {
            failure = error;
          }
          if (expected === 'fail-closed') {
            assert.ok(failure instanceof Error, 'unsafe recovery must be refused');
            assert.match(
              failure.message,
              /unpushed|unverified|worker may have started|remote absence is unconfirmed|first branch|without a run branch/,
            );
            assert.equal(git(destination, 'rev-parse', 'HEAD'), destinationHead);
            assert.equal(
              commands.some((row) => /git (?:reset --hard|clean|branch -D)/.test(row.command)),
              false,
            );
          } else {
            assert.equal(failure, undefined);
            assert.equal(git(destination, 'branch', '--show-current'), branch);
            assert.equal(
              git(destination, 'rev-parse', 'HEAD'),
              expected === 'fresh'
                ? base
                : slot === 'same' && presence === 'local' && unpushed
                  ? unpublished
                  : published,
            );
          }
          if (slot === 'cross' || expected === 'fail-closed')
            assert.equal(git(source, 'rev-parse', 'HEAD'), sourceHead);
          if (slot === 'cross' && assignment === 'before' && (presence !== 'missing' || unpushed))
            assert.ok(
              commands.some((row) => row.slot === 'source' && /show-ref/.test(row.command)),
            );
          updateRun(run.id, { status: 'failed' });
          await persistRunNow(getRun(run.id)!, 'matrix cleanup');
          await deleteRun(run.id);
        },
      );
    }
  }
}
test('all 192 production recovery cells are covered', () => assert.equal(cells, 192));

async function sourceReplay(
  options: { legacy?: boolean; started?: boolean; workerStarted?: boolean } = {},
) {
  const run = createRun(
    {
      flowType: 'fix-bug',
      project: 'farm',
      ticketOrPr: 'TEST-930',
      slotId: 'source',
      branch,
      prepareProfile: 'git-only',
    },
    { deferBackgroundPersist: true },
  );
  updateRun(run.id, {
    status: 'paused',
    taskFile: path.join(root, 'TASK.md'),
    engineState: {
      ...run.engineState,
      workerLaunchStarted: options.workerStarted ?? false,
      ...(!options.legacy
        ? { prepareBranch: { slotId: 'source', branch, started: options.started ?? true } }
        : {}),
    },
    steps: run.steps.map((row) => ({ ...row, status: 'done' })),
  });
  await persistRunNow(getRun(run.id)!, 'source regression');
  if (options.legacy) {
    // Load actual historical JSON. updateRun intentionally prevents erasing launch history.
    const file = path.join(root, 'runs', run.id + '.json');
    const persisted = JSON.parse(readFileSync(file, 'utf8'));
    delete persisted.engineState.workerLaunchStarted;
    delete persisted.engineState.prepareBranch;
    writeFileSync(file, JSON.stringify(persisted));
    await loadAllRuns();
    assert.equal(getRun(run.id)?.engineState?.workerLaunchStarted, undefined);
  }
  await runReplayStep({ runId: run.id, stepName: 'find-slot', triggeredBy: 'operator' }, () => {});
  assert.equal(getRun(run.id)?.engineState?.prepareBranch?.slotId, 'source');
  if (options.legacy) {
    assert.equal(getRun(run.id)?.engineState?.prepareBranch?.started, undefined);
    assert.equal(getRun(run.id)?.engineState?.workerLaunchStarted, undefined);
  }
  updateRun(run.id, { slotId: 'destination', taskFile: path.join(root, 'TASK.md') });
  commands.length = 0;
  return run.id;
}

async function evict(runId: string) {
  sourceOffline = false;
  updateRun(runId, { status: 'failed' });
  await persistRunNow(getRun(runId)!, 'source regression cleanup');
  await deleteRun(runId);
}

test(
  'offline original with durable no-setup and no-worker history permits a fresh cross-slot branch',
  { skip: process.env.FARMSLOT_LIVE_RECOVERY_MATRIX !== '1' && 'manual real-Git tier' },
  async (t) => {
    const { destination } = fixture('offline-never-started', 'cross', 'missing', false);
    const runId = await sourceReplay({ started: false });
    t.after(() => evict(runId));
    sourceOffline = true;
    await prepare(runId);
    assert.equal(git(destination, 'rev-parse', 'HEAD'), base);
    assert.equal(git(destination, 'branch', '--show-current'), branch);
    assert.equal(
      commands.some((row) => row.slot === 'source'),
      false,
    );
  },
);

test('offline original with unknown historical setup remains fail-closed', async (t) => {
  const { destination } = fixture('offline-legacy', 'cross', 'published', false);
  const runId = await sourceReplay({ legacy: true });
  t.after(() => evict(runId));
  sourceOffline = true;
  await assert.rejects(prepare(runId), /Cannot inspect recovery source branch.*255.*offline/);
  assert.equal(git(destination, 'rev-parse', 'HEAD'), base);
});

test(
  'source slot reused by another run ignores its dirty tree and unpushed HEAD',
  { skip: process.env.FARMSLOT_LIVE_RECOVERY_MATRIX !== '1' && 'manual real-Git tier' },
  async (t) => {
    const { source, destination } = fixture('reused-source', 'cross', 'published', false);
    git(source, 'checkout', '-b', 'other-run');
    writeFileSync(path.join(source, 'file.txt'), 'other run commit\n');
    git(source, 'commit', '-am', 'test: other run');
    const otherTip = git(source, 'rev-parse', 'HEAD');
    writeFileSync(path.join(source, 'file.txt'), 'other run dirty\n');
    const runId = await sourceReplay();
    t.after(() => evict(runId));
    await prepare(runId);
    assert.equal(git(destination, 'rev-parse', 'HEAD'), published);
    assert.equal(git(source, 'rev-parse', 'HEAD'), otherTip);
    assert.equal(readFileSync(path.join(source, 'file.txt'), 'utf8'), 'other run dirty\n');
    assert.equal(
      commands.some(
        (row) => row.slot === 'source' && /status --porcelain|rev-parse 'HEAD'/.test(row.command),
      ),
      false,
    );
    assert.ok(
      commands.some(
        (row) => row.slot === 'source' && /refs\/heads\/feature\/recovery/.test(row.command),
      ),
    );
  },
);

test('detached source at this run branch tip still protects dirty files', async (t) => {
  const { source, destination } = fixture('detached-source', 'cross', 'published', false);
  git(source, 'checkout', '--detach');
  writeFileSync(path.join(source, 'file.txt'), 'detached dirty\n');
  const runId = await sourceReplay();
  t.after(() => evict(runId));
  await assert.rejects(prepare(runId), /original work.*dirty files.*Commit, push or preserve/);
  assert.equal(git(destination, 'rev-parse', 'HEAD'), base);
  assert.equal(readFileSync(path.join(source, 'file.txt'), 'utf8'), 'detached dirty\n');
});

for (const dirt of [false, true])
  test(
    `legacy cross-slot replay retains original source with newer ${dirt ? 'dirty files' : 'unpushed commits'}`,
    { skip: !dirt && process.env.FARMSLOT_LIVE_RECOVERY_MATRIX !== '1' && 'manual real-Git tier' },
    async (t) => {
      const { source, destination } = fixture('legacy-source-' + dirt, 'cross', 'published', !dirt);
      if (dirt) writeFileSync(path.join(source, 'file.txt'), 'legacy dirty\n');
      const head = git(source, 'rev-parse', 'HEAD');
      const runId = await sourceReplay({ legacy: true });
      t.after(() => evict(runId));
      await assert.rejects(prepare(runId), /unpushed|original work.*dirty files/);
      assert.equal(git(source, 'rev-parse', 'HEAD'), head);
      assert.equal(git(destination, 'rev-parse', 'HEAD'), base);
      if (dirt) assert.equal(readFileSync(path.join(source, 'file.txt'), 'utf8'), 'legacy dirty\n');
    },
  );
