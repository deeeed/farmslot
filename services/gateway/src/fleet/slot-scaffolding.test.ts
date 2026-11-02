import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runnerRuntimeDir } from '../../../../scripts/lib/runner-runtime.cjs';
import type { SlotVars } from '../core/config.js';

// Slot commands keep the environment from load time, so the cross-volume case needs its stub
// `df` on PATH first. It reports another device only for a path containing `cross-volume`.
const dfStub = mkdtempSync(path.join(tmpdir(), 'slot-scaffolding-df-'));
writeFileSync(
  path.join(dfStub, 'df'),
  `#!/bin/sh\nt="$2"; [ -d "$t" ] && t="$(cd "$t" && pwd -P)"\ncase "$t" in *cross-volume*) printf 'Filesystem\\n/dev/other\\n' ;; *) exec /bin/df "$@" ;; esac\n`,
);
chmodSync(path.join(dfStub, 'df'), 0o755);
process.env.PATH = `${dfStub}:${process.env.PATH}`;
test.after(() => rmSync(dfStub, { recursive: true, force: true }));

await import('../runtime/mock-pty.test-support.js');
const {
  archiveSlotScaffolding,
  excludeSlotScaffolding,
  measureSlotRetention,
  SCAFFOLDING_TEXT_MAX_FILE_BYTES,
} = await import('./slot-scaffolding.js');

function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), 'slot-scaffolding-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  mkdirSync(repo);
  const vars = {
    slotId: 'fixture-slot',
    host: 'localhost',
    machine: 'fixture-node',
    sshTarget: '',
    remoteRepo: repo,
  } as SlotVars;
  return { root, repo, vars, destination: path.join(root, 'run-archive') };
}
function git(repo: string, ...args: string[]) {
  return execFileSync(
    'git',
    [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-C',
      repo,
      ...args,
    ],
    { encoding: 'utf8' },
  ).trim();
}
async function execute(_vars: SlotVars, command: string) {
  const r = spawnSync('/bin/bash', ['-c', command], { encoding: 'utf8' });
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.status ?? 1 };
}
function unpack(directory: string, root: string) {
  const target = path.join(root, 'unpacked');
  mkdirSync(target);
  execFileSync('tar', ['-xf', path.join(directory, 'scaffolding.tar'), '-C', target]);
  return target;
}
function scaffolding(repo: string, task = '.task', runtime = '.agent') {
  mkdirSync(path.join(repo, task, 'qa/example'), { recursive: true });
  writeFileSync(path.join(repo, task, 'qa/example/TASK.md'), 'completed task');
  mkdirSync(path.join(repo, runtime, '.observability'), { recursive: true });
  writeFileSync(path.join(repo, runtime, '.observability/hooks.jsonl'), 'observations');
  mkdirSync(path.join(repo, runtime, 'browser'), { recursive: true });
  writeFileSync(path.join(repo, runtime, 'browser/profile.json'), 'warm resource');
  symlinkSync(`${runtime}/.observability`, path.join(repo, '.observability'));
}

test('prepare appends exclusions idempotently to the linked worktree Git file', async (t) => {
  const f = fixture(t);
  git(f.repo, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(f.repo, 'base'), 'base');
  git(f.repo, 'add', 'base');
  git(f.repo, 'commit', '-qm', 'base');
  const linked = path.join(f.root, 'linked');
  git(f.repo, 'worktree', 'add', '-q', '-b', 'slot', linked);
  const exclude = path.join(f.repo, '.git/info/exclude');
  writeFileSync(exclude, '/operator-file\n');
  const vars = { ...f.vars, remoteRepo: linked };
  assert.equal(await excludeSlotScaffolding(vars, {}, execute), true);
  const first = readFileSync(exclude, 'utf8');
  assert.equal(await excludeSlotScaffolding(vars, {}, execute), true);
  assert.equal(readFileSync(exclude, 'utf8'), first);
  assert.ok(first.includes('/operator-file'));
  scaffolding(linked);
  writeFileSync(path.join(linked, 'user.txt'), 'user work');
  assert.equal(git(linked, 'status', '--porcelain'), '?? user.txt');
});

