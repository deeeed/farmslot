import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mock, test, type TestContext } from 'node:test';

import { execLocal } from '../core/exec.js';
import { withSlotCommandExecutor } from '../core/exec-scope.js';
import { makeVars } from '../runners/test-fixtures.js';

import { makeRun } from './test-fixtures.js';

let repo = '';
let projectBudget: string | undefined;
let poolBudget: string | undefined;
const config = await import('../core/config.js');
mock.module('../core/config.js', {
  namedExports: {
    ...config,
    loadSlotVars: async () =>
      makeVars({
        host: 'localhost',
        remoteRepo: repo,
        projectName: 'fixture',
        machineEnv: poolBudget ? { FARMSLOT_GIT_PUSH_TIMEOUT_MS: poolBudget } : {},
      }),
    loadProjectVars: async () => ({
      projectJson: {
        command_env: { set: projectBudget ? { FARMSLOT_GIT_PUSH_TIMEOUT_MS: projectBudget } : {} },
      },
    }),
  },
});
const { pushPublicationBranch, PUBLICATION_PUSH_TIMEOUT_MS } =
  await import('./publication-push.js');

function fixture(t: TestContext, hook: string) {
  const root = mkdtempSync(path.join(tmpdir(), 'publication-budget-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  repo = path.join(root, 'repo');
  const remote = path.join(root, 'origin.git');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], { env, encoding: 'utf8', stdio: 'pipe' }).trim();
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { env });
  execFileSync('git', ['init', '-q', '--bare', remote], { env });
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('commit', '--allow-empty', '-qm', 'test: fixture');
  git('remote', 'add', 'origin', remote);
  git('push', '-q', 'origin', 'main');
  git('checkout', '-qb', 'fix/fixture');
  git('commit', '--allow-empty', '-qm', 'test: branch');
  const head = git('rev-parse', 'HEAD');
  writeFileSync(path.join(repo, '.git/hooks/pre-push'), `#!/bin/sh\n${hook}\n`, { mode: 0o755 });
  const budgets: number[] = [];
  const run = makeRun({ slotId: 'fixture', branch: 'fix/fixture' });
  const push = () =>
    withSlotCommandExecutor(
      async (_vars, command, options) => {
        if (command.includes('push -u origin')) budgets.push(options.timeout ?? 0);
        return execLocal(command, { ...options, cwd: repo });
      },
      () => pushPublicationBranch(run, head, 'main'),
    );
  projectBudget = undefined;
  poolBudget = undefined;
  return { git, push, budgets };
}

test('publication gives hooks a separate fifteen-minute default push budget', async (t) => {
  const f = fixture(t, 'echo ran > hook-ran');
  await f.push();
  assert.equal(readFileSync(path.join(repo, 'hook-ran'), 'utf8'), 'ran\n');
  assert.deepEqual(f.budgets, [900_000]);
  assert.equal(PUBLICATION_PUSH_TIMEOUT_MS, 900_000);
});

test('a slow pre-push hook succeeds within the project push budget', async (t) => {
  const f = fixture(t, 'sleep 0.05\necho ran > hook-ran');
  projectBudget = '2500';
  await f.push();
  assert.deepEqual(f.budgets, [2500]);
  assert.equal(readFileSync(path.join(repo, 'hook-ran'), 'utf8'), 'ran\n');
  assert.equal(f.git('rev-parse', 'origin/fix/fixture'), f.git('rev-parse', 'HEAD'));
});

test('pool push budget wins and a slow hook timeout names its budget', async (t) => {
  const f = fixture(t, 'echo started > hook-started\nsleep 0.8\necho ran > hook-ran');
  projectBudget = '2500';
  poolBudget = '500';
  await assert.rejects(f.push(), /git push.*timed out.*500 ms.*pre-push hook budget/);
  assert.deepEqual(f.budgets, [500]);
  assert.ok(existsSync(path.join(repo, 'hook-started')));
  assert.equal(existsSync(path.join(repo, 'hook-ran')), false);
  assert.equal(f.git('ls-remote', 'origin', 'refs/heads/fix/fixture'), '');
});

test('invalid configured push budgets fail before publication', async (t) => {
  const f = fixture(t, 'echo ran > hook-ran');
  for (const invalid of ['0', '-1', 'nope', '1.5', '2147483648']) {
    projectBudget = invalid;
    await assert.rejects(f.push(), /FARMSLOT_GIT_PUSH_TIMEOUT_MS.*positive integer/);
  }
  assert.deepEqual(f.budgets, []);
});
