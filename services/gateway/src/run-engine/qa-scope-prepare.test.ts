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
