import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';
import { promisify } from 'node:util';

import type { ExecResult } from '@farmslot/protocol';

const execFileAsync = promisify(execFile);

const realPrepareCommand = await import('../methods/slot/prepare-command.js');
mock.module('../methods/slot/prepare-command.js', {
  namedExports: {
    ...realPrepareCommand,
    runPrepareCommand: async (): Promise<ExecResult> => ({
      stdout: 'state-only dependency phase completed\n',
      stderr: '',
      exitCode: 0,
    }),
  },
});
const realFixtures = await import('../methods/slot/fixtures.js');
mock.module('../methods/slot/fixtures.js', {
  namedExports: { ...realFixtures, runFixtureSync: async () => undefined },
});

const { slotPrepare } = await import('../methods/slot.js');

const gitEnv = ['-c', 'user.name=Farmslot Test', '-c', 'user.email=farmslot-test@example.invalid'];

async function git(repo: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', repo, ...gitEnv, ...args]);
  return stdout.trim();
}

// Regression: a QA dispatch to a slot that was already on the PR branch returned
// no start-ref provenance (the dispatch refused it), and would otherwise have
// reported the requested ref while the tree sat at origin/<branch>.
test('a slot already on the work branch resolves the requested start ref and resets its tree to it', async (t) => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'farmslot-start-ref-current-'));
  const slotRepo = path.join(fixtureRoot, 'slot');
  const originRepo = path.join(fixtureRoot, 'origin.git');
  const repoRoot = path.resolve(new URL('../../../../', import.meta.url).pathname);
  const slotId = `start-ref-current-${process.pid}`;
  const poolPath = path.join(repoRoot, 'pool', `${slotId}.json`);
  t.after(async () => {
    await rm(poolPath, { force: true });
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  await execFileAsync('git', ['init', '--initial-branch=main', slotRepo]);
  await execFileAsync('git', ['init', '--bare', '--initial-branch=main', originRepo]);
  await writeFile(path.join(slotRepo, 'README.md'), 'fixture\n');
  await git(slotRepo, 'add', 'README.md');
  await git(slotRepo, 'commit', '-m', 'fixture');
  await git(slotRepo, 'remote', 'add', 'origin', originRepo);
  await git(slotRepo, 'push', '--set-upstream', 'origin', 'main');
  // The work branch: the frozen head (A), then a later push (B) that origin holds.
  await git(slotRepo, 'checkout', '-b', 'work');
  await writeFile(path.join(slotRepo, 'a.txt'), 'A\n');
  await git(slotRepo, 'add', 'a.txt');
  await git(slotRepo, 'commit', '-m', 'A');
  const frozenHead = await git(slotRepo, 'rev-parse', 'HEAD');
  await writeFile(path.join(slotRepo, 'b.txt'), 'B\n');
  await git(slotRepo, 'add', 'b.txt');
  await git(slotRepo, 'commit', '-m', 'B');
  const laterHead = await git(slotRepo, 'rev-parse', 'HEAD');
  await git(slotRepo, 'push', '--set-upstream', 'origin', 'work');
  assert.notEqual(frozenHead, laterHead);

  await writeFile(
    poolPath,
    `${JSON.stringify(
      {
        machine: os.hostname(),
        project: 'farmslot-farm',
        platform: 'cli',
        host: 'localhost',
        slots: [
          {
            id: slotId,
            repo: slotRepo,
            session: slotId,
            enabled: true,
            mode: 'dispatch',
            resources: { 'dev-server': { port: 48810, metro_port: 48880 } },
          },
        ],
      },
      null,
      2,
    )}\n`,
  );

  const events: Array<{ event: string; payload: unknown }> = [];
  const result = await slotPrepare(
    { slotId, branch: 'work', prepareProfile: 'core' },
    (event, payload) => events.push({ event, payload }),
    undefined,
    { startRef: { requestedRef: frozenHead } },
  );

  assert.equal(result.prepared, true);
  assert.equal(result.startRef?.requestedRef, frozenHead, 'start ref provenance is missing');
  assert.equal(result.startRef?.resolvedSha, frozenHead);
  assert.equal(await git(slotRepo, 'branch', '--show-current'), 'work');
  assert.equal(
    await git(slotRepo, 'rev-parse', 'HEAD'),
    frozenHead,
    'the slot tree must sit at the resolved start ref, not at origin/work',
  );
  // Later prepare phases create the untracked sandbox dir; the tree itself must be clean.
  const status = (await git(slotRepo, 'status', '--porcelain'))
    .split('\n')
    .filter((line) => line && !line.startsWith('?? .sandbox/'));
  assert.deepEqual(status, []);
  const eventText = JSON.stringify(events);
  assert.match(eventText, /reset to requested start ref/);
});