test('teardown archives tasks and real observations before removing their compatibility link', async (t) => {
  const f = fixture(t);
  git(f.repo, 'init', '-q', '-b', 'main');
  scaffolding(f.repo);
  await excludeSlotScaffolding(f.vars, {}, execute);
  const result = await archiveSlotScaffolding(
    f.vars,
    {},
    {
      destination: f.destination,
      taskRelativeDir: 'qa/example',
      beforeRemove: async () => undefined,
    },
  );
  git(f.repo, 'clean', '-fd');
  const archived = unpack(result.directory, f.root);
  assert.equal(
    readFileSync(path.join(archived, '.task/qa/example/TASK.md'), 'utf8'),
    'completed task',
  );
  assert.equal(
    readFileSync(path.join(archived, '.agent/.observability/hooks.jsonl'), 'utf8'),
    'observations',
  );
  assert.equal(
    readFileSync(path.join(f.repo, '.agent/browser/profile.json'), 'utf8'),
    'warm resource',
  );
  assert.equal(existsSync(path.join(f.repo, '.task/qa/example')), false);
  assert.equal(existsSync(path.join(f.repo, '.observability')), false);
});

// F313: a release copies nothing back; evidence was pulled into the artifact mirror when the run
// completed. A task holding a 14 GB build (sparse here) keeps only its small text.
test('a release keeps only the small text of a 14 GB task', async (t) => {
  const f = fixture(t);
  git(f.repo, 'init', '-q', '-b', 'main');
  scaffolding(f.repo);
  const task = path.join(f.repo, '.task/qa/example');
  mkdirSync(path.join(task, 'artifacts/recipe-runs/run-1'), { recursive: true });
  writeFileSync(path.join(task, 'artifacts/report.md'), 'report');
  writeFileSync(path.join(task, 'artifacts/recipe-runs/run-1/result.json'), '{}');
  writeFileSync(path.join(task, 'artifacts/recipe-runs/run-1/recipe-run.mp4'), 'video');
  const sized = (relative: string, bytes: number) => {
    writeFileSync(path.join(task, relative), '');
    truncateSync(path.join(task, relative), bytes);
  };
  sized('artifacts/app-release.aab', 14 * 1024 ** 3);
  sized('metro.log', SCAFFOLDING_TEXT_MAX_FILE_BYTES + 1);
  const result = await archiveSlotScaffolding(
    f.vars,
    {},
    {
      destination: f.destination,
      taskRelativeDir: 'qa/example',
      beforeRemove: async () => undefined,
    },
  );
  assert.ok(statSync(path.join(result.directory, 'scaffolding.tar')).size < 1024 ** 2);
  const archived = unpack(result.directory, f.root);
  for (const kept of ['TASK.md', 'artifacts/report.md', 'artifacts/recipe-runs/run-1/result.json'])
    assert.ok(existsSync(path.join(archived, '.task/qa/example', kept)), kept);
  for (const dropped of [
    'artifacts/app-release.aab',
    'artifacts/recipe-runs/run-1/recipe-run.mp4',
    'metro.log',
  ])
    assert.equal(existsSync(path.join(archived, '.task/qa/example', dropped)), false, dropped);
  assert.equal(
    readFileSync(path.join(archived, '.agent/.observability/hooks.jsonl'), 'utf8'),
    'observations',
  );
  assert.equal(existsSync(task), false);
});

// F310: macpro-audiolab-4's task held a worker's 14 GB baseline checkout (node_modules and Android
// builds), and packing it outlasted the 120 s tar budget, so the slot stayed held. Stub sizes.
function baselineCheckout(f: ReturnType<typeof fixture>, retention = 'retention') {
  const origin = path.join(f.root, 'origin.git');
  git(f.root, 'init', '-q', '--bare', '-b', 'main', origin);
  const seed = path.join(f.root, 'seed');
  mkdirSync(seed);
  git(seed, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(seed, '.gitignore'), 'node_modules/\nbuild/\n');
  writeFileSync(path.join(seed, 'README.md'), 'baseline');
  git(seed, 'add', '.');
  git(seed, 'commit', '-q', '-m', 'seed');
  git(seed, 'push', '-q', origin, 'main');
  const checkouts = path.join(f.repo, '.task/qa/example/checkouts');
  mkdirSync(checkouts, { recursive: true });
  // On a slot host this is $HOME/slot-retained.
  mkdirSync(path.join(f.root, retention));
  return { origin, checkouts, retainedBase: path.join(f.root, retention, 'slot-retained') };
}

