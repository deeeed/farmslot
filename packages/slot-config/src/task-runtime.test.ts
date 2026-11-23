import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runTaskRuntime } from './task-runtime.js';

const repoRoot = path.resolve(import.meta.dirname, '../../..');

/** A CLI installation with the files the task runtime imports through the CLI's own tsx. */
async function cliFixture(t: test.TestContext): Promise<{ root: string; cli: string }> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'task-runtime-reap-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = path.join(root, 'packages/cli');
  for (const directory of ['bin', 'src/commands', 'src/onboarding'])
    await mkdir(path.join(cli, directory), { recursive: true });
  await symlink(path.join(repoRoot, 'node_modules'), path.join(root, 'node_modules'));
  await writeFile(path.join(cli, 'package.json'), '{"type":"module"}');
  await writeFile(path.join(cli, 'bin/farmslot.mjs'), '');
  await writeFile(path.join(cli, 'tsconfig.json'), '{}');
  await copyFile(
    path.join(repoRoot, 'packages/cli/src/envelope.ts'),
    path.join(cli, 'src/envelope.ts'),
  );
  await writeFile(
    path.join(cli, 'src/onboarding/env-file.ts'),
    'export function loadCheckoutEnv() {}',
  );
  await writeFile(
    path.join(cli, 'src/onboarding/workspace.ts'),
    'export function repoRoot() { return "/fixture"; } export function bootstrapFarmslotHome() {}',
  );
  await writeFile(
    path.join(cli, 'src/commands/hosted-task-init.ts'),
    'export async function runHostedTaskInit(taskPath: string) { return { taskPath, pid: process.pid }; }',
  );
  return { root, cli };
}

/** Exited children of this process that nobody waited for. */
function zombieChildren(): number {
  return execFileSync('ps', ['-axo', 'ppid=,stat='], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter(([ppid, stat]) => Number(ppid) === process.pid && stat?.startsWith('Z')).length;
}

// Each run loads the CLI through tsx, whose loader starts an esbuild service child.
// Run inside a worker thread, that child outlived the thread and was never reaped.
test('task runs leave no unreaped child processes behind', { timeout: 60_000 }, async (t) => {
  const { root, cli } = await cliFixture(t);
  const runs = 3;
  const before = zombieChildren();
  for (let run = 0; run < runs; run++) {
    const result = await runTaskRuntime(
      {
        action: 'init',
        taskPath: path.join(root, `task-${run}.json`),
        supportDir: root,
        env: { FARMSLOT_CLI: path.join(cli, 'bin/farmslot.mjs') },
      },
      root,
    );
    assert.equal(result.exitCode, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.data.taskPath, path.join(root, `task-${run}.json`));
  }
  // An exited child is reaped on its parent's next turn; give that a moment.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(zombieChildren() - before, 0, `${runs} task runs left unreaped children`);
});
