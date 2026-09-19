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
 * A slot repo with origin, a `work` branch whose frozen head A is one commit
 * behind what origin holds (B). `onWork` leaves the slot checked out on `work`
 * at B; otherwise the slot sits on main.
 */
async function slotFixture(
  t: import('node:test').TestContext,
  label: string,
  onWork: boolean,
  port: number,
) {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), `farmslot-start-ref-${label}-`));
  const slotRepo = path.join(fixtureRoot, 'slot');
  const originRepo = path.join(fixtureRoot, 'origin.git');
  const repoRoot = path.resolve(new URL('../../../../', import.meta.url).pathname);
  const slotId = `start-ref-${label}-${process.pid}`;
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
  if (!onWork) await git(slotRepo, 'checkout', 'main');
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
  return { slotId, slotRepo, frozenHead, laterHead };
}

async function cleanTree(slotRepo: string): Promise<string[]> {
  // Later prepare phases create the untracked sandbox dir; the tree itself must be clean.
  return (await git(slotRepo, 'status', '--porcelain'))
    .split('\n')
    .filter((line) => line && !line.startsWith('?? .sandbox/'));
}

// Regression: a QA dispatch to a slot already on the PR branch returned no
// start-ref provenance (the dispatch refused it) and would otherwise have
// reported the frozen head while the tree sat at origin/<branch>.
test('qa: a slot already on the PR branch lands on the frozen head with provenance', async (t) => {
  const { slotId, slotRepo, frozenHead } = await slotFixture(t, 'warm', true, 48810);
  const events: Array<{ event: string; payload: unknown }> = [];
  const result = await slotPrepare(
    { slotId, branch: 'work', prepareProfile: 'core', flowType: 'qa' },
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
    'the tree must sit at the frozen head, not at origin/work',
  );
  assert.deepEqual(await cleanTree(slotRepo), []);
  assert.match(JSON.stringify(events), /reset to requested start ref/);
});

// A cold slot takes the fresh-branch path: the PR branch exists on origin, which
// the dev/fix-bug replay policy refuses, but a qa frozen head is not a replay.
test('qa: a cold slot checks out the PR branch at the frozen head', async (t) => {
  const { slotId, slotRepo, frozenHead } = await slotFixture(t, 'cold', false, 48812);
  const result = await slotPrepare(
    { slotId, branch: 'work', prepareProfile: 'core', flowType: 'qa' },
    () => undefined,
    undefined,
    { startRef: { requestedRef: frozenHead } },
  );
  assert.equal(result.startRef?.resolvedSha, frozenHead);
  assert.equal(await git(slotRepo, 'branch', '--show-current'), 'work');
  assert.equal(await git(slotRepo, 'rev-parse', 'HEAD'), frozenHead);
  assert.deepEqual(await cleanTree(slotRepo), []);
});

// For dev/fix-bug the start ref is an artifact-only replay base and the work
// branch must stay local-only, on the already-on-branch path as on the fresh one.
test('dev: a remote-published branch already checked out is refused for a start ref', async (t) => {
  const { slotId, slotRepo, frozenHead, laterHead } = await slotFixture(t, 'policy', true, 48814);
  await assert.rejects(
    slotPrepare(
      { slotId, branch: 'work', prepareProfile: 'core', flowType: 'dev' },
      () => undefined,
      undefined,
      { startRef: { requestedRef: frozenHead } },
    ),
    /refuses to mutate or reuse existing remote branch/,
  );
  assert.equal(
    await git(slotRepo, 'rev-parse', 'HEAD'),
    laterHead,
    'a refused prepare must not rewind the branch',
  );
});