function withBuildOutputs(checkout: string) {
  mkdirSync(path.join(checkout, 'apps/playground/node_modules/pkg'), { recursive: true });
  writeFileSync(path.join(checkout, 'apps/playground/node_modules/pkg/index.js'), 'dependency');
  mkdirSync(path.join(checkout, 'apps/sherpa-voice/android/app/build/outputs'), {
    recursive: true,
  });
  writeFileSync(path.join(checkout, 'apps/sherpa-voice/android/app/build/outputs/app.apk'), 'apk');
}

function release(f: ReturnType<typeof fixture>, retainedBase: string) {
  return archiveSlotScaffolding(
    f.vars,
    {},
    {
      destination: f.destination,
      taskRelativeDir: 'qa/example',
      beforeRemove: async () => undefined,
      retainedBase,
    },
  );
}

type Skipped = Array<{
  path: string;
  kind: string;
  sizeBytes: number;
  retainedAt?: string;
  linkedWorktree?: boolean;
  dirtyFiles?: number;
  stashes?: number;
  remote?: string;
  head?: string;
}>;

test('a release moves a nested checkout aside and lists build outputs instead of packing them', async (t) => {
  const f = fixture(t);
  git(f.repo, 'init', '-q', '-b', 'main');
  scaffolding(f.repo);
  const { origin, checkouts, retainedBase } = baselineCheckout(f);
  const baseline = path.join(checkouts, 'baseline');
  git(f.root, 'clone', '-q', origin, baseline);
  withBuildOutputs(baseline);
  const task = path.join(f.repo, '.task/qa/example');
  mkdirSync(path.join(task, 'app/android/app/build'), { recursive: true });
  writeFileSync(path.join(task, 'app/android/app/build/classes.dex'), 'built');
  mkdirSync(path.join(task, 'tools/node_modules/tool'), { recursive: true });
  writeFileSync(path.join(task, 'tools/node_modules/tool/index.js'), 'dependency');
  await excludeSlotScaffolding(f.vars, {}, execute);
  const result = await release(f, retainedBase);
  const archived = unpack(result.directory, f.root);
  assert.equal(
    readFileSync(path.join(archived, '.task/qa/example/TASK.md'), 'utf8'),
    'completed task',
  );
  for (const rebuilt of ['checkouts/baseline', 'app/android/app/build', 'tools/node_modules'])
    assert.equal(existsSync(path.join(archived, '.task/qa/example', rebuilt)), false, rebuilt);
  const { skipped } = JSON.parse(
    readFileSync(path.join(result.directory, 'manifest.json'), 'utf8'),
  ) as {
    skipped: Skipped;
  };
  assert.deepEqual(skipped.map((entry) => [entry.kind, entry.path]).sort(), [
    ['checkout', '.task/qa/example/checkouts/baseline'],
    ['rebuildable', '.task/qa/example/app/android/app/build'],
    ['rebuildable', '.task/qa/example/tools/node_modules'],
  ]);
  const checkout = skipped.find((entry) => entry.kind === 'checkout')!;
  assert.equal(checkout.remote, origin);
  assert.equal(checkout.head, git(origin, 'rev-parse', 'main'));
  assert.ok(checkout.retainedAt?.startsWith(path.join(retainedBase, 'fixture-slot')));
  // Nothing in the checkout is lost, its build outputs included.
  assert.equal(readFileSync(path.join(checkout.retainedAt!, 'README.md'), 'utf8'), 'baseline');
  assert.ok(
    existsSync(path.join(checkout.retainedAt!, 'apps/playground/node_modules/pkg/index.js')),
  );
  const retained = await measureSlotRetention(f.vars, retainedBase);
  assert.equal(retained?.items, 1);
  assert.ok((retained?.bytes ?? 0) > 0);
  assert.equal(existsSync(task), false, 'the released task is removed');
});

