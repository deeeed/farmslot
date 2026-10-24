import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { runWorkspaceObservedRead } from '../resources/workspace-read.js';
import { makeVars } from '../runners/test-fixtures.js';

import { gitStatus } from './git.js';

const execFile = promisify(execFileCallback);

test('an observed Git status cannot refresh the watched index while reading unchanged bytes', async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'observed-git-status-'));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
  const git = (...args: string[]) => execFile('git', args, { cwd: repo, env });
  try {
    await git('init', '-b', 'main');
    const file = path.join(repo, 'tracked.txt');
    await writeFile(file, 'unchanged bytes\n');
    await git('add', 'tracked.txt');
    await git(
      '-c',
      'commit.gpgsign=false',
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@invalid',
      'commit',
      '-m',
      'test: seed observed Git fixture',
    );
    const before = await readFile(path.join(repo, '.git/index'));
    const clock = (await stat(file)).mtimeMs / 1000 + 5;
    await utimes(file, clock, clock);
    const result = await runWorkspaceObservedRead(() =>
      gitStatus(
        { slotId: 'owned' },
        {
          resolveRepo: async () => repo,
          loadVars: async () => makeVars({ repo, remoteRepo: repo }),
          runOnSlot: async (_vars, argv, options) => {
            try {
              const output = await execFile(argv[0], argv.slice(1), { cwd: options?.cwd, env });
              return { ...output, exitCode: 0 };
            } catch (error) {
              const failure = error as Error & { code: number; stdout: string; stderr: string };
              if (typeof failure.code !== 'number') throw error;
              return { stdout: failure.stdout, stderr: failure.stderr, exitCode: failure.code };
            }
          },
        },
      ),
    );
    assert.deepEqual(result.changes, []);
    assert.deepEqual(await readFile(path.join(repo, '.git/index')), before);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
