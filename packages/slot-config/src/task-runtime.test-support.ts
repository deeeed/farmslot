import { copyFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type test from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '../../..');

/** A CLI installation with the files the task runtime imports through the CLI's own tsx. */
export async function cliFixture(
  t: test.TestContext,
  init?: string,
): Promise<{ root: string; cli: string }> {
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
    init ??
      'export async function runHostedTaskInit(taskPath: string) { return { taskPath, pid: process.pid }; }',
  );
  return { root, cli };
}

export const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export async function until(condition: () => boolean, limitMs: number): Promise<boolean> {
  const deadline = Date.now() + limitMs;
  while (!condition() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  return condition();
}