test('a checkout with a stash, untracked and ignored files moves intact', async (t) => {
  const f = fixture(t);
  git(f.repo, 'init', '-q', '-b', 'main');
  scaffolding(f.repo);
  const { origin, checkouts, retainedBase } = baselineCheckout(f);
  const work = path.join(checkouts, 'work');
  git(f.root, 'clone', '-q', origin, work);
  writeFileSync(path.join(work, 'README.md'), 'stashed edit');
  git(work, 'stash', '-q');
  writeFileSync(path.join(work, 'notes.md'), 'untracked notes');
  writeFileSync(path.join(work, '.git/info/exclude'), 'recordings/\n');
  mkdirSync(path.join(work, 'recordings'));
  writeFileSync(path.join(work, 'recordings/take.wav'), 'ignored recording');
  await excludeSlotScaffolding(f.vars, {}, execute);
  const result = await release(f, retainedBase);
  const { skipped } = JSON.parse(
    readFileSync(path.join(result.directory, 'manifest.json'), 'utf8'),
  ) as {
    skipped: Skipped;
  };
  const moved = skipped.find((entry) => entry.kind === 'checkout')!;
  assert.equal(moved.stashes, 1);
  assert.equal(moved.dirtyFiles, 1, 'the untracked notes');
  assert.equal(readFileSync(path.join(moved.retainedAt!, 'notes.md'), 'utf8'), 'untracked notes');
  assert.equal(
    readFileSync(path.join(moved.retainedAt!, 'recordings/take.wav'), 'utf8'),
    'ignored recording',
  );
  assert.match(git(moved.retainedAt!, 'stash', 'list'), /stash@\{0\}/);
});

test('a moved linked worktree stays registered at its new path', async (t) => {
  const f = fixture(t);
  git(f.repo, 'init', '-q', '-b', 'main');
  scaffolding(f.repo);
  const { origin, checkouts, retainedBase } = baselineCheckout(f);
  const main = path.join(f.root, 'canonical');
  git(f.root, 'clone', '-q', origin, main);
  const linked = path.join(checkouts, 'baseline');
  git(main, 'worktree', 'add', '-q', '--detach', linked, 'main');
  await excludeSlotScaffolding(f.vars, {}, execute);
  const result = await release(f, retainedBase);
  const { skipped } = JSON.parse(
    readFileSync(path.join(result.directory, 'manifest.json'), 'utf8'),
  ) as {
    skipped: Skipped;
  };
  const moved = skipped.find((entry) => entry.kind === 'checkout')!;
  assert.equal(moved.linkedWorktree, true);
  const worktrees = git(main, 'worktree', 'list', '--porcelain');
  assert.match(worktrees, new RegExp(`worktree ${realpathSync(moved.retainedAt!)}\n`));
  assert.doesNotMatch(worktrees, /prunable/);
  assert.equal(git(moved.retainedAt!, 'rev-parse', 'HEAD'), git(origin, 'rev-parse', 'main'));
});

test('a nested checkout that would cross a volume keeps the task and refuses release', async (t) => {
  const f = fixture(t);
  git(f.repo, 'init', '-q', '-b', 'main');
  scaffolding(f.repo);
  // The stub df puts this retention directory on another device than the slot repository.
  const { origin, checkouts, retainedBase } = baselineCheckout(f, 'cross-volume');
  git(f.root, 'clone', '-q', origin, path.join(checkouts, 'baseline'));
  await excludeSlotScaffolding(f.vars, {}, execute);
  await assert.rejects(
    release(f, retainedBase),
    /cannot be moved aside: .*cross-volume.* is not on the volume of/,
  );
  assert.equal(readFileSync(path.join(checkouts, 'baseline/README.md'), 'utf8'), 'baseline');
  assert.equal(
    readFileSync(path.join(f.repo, '.task/qa/example/TASK.md'), 'utf8'),
    'completed task',
  );
});

