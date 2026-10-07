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

/**
 * Origin holds main and an upstream PR branch pushed from another clone, the
 * way another slot or node publishes it. The slot itself has never seen that
 * branch: origin is the only way to reach it.
 */
async function stackFixture(t: import('node:test').TestContext, label: string, port: number) {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), `farmslot-stack-${label}-`));
  const originRepo = path.join(fixtureRoot, 'origin.git');
  const otherSlot = path.join(fixtureRoot, 'other-slot');
  const slotRepo = path.join(fixtureRoot, 'slot');
  const repoRoot = path.resolve(new URL('../../../../', import.meta.url).pathname);
  const slotId = `stack-${label}-${process.pid}`;
  const poolPath = path.join(repoRoot, 'pool', `${slotId}.json`);
  t.after(async () => {
    await rm(poolPath, { force: true });
    await rm(fixtureRoot, { recursive: true, force: true });
  });
  await execFileAsync('git', ['init', '--bare', '--initial-branch=main', originRepo]);
  await execFileAsync('git', ['init', '--initial-branch=main', otherSlot]);
  await writeFile(path.join(otherSlot, 'README.md'), 'fixture\n');
  await git(otherSlot, 'add', 'README.md');
  await git(otherSlot, 'commit', '-m', 'fixture');
  await git(otherSlot, 'remote', 'add', 'origin', originRepo);
  await git(otherSlot, 'push', '--set-upstream', 'origin', 'main');
  const mainHead = await git(otherSlot, 'rev-parse', 'HEAD');
  await execFileAsync('git', ['clone', originRepo, slotRepo]);
  await git(otherSlot, 'checkout', '-b', 'feat/upstream');
  await writeFile(path.join(otherSlot, 'upstream.txt'), 'upstream work\n');
  await git(otherSlot, 'add', 'upstream.txt');
  await git(otherSlot, 'commit', '-m', 'upstream work');
  await git(otherSlot, 'push', 'origin', 'feat/upstream');
  const upstreamHead = await git(otherSlot, 'rev-parse', 'HEAD');
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
            resources: { 'dev-server': { port, metro_port: port + 70 } },
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  return { slotId, slotRepo, mainHead, upstreamHead };
}

test('a stacked fix-bug branch starts from the upstream PR head fetched from origin', async (t) => {
  const { slotId, slotRepo, upstreamHead } = await stackFixture(t, 'stacked', 48830);
  const events: unknown[] = [];
  const result = await slotPrepare(
    {
      slotId,
      branch: 'feat/stacked',
      prepareProfile: 'core',
      flowType: 'fix-bug',
      forceNewBranch: true,
    },
    (_event, payload) => events.push(payload),
    undefined,
    { stackBase: { requestedRef: 'feat/upstream' } },
  );
  assert.equal(result.stackBase?.resolvedSha, upstreamHead);
  assert.equal(result.startRef, undefined, 'a stack base is not a replay start ref');
  assert.equal(await git(slotRepo, 'branch', '--show-current'), 'feat/stacked');
  assert.equal(await git(slotRepo, 'rev-parse', 'HEAD'), upstreamHead);
  assert.match(JSON.stringify(events), /Created feat\/stacked from feat\/upstream/);
});

test('without a stack base the same prepare branches from the default branch', async (t) => {
  const { slotId, slotRepo, mainHead } = await stackFixture(t, 'plain', 48832);
  const result = await slotPrepare(
    {
      slotId,
      branch: 'feat/plain',
      prepareProfile: 'core',
      flowType: 'fix-bug',
      forceNewBranch: true,
    },
    () => undefined,
  );
  assert.equal(result.stackBase, undefined);
  assert.equal(await git(slotRepo, 'branch', '--show-current'), 'feat/plain');
  assert.equal(await git(slotRepo, 'rev-parse', 'HEAD'), mainHead);
});
