import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, mock, test, type TestContext } from 'node:test';
import { promisify } from 'node:util';

import type { ExecResult, QaProfileSelection } from '@farmslot/protocol';

import type { SlotVars } from '../core/config.js';

const executeFile = promisify(execFile);
const root = mkdtempSync(path.join(tmpdir(), 'qa-scope-prepare-'));
const project = 'qa-scope-fixture';
const slotId = 'qa-scope-slot';
const repo = path.join(root, 'slot');
const origin = path.join(root, 'origin.git');
const environment = {
  FARMSLOT_ROOT: root,
  FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  FARMSLOT_HOME: path.join(root, 'home'),
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
  FARMSLOT_TEST_STATUS_FILE: path.join(root, '.farm-status.json'),
  NODE_TEST_CONTEXT: '1',
};
const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
Object.assign(process.env, environment);
for (const dir of ['scripts', 'services/gateway', 'pool', `projects/${project}`, 'home', 'runs'])
  mkdirSync(path.join(root, dir), { recursive: true });
writeFileSync(path.join(root, 'CLAUDE.md'), '# Disposable QA scope fixture\n');
writeFileSync(path.join(root, 'scripts/dev.sh'), '');
writeFileSync(path.join(root, 'services/gateway/package.json'), '{}');

function git(directory: string, ...args: string[]): string {
  return execFileSync('git', ['-C', directory, '-c', 'core.hooksPath=/dev/null', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

// The slot clones origin at `seed`; origin's main then moves past the frozen
// commit, which the slot has never fetched (the live run sat 8 commits behind).
const author = path.join(root, 'author');
git(root, 'init', '-q', '-b', 'main', author);
git(author, 'config', 'user.name', 'Fixture');
git(author, 'config', 'user.email', 'fixture@example.invalid');
git(author, 'config', 'commit.gpgsign', 'false');
const commit = (name: string): string => {
  writeFileSync(path.join(author, `${name}.txt`), `${name}\n`);
  git(author, 'add', '.');
  git(author, 'commit', '-qm', `test: ${name}`);
  return git(author, 'rev-parse', 'HEAD');
};
commit('seed');
execFileSync('git', ['clone', '-q', '--bare', author, origin]);
execFileSync('git', ['clone', '-q', origin, repo]);
git(author, 'remote', 'add', 'origin', origin);
const frozen = commit('frozen');
const later = commit('later');
git(author, 'push', '-q', 'origin', 'main');
// A release branch the slot does not track: a range froze its first commit,
// then the branch moved on. Origin serves reachable commits by SHA, as GitHub does.
git(origin, 'config', 'uploadpack.allowReachableSHA1InWant', 'true');
git(author, 'checkout', '-q', '-b', 'release/1.0.0', frozen);
const releaseFrozen = commit('release-frozen');
commit('release-moved');
git(author, 'push', '-q', 'origin', 'release/1.0.0');
git(author, 'checkout', '-q', 'main');

writeFileSync(
  path.join(root, 'projects', project, 'project.json'),
  JSON.stringify({
    name: project,
    repo_url: 'https://example.invalid/app.git',
    default_branch: 'main',
    prepare: { default_profile: 'git-only', profiles: { 'git-only': { phases: ['git'] } } },
  }),
);
writeFileSync(
  path.join(root, 'pool/local.json'),
  JSON.stringify({
    machine: 'fixture',
    host: 'localhost',
    project,
    platform: 'cli',
    slots: [{ id: slotId, repo, session: slotId, resources: {} }],
  }),
);
writeFileSync(
  environment.FARMSLOT_TEST_STATUS_FILE,
  JSON.stringify({
    checked_at: new Date().toISOString(),
    slots: [
      {
        slot: slotId,
        machine: 'fixture',
        project,
        platform: 'cli',
        branch: 'main',
        lifecycle: 'ready',
        agent: 'idle',
        current_run_id: null,
        enabled: true,
        health: { ssh: 'LOCAL' },
      },
    ],
  }),
);

const budget = { timeout: 5000 };

// Git runs for real; tmux never does (prepare only asks whether a session exists).
async function slotExec(vars: SlotVars, command: string): Promise<ExecResult> {
  if (command.includes('TMUX_BIN') || /\btmux\b/.test(command))
    return { exitCode: 1, stdout: '', stderr: 'fixture has no tmux server' };
  try {
    // No command outlives the test that started it.
    const result = await executeFile('bash', ['-c', command], {
      cwd: vars.remoteRepo,
      timeout: budget.timeout,
    });
    return { ...result, exitCode: 0 };
  } catch (error) {
    const result = error as Error & { stdout?: string; stderr?: string; code?: number };
    if (typeof result.code !== 'number') throw error;
    return { exitCode: result.code, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }
}
const realExec = await import('../core/exec.js');
mock.module('../core/exec.js', { namedExports: { ...realExec, execOnSlot: slotExec } });
const realCore = await import('../core/index.js');
mock.module('../core/index.js', { namedExports: { ...realCore, execOnSlot: slotExec } });

const { createRun, deleteRun, getRun, updateRun } = await import('../runs/store.js');
const { executePrepareStep } = await import('./dispatch-lifecycle-steps.js');
const { ensureFrozenQaSource, qaScopeSource } = await import('../qa/frozen-source.js');
const { assertQaCompletion } = await import('../qa/completion.js');

after(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

// The live run's preset: a PR profile whose caller inputs choose a ref scope.
function selection(scope: QaProfileSelection['inputs']['scope']): QaProfileSelection {
  return {
    profile: {
      id: 'pr',
      title: 'PR smoke',
      template_id: 'qa/default',
      inputs: { scope: { kind: 'pr' } },
    },
    inputs: { scope, proof_lane: 'source-dev' },
  };
}

function qaRun(t: TestContext, qa: QaProfileSelection) {
  const run = createRun(
    {
      flowType: 'qa',
      project,
      ticketOrPr: 'Main QA at a frozen ref',
      slotId,
      prepareProfile: 'git-only',
    },
    { reviewQa: { flowType: 'qa', contract: { version: 1 }, qa } },
  );
  t.after(async () => {
    updateRun(run.id, { status: 'done', completedAt: new Date().toISOString() });
    await deleteRun(run.id);
  });
  return run;
}

const prepare = (runId: string) =>
  executePrepareStep(runId, {
    activeMonitors: new Map(),
    broadcastFn: () => undefined,
    getRunFlags: () => undefined,
    normalizeEvalReplayForTaskWrite: async (_id, run) => run,
    stepPartialIO: new Map(),
  });

test('exact ref and range scopes freeze a source; names, windows and PRs do not', () => {
  const same = { baseSha: frozen, headSha: frozen };
  assert.deepEqual(qaScopeSource(selection({ kind: 'ref', ref: frozen })), same);
  assert.deepEqual(
    qaScopeSource(selection({ kind: 'ref', ref: 'main', expectedHeadSha: frozen })),
    same,
  );
  assert.deepEqual(qaScopeSource(selection({ kind: 'range', base: later, head: frozen })), {
    baseSha: later,
    headSha: frozen,
  });
  // A range needs both ends exact: its base is the comparison completion checks.
  assert.equal(
    qaScopeSource(selection({ kind: 'range', base: 'v1.0.0', head: frozen })),
    undefined,
  );
  assert.deepEqual(qaScopeSource(selection({ kind: 'ref', ref: 'a'.repeat(64) })), {
    baseSha: 'a'.repeat(64),
    headSha: 'a'.repeat(64),
  });
  assert.equal(qaScopeSource(selection({ kind: 'ref', ref: 'main' })), undefined);
  assert.equal(qaScopeSource(selection({ kind: 'ref', ref: frozen.slice(0, 12) })), undefined);
  assert.equal(qaScopeSource(selection({ kind: 'window', ref: frozen, hours: 24 })), undefined);
  assert.equal(qaScopeSource(selection({ kind: 'pr' })), undefined);
  // An admitted scope without a kind overlays the same-kind preset, as the skill reads it.
  assert.deepEqual(
    qaScopeSource({
      profile: {
        id: 'ref',
        title: 'Ref',
        template_id: 'qa/default',
        inputs: { scope: { kind: 'ref', ref: 'main' } },
      },
      inputs: { scope: { expectedHeadSha: frozen } },
    }),
    same,
  );
});

// Regression: run 3e2f400a was prepared before its scope froze a source and
// failed completion for a missing source identity. The same identity now applies
// there, and an existing one (a PR's) is never replaced.
test('completion freezes a ref run source it never recorded', async (t) => {
  const run = qaRun(t, selection({ kind: 'ref', ref: frozen, expectedHeadSha: frozen }));
  assert.equal(getRun(run.id)?.qaSource, undefined);

  await assert.rejects(assertQaCompletion(run, { retained: true }), (error: Error) => {
    assert.doesNotMatch(error.message, /no frozen source identity/);
    return true;
  });
  assert.deepEqual(getRun(run.id)?.qaSource, { baseSha: frozen, headSha: frozen });

  const pr = qaRun(t, selection({ kind: 'ref', ref: frozen }));
  updateRun(pr.id, { qaSource: { baseSha: later, headSha: later } });
  assert.deepEqual(ensureFrozenQaSource(pr.id)?.qaSource, { baseSha: later, headSha: later });
});

// Regression: run 3e2f400a admitted a ref scope at an exact commit and was
// prepared on main's tip, so the worker stopped to ask whether to detach.
test('prepare checks a ref-scope QA run out at its frozen head', budget, async (t) => {
  git(repo, 'checkout', '-q', 'main');
  assert.throws(() => git(repo, 'cat-file', '-e', `${frozen}^{commit}`), 'slot starts without it');
  const run = qaRun(t, selection({ kind: 'ref', ref: frozen, expectedHeadSha: frozen }));

  const result = await prepare(run.id);

  assert.equal(result.outputs?.success, true);
  assert.match(String(result.outputs?.cliCommand), new RegExp(`--start-ref ${frozen}`));
  assert.equal(git(repo, 'rev-parse', 'HEAD'), frozen);
  assert.throws(() => git(repo, 'symbolic-ref', '-q', 'HEAD'), 'HEAD is detached');
  assert.equal(git(repo, 'rev-parse', 'main'), git(origin, 'rev-parse', 'main~2'));
  assert.equal(git(repo, 'status', '--porcelain'), '');
  assert.equal(getRun(run.id)?.startRef?.requestedRef, frozen);
  assert.equal(getRun(run.id)?.startRef?.resolvedSha, frozen);
  assert.deepEqual(getRun(run.id)?.qaSource, { baseSha: frozen, headSha: frozen });
});

// A prepare replay finds the slot still detached where the first attempt left it.
test('a slot already detached at the frozen head prepares again', budget, async (t) => {
  git(repo, 'fetch', '-q', 'origin');
  git(repo, 'checkout', '-q', '--detach', frozen);
  const run = qaRun(t, selection({ kind: 'ref', ref: frozen, expectedHeadSha: frozen }));

  const result = await prepare(run.id);

  assert.equal(result.outputs?.success, true);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), frozen);
});

test('the post-prepare check refuses a checkout away from the frozen head', budget, async (t) => {
  git(repo, 'checkout', '-q', 'main');
  const run = qaRun(t, selection({ kind: 'ref', ref: frozen, expectedHeadSha: frozen }));
  // A caller-supplied start ref wins in prepare; the frozen scope head still decides.
  updateRun(run.id, { startRef: { requestedRef: later, source: { kind: 'git-ref', ref: later } } });

  await assert.rejects(
    prepare(run.id),
    new RegExp(`Prepared QA checkout ${later} differs from the frozen head ${frozen}`),
  );
  assert.equal(git(repo, 'rev-parse', 'HEAD'), later);
});

// Regression: a QA run that failed after prepare left the slot detached at its
// head, and the next run's prepare refused "Slot is on 'HEAD', expected 'main'".
test('a slot another QA run left detached prepares at this run head', budget, async (t) => {
  git(repo, 'fetch', '-q', 'origin');
  git(repo, 'checkout', '-q', '--detach', frozen);
  // A failed deps step can leave tracked files changed that the idle branch lacks.
  writeFileSync(path.join(repo, 'frozen.txt'), 'changed by a failed prepare\n');
  const run = qaRun(t, selection({ kind: 'ref', ref: later, expectedHeadSha: later }));

  const result = await prepare(run.id);

  assert.equal(result.outputs?.success, true);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), later);
  assert.equal(git(repo, 'status', '--porcelain'), '');
  assert.throws(() => git(repo, 'symbolic-ref', '-q', 'HEAD'), 'HEAD is detached');
});

// A frozen head of a moved, untracked branch is on no remote-tracking ref, so the
// unpublished-commit check read it as local work and refused both the next run
// and a prepare replay of the same run.
// Two prepares, so twice the per-test budget.
test(
  'a slot left detached at a moved branch commit prepares again',
  { timeout: 2 * budget.timeout },
  async (t) => {
    // QA slots fetch only main.
    const refspec = git(repo, 'config', '--get', 'remote.origin.fetch');
    git(repo, 'config', 'remote.origin.fetch', '+refs/heads/main:refs/remotes/origin/main');
    t.after(() => git(repo, 'config', 'remote.origin.fetch', refspec));
    for (const ref of git(
      repo,
      'for-each-ref',
      '--format=%(refname)',
      'refs/remotes/origin/release',
    ).split('\n'))
      if (ref) git(repo, 'update-ref', '-d', ref);
    git(repo, 'fetch', '-q', '--no-tags', 'origin', releaseFrozen);
    git(repo, 'checkout', '-q', '--detach', releaseFrozen);
    const replay = qaRun(
      t,
      selection({ kind: 'ref', ref: releaseFrozen, expectedHeadSha: releaseFrozen }),
    );
    assert.equal((await prepare(replay.id)).outputs?.success, true);
    assert.equal(git(repo, 'rev-parse', 'HEAD'), releaseFrozen);

    const next = qaRun(t, selection({ kind: 'ref', ref: later, expectedHeadSha: later }));
    assert.equal((await prepare(next.id)).outputs?.success, true);
    assert.equal(git(repo, 'rev-parse', 'HEAD'), later);
    assert.equal(
      git(repo, 'for-each-ref', '--format=%(refname)', 'refs/remotes/origin/release'),
      '',
    );
  },
);

test('a slot detached at a local-only commit is still refused', budget, async (t) => {
  git(repo, 'checkout', '-q', 'main');
  const localOnly = git(
    repo,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit-tree',
    'HEAD^{tree}',
    '-p',
    'HEAD',
    '-m',
    'local only',
  );
  git(repo, 'checkout', '-q', '--detach', localOnly);
  const run = qaRun(t, selection({ kind: 'ref', ref: later, expectedHeadSha: later }));

  // The refusal names why the remote does not show it.
  await assert.rejects(
    prepare(run.id),
    new RegExp(
      `Slot is detached at ${localOnly.slice(0, 12)}, which origin does not show \\(startRef commit '${localOnly}' is not reachable`,
    ),
  );
  assert.equal(git(repo, 'rev-parse', 'HEAD'), localOnly);
});

// A start-ref prepare that refuses keeps the slot, and any changes on it, where
// the earlier run left them; only its reset to its own head may discard them.
test(
  'a refused start-ref prepare leaves a detached slot and its changes alone',
  budget,
  async (t) => {
    git(repo, 'fetch', '-q', 'origin');
    git(repo, 'checkout', '-q', '--detach', frozen);
    writeFileSync(path.join(repo, 'frozen.txt'), 'evidence from the failed run\n');
    const unpublished = git(
      repo,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit-tree',
      'HEAD^{tree}',
      '-p',
      'HEAD',
      '-m',
      'never pushed',
    );
    const run = qaRun(
      t,
      selection({ kind: 'ref', ref: unpublished, expectedHeadSha: unpublished }),
    );

    await assert.rejects(prepare(run.id), /not reachable from fetched origin/);
    assert.equal(git(repo, 'rev-parse', 'HEAD'), frozen);
    assert.equal(git(repo, 'status', '--porcelain'), 'M frozen.txt');
    git(repo, 'checkout', '-q', '--', 'frozen.txt');
  },
);