test('a clone and its own linked worktree move together and stay connected', async (t) => {
  const f = fixture(t);
  git(f.repo, 'init', '-q', '-b', 'main');
  scaffolding(f.repo);
  const { origin, checkouts, retainedBase } = baselineCheckout(f);
  // A worker clones the source, then adds a baseline worktree of that clone next to it.
  const source = path.join(checkouts, 'source');
  git(f.root, 'clone', '-q', origin, source);
  git(source, 'worktree', 'add', '-q', '--detach', path.join(checkouts, 'baseline'), 'main');
  await excludeSlotScaffolding(f.vars, {}, execute);
  const result = await release(f, retainedBase);
  const { skipped } = JSON.parse(
    readFileSync(path.join(result.directory, 'manifest.json'), 'utf8'),
  ) as {
    skipped: Skipped;
  };
  const at = (name: string) =>
    skipped.find((entry) => entry.path.endsWith(`checkouts/${name}`))!.retainedAt!;
  const worktrees = git(at('source'), 'worktree', 'list', '--porcelain');
  assert.match(worktrees, new RegExp(`worktree ${realpathSync(at('baseline'))}\n`));
  assert.doesNotMatch(worktrees, /prunable/);
  assert.equal(git(at('baseline'), 'rev-parse', 'HEAD'), git(origin, 'rev-parse', 'main'));
  const retained = await measureSlotRetention(f.vars, retainedBase);
  assert.equal(retained?.items, 2);
  assert.ok((retained?.bytes ?? 0) > 0);
});

test('a clone under the configured task root and its worktree under the legacy one stay connected', async (t) => {
  const f = fixture(t);
  git(f.repo, 'init', '-q', '-b', 'main');
  scaffolding(f.repo);
  const project = { task_dir: 'support/tasks', paths: { runtime_dir: '.agent' } };
  const { origin, checkouts, retainedBase } = baselineCheckout(f);
  const source = path.join(f.repo, 'support/tasks/qa/example/checkouts/source');
  mkdirSync(path.dirname(source), { recursive: true });
  git(f.root, 'clone', '-q', origin, source);
  git(source, 'worktree', 'add', '-q', '--detach', path.join(checkouts, 'baseline'), 'main');
  await excludeSlotScaffolding(f.vars, project, execute);
  const result = await archiveSlotScaffolding(f.vars, project, {
    destination: f.destination,
    taskRelativeDir: 'qa/example',
    beforeRemove: async () => undefined,
    retainedBase,
  });
  const { skipped } = JSON.parse(
    readFileSync(path.join(result.directory, 'manifest.json'), 'utf8'),
  ) as {
    skipped: Skipped;
  };
  const at = (name: string) =>
    skipped.find((entry) => entry.path.endsWith(`checkouts/${name}`))!.retainedAt!;
  const worktrees = git(at('source'), 'worktree', 'list', '--porcelain');
  assert.match(worktrees, new RegExp(`worktree ${realpathSync(at('baseline'))}\n`));
  assert.doesNotMatch(worktrees, /prunable/);
  assert.equal(git(at('baseline'), 'rev-parse', 'HEAD'), git(origin, 'rev-parse', 'main'));
});

test('a retention directory linked onto another volume refuses the move', async (t) => {
  const f = fixture(t);
  git(f.repo, 'init', '-q', '-b', 'main');
  scaffolding(f.repo);
  const { origin, checkouts, retainedBase } = baselineCheckout(f);
  git(f.root, 'clone', '-q', origin, path.join(checkouts, 'baseline'));
  // An operator relocated the retention directory: it exists, as a link to another volume.
  const elsewhere = path.join(f.root, 'cross-volume-disk');
  mkdirSync(elsewhere);
  symlinkSync(elsewhere, retainedBase);
  await excludeSlotScaffolding(f.vars, {}, execute);
  await assert.rejects(
    release(f, retainedBase),
    /cannot be moved aside: .* is not on the volume of/,
  );
  assert.equal(readFileSync(path.join(checkouts, 'baseline/README.md'), 'utf8'), 'baseline');
});

// F310: a retry loop ran several collections for audiolab-6 at once, each streaming a 6 GB
// archive into macwork's last free space.
test('a second collection for the same slot refuses while the first runs', async (t) => {
  const f = fixture(t);
  scaffolding(f.repo);
  let resume!: () => void;
  const paused = new Promise<void>((resolve) => (resume = resolve));
  let reachedRemove!: () => void;
  const removing = new Promise<void>((resolve) => (reachedRemove = resolve));
  const first = archiveSlotScaffolding(
    f.vars,
    {},
    {
      destination: f.destination,
      taskRelativeDir: 'qa/example',
      beforeRemove: async () => {
        reachedRemove();
        await paused;
      },
    },
  );
  await removing;
  await assert.rejects(
    archiveSlotScaffolding(
      f.vars,
      {},
      {
        destination: f.destination,
        taskRelativeDir: 'qa/example',
        beforeRemove: async () => undefined,
      },
    ),
    /A scaffolding collection for fixture-slot is already running/,
  );
  resume();
  assert.equal((await first).roots > 0, true);
});

