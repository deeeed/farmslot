import { execFileSync } from 'node:child_process';
import { closeSync, constants, createReadStream, openSync, writeSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
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

/**
 * A FIFO a task fixture opens for writing and hands to its subprocesses. The test reads the
 * lines the fixture writes, and `closed()` resolves once every process holding it has exited:
 * no deadline, the test's own timeout is the only bound.
 */
export async function taskPipe(t: test.TestContext) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'task-pipe-')));
  const fifo = path.join(directory, 'pipe');
  execFileSync('mkfifo', [fifo]);
  const stream = createReadStream(fifo, { encoding: 'utf8' });
  const lines = createInterface({ input: stream })[Symbol.asyncIterator]();
  t.after(() => {
    // Wake a read still waiting on a fixture that never wrote or never exited, then stop.
    let writer: number | undefined;
    try {
      writer = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
      writeSync(writer, '\n');
    } catch (error) {
      // ENXIO: no reader was left. EPIPE: the reader closed as this wrote. The stream ended.
      if (
        !(error instanceof Error) ||
        !('code' in error) ||
        (error.code !== 'ENXIO' && error.code !== 'EPIPE')
      )
        throw error;
    } finally {
      if (writer !== undefined) closeSync(writer);
    }
    stream.destroy();
    return rm(directory, { recursive: true, force: true });
  });
  return {
    path: fifo,
    async line(): Promise<string> {
      const next = await lines.next();
      if (next.done) throw new Error('the task pipe closed before the expected line');
      return next.value;
    },
    async closed(): Promise<void> {
      while (!(await lines.next()).done);
    },
  };
}
