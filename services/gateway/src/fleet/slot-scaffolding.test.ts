import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { SlotVars } from '../core/config.js';

await import('../runtime/mock-pty.test-support.js');
const { archiveSlotScaffolding, excludeSlotScaffolding } = await import('./slot-scaffolding.js');

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