test('an archive over the size limit refuses before download and leaves nothing behind', async (t) => {
  const f = fixture(t);
  scaffolding(f.repo);
  await assert.rejects(
    archiveSlotScaffolding(
      f.vars,
      {},
      {
        destination: f.destination,
        taskRelativeDir: 'qa/example',
        beforeRemove: async () => undefined,
        maxArchiveBytes: 1,
      },
    ),
    /Scaffolding archive is \d+ MB, over the \d+ MB limit/,
  );
  assert.equal(existsSync(f.destination), false, 'no archive directory or partial download');
  assert.equal(
    readFileSync(path.join(f.repo, '.task/qa/example/TASK.md'), 'utf8'),
    'completed task',
  );
});

test('a collection that fails after its download leaves no partial archive', async (t) => {
  const f = fixture(t);
  scaffolding(f.repo);
  const obs = path.join(runnerRuntimeDir(f.repo), '.observability');
  mkdirSync(obs, { recursive: true });
  writeFileSync(path.join(obs, 'unreadable.jsonl'), 'observations');
  chmodSync(path.join(obs, 'unreadable.jsonl'), 0o000);
  await assert.rejects(
    archiveSlotScaffolding(
      f.vars,
      {},
      {
        destination: f.destination,
        taskRelativeDir: 'qa/example',
        beforeRemove: async () => undefined,
      },
    ),
    /Cannot pack runner observations/,
  );
  assert.deepEqual(existsSync(f.destination) ? readdirSync(f.destination) : [], []);
  assert.equal(
    readFileSync(path.join(f.repo, '.task/qa/example/TASK.md'), 'utf8'),
    'completed task',
  );
});

test('the configured and the legacy task root both keep their text and drop binaries', async (t) => {
  const f = fixture(t);
  scaffolding(f.repo);
  mkdirSync(path.join(f.repo, '.task/qa/example/artifacts'), { recursive: true });
  writeFileSync(path.join(f.repo, '.task/qa/example/artifacts/legacy.json'), 'legacy evidence');
  mkdirSync(path.join(f.repo, 'support/tasks/qa/example/artifacts'), { recursive: true });
  writeFileSync(path.join(f.repo, 'support/tasks/qa/example/TASK.md'), 'current task');
  writeFileSync(path.join(f.repo, 'support/tasks/qa/example/artifacts/copied.bin'), 'collected');
  const project = { task_dir: 'support/tasks', paths: { runtime_dir: '.agent' } };
  const result = await archiveSlotScaffolding(f.vars, project, {
    destination: f.destination,
    taskRelativeDir: 'qa/example',
    beforeRemove: async () => undefined,
  });
  const archived = unpack(result.directory, f.root);
  assert.equal(
    readFileSync(path.join(archived, '.task/qa/example/artifacts/legacy.json'), 'utf8'),
    'legacy evidence',
  );
  assert.equal(existsSync(path.join(archived, 'support/tasks/qa/example/artifacts')), false);
  assert.equal(
    readFileSync(path.join(archived, 'support/tasks/qa/example/TASK.md'), 'utf8'),
    'current task',
  );
});

test('a shared task/runtime namespace keeps warm files outside the released task', async (t) => {
  const f = fixture(t);
  scaffolding(f.repo, '.runtime', '.runtime');
  const project = { task_dir: '.runtime', paths: { runtime_dir: '.runtime' } };
  await archiveSlotScaffolding(f.vars, project, {
    destination: f.destination,
    taskRelativeDir: 'qa/example',
    beforeRemove: async () => undefined,
  });
  assert.equal(
    readFileSync(path.join(f.repo, '.runtime/browser/profile.json'), 'utf8'),
    'warm resource',
  );
  assert.equal(existsSync(path.join(f.repo, '.runtime/qa/example')), false);
});

test('failed collection retains every original before teardown cleanup', async (t) => {
  const f = fixture(t);
  scaffolding(f.repo);
  const outside = path.join(f.root, 'outside');
  mkdirSync(outside);
  writeFileSync(path.join(outside, 'user.txt'), 'outside user data');
  rmSync(path.join(f.repo, '.agent'), { recursive: true });
  symlinkSync(outside, path.join(f.repo, '.agent'));
  mkdirSync(path.join(outside, '.observability'));
  writeFileSync(path.join(outside, '.observability/hooks.jsonl'), 'observations');
  await assert.rejects(
    archiveSlotScaffolding(
      f.vars,
      {},
      { destination: f.destination, taskRelativeDir: null, beforeRemove: async () => undefined },
    ),
    /Scaffolding parent escapes slot repository/,
  );
  assert.equal(
    readFileSync(path.join(f.repo, '.task/qa/example/TASK.md'), 'utf8'),
    'completed task',
  );
  assert.equal(
    readFileSync(path.join(f.repo, '.agent/.observability/hooks.jsonl'), 'utf8'),
    'observations',
  );
  assert.equal(readFileSync(path.join(outside, 'user.txt'), 'utf8'), 'outside user data');
});

test('a rival claim prevents deleting the collected sources', async (t) => {
  const f = fixture(t);
  scaffolding(f.repo);
  await assert.rejects(
    archiveSlotScaffolding(
      f.vars,
      {},
      {
        destination: f.destination,
        taskRelativeDir: null,
        beforeRemove: async () => {
          throw new Error('owner changed');
        },
      },
    ),
    /owner changed/,
  );
  assert.equal(
    readFileSync(path.join(f.repo, '.task/qa/example/TASK.md'), 'utf8'),
    'completed task',
  );
  assert.equal(existsSync(path.join(f.repo, '.observability')), true);
});

test('an archive destination failure preserves all slot scaffolding', async (t) => {
  const f = fixture(t);
  scaffolding(f.repo);
  writeFileSync(f.destination, 'not a directory');
  await assert.rejects(
    archiveSlotScaffolding(
      f.vars,
      {},
      { destination: f.destination, taskRelativeDir: null, beforeRemove: async () => undefined },
    ),
    /ENOTDIR|EEXIST/,
  );
  assert.equal(
    readFileSync(path.join(f.repo, '.task/qa/example/TASK.md'), 'utf8'),
    'completed task',
  );
  assert.equal(
    readFileSync(path.join(f.repo, '.agent/.observability/hooks.jsonl'), 'utf8'),
    'observations',
  );
});

test('configured paths also collect scaffolding left in legacy default namespaces', async (t) => {
  const f = fixture(t);
  scaffolding(f.repo);
  mkdirSync(path.join(f.repo, 'support/tasks/qa/example'), { recursive: true });
  writeFileSync(path.join(f.repo, 'support/tasks/qa/example/TASK.md'), 'current task');
  mkdirSync(path.join(f.repo, '.runtime/.observability'), { recursive: true });
  writeFileSync(path.join(f.repo, '.runtime/.observability/hooks.jsonl'), 'current observations');
  const project = { task_dir: 'support/tasks', paths: { runtime_dir: '.runtime' } };
  const result = await archiveSlotScaffolding(f.vars, project, {
    destination: f.destination,
    taskRelativeDir: 'qa/example',
    beforeRemove: async () => undefined,
  });
  const archived = unpack(result.directory, f.root);
  assert.equal(
    readFileSync(path.join(archived, '.task/qa/example/TASK.md'), 'utf8'),
    'completed task',
  );
  assert.equal(
    readFileSync(path.join(archived, '.agent/.observability/hooks.jsonl'), 'utf8'),
    'observations',
  );
  assert.equal(
    readFileSync(path.join(archived, 'support/tasks/qa/example/TASK.md'), 'utf8'),
    'current task',
  );
  assert.equal(
    readFileSync(path.join(f.repo, '.agent/browser/profile.json'), 'utf8'),
    'warm resource',
  );
});

test('releasing one task retains a parked sibling task and its evidence', async (t) => {
  const f = fixture(t);
  scaffolding(f.repo);
  mkdirSync(path.join(f.repo, '.task/qa/parked/artifacts'), { recursive: true });
  writeFileSync(path.join(f.repo, '.task/qa/parked/TASK.md'), 'parked task');
  writeFileSync(path.join(f.repo, '.task/qa/parked/artifacts/evidence.txt'), 'parked evidence');
  const result = await archiveSlotScaffolding(
    f.vars,
    {},
    {
      destination: f.destination,
      taskRelativeDir: 'qa/example',
      beforeRemove: async () => undefined,
    },
  );
  assert.equal(readFileSync(path.join(f.repo, '.task/qa/parked/TASK.md'), 'utf8'), 'parked task');
  assert.equal(
    readFileSync(path.join(f.repo, '.task/qa/parked/artifacts/evidence.txt'), 'utf8'),
    'parked evidence',
  );
  assert.equal(existsSync(path.join(f.repo, '.task/qa/example')), false);
  const contents = execFileSync('tar', ['-tf', path.join(result.directory, 'scaffolding.tar')], {
    encoding: 'utf8',
  });
  assert.doesNotMatch(contents, /qa\/parked/);
});

test('a release without a task path retains the shared task root', async (t) => {
  const f = fixture(t);
  scaffolding(f.repo);
  await archiveSlotScaffolding(
    f.vars,
    {},
    { destination: f.destination, taskRelativeDir: null, beforeRemove: async () => undefined },
  );
  assert.equal(
    readFileSync(path.join(f.repo, '.task/qa/example/TASK.md'), 'utf8'),
    'completed task',
  );
});

test('release archives external observations as bytes and clears them while retaining the runner home', async (t) => {
  const f = fixture(t);
  const runtime = runnerRuntimeDir(f.repo);
  const obs = path.join(runtime, '.observability');
  mkdirSync(path.join(obs, 'sessions'), { recursive: true });
  writeFileSync(path.join(obs, 'hooks.jsonl'), 'retained hooks');
  writeFileSync(path.join(obs, 'sessions/session.json'), 'retained session');
  mkdirSync(path.join(runtime, 'codex-home'), { recursive: true });
  writeFileSync(path.join(runtime, 'codex-home/history.jsonl'), 'history');
  mkdirSync(path.join(f.repo, '.agent'), { recursive: true });
  symlinkSync(obs, path.join(f.repo, '.agent/.observability'));
  symlinkSync(obs, path.join(f.repo, '.observability'));
  const result = await archiveSlotScaffolding(
    f.vars,
    {},
    { destination: f.destination, taskRelativeDir: null, beforeRemove: async () => undefined },
  );
  const extracted = path.join(f.root, 'observations');
  mkdirSync(extracted);
  execFileSync('tar', [
    '-xf',
    path.join(result.directory, 'runner-observability.tar'),
    '-C',
    extracted,
  ]);
  assert.equal(readFileSync(path.join(extracted, 'hooks.jsonl'), 'utf8'), 'retained hooks');
  assert.equal(
    readFileSync(path.join(extracted, 'sessions/session.json'), 'utf8'),
    'retained session',
  );
  assert.equal(existsSync(obs), false);
  assert.equal(readFileSync(path.join(runtime, 'codex-home/history.jsonl'), 'utf8'), 'history');
});

for (const homeRelative of [false, true]) {
  test(`release archives configured ${homeRelative ? 'home-relative' : 'absolute'} runtime bytes`, async (t) => {
    const f = fixture(t);
    const beforeHome = process.env.HOME;
    try {
      process.env.HOME = f.root;
      const runtime = path.join(f.root, 'state');
      const obs = path.join(runtime, '.observability');
      mkdirSync(obs, { recursive: true });
      writeFileSync(path.join(obs, 'hooks.jsonl'), 'configured hooks');
      const result = await archiveSlotScaffolding(
        f.vars,
        { paths: { runtime_dir: homeRelative ? '~/state' : runtime } },
        { destination: f.destination, taskRelativeDir: null, beforeRemove: async () => undefined },
      );
      const extracted = path.join(f.root, 'extracted-observations');
      mkdirSync(extracted);
      execFileSync('tar', [
        '-xf',
        path.join(result.directory, 'runner-observability.tar'),
        '-C',
        extracted,
      ]);
      assert.equal(readFileSync(path.join(extracted, 'hooks.jsonl'), 'utf8'), 'configured hooks');
      assert.equal(existsSync(obs), false);
    } finally {
      if (beforeHome === undefined) delete process.env.HOME;
      else process.env.HOME = beforeHome;
    }
  });
}
