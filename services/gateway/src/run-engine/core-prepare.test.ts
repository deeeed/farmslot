import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';
import { promisify } from 'node:util';

import type { ExecResult } from '@farmslot/protocol';

const execFileAsync = promisify(execFile);
const commands: string[] = [];

const realPrepareCommand = await import('../methods/slot/prepare-command.js');
mock.module('../methods/slot/prepare-command.js', {
  namedExports: {
    ...realPrepareCommand,
    runPrepareCommand: async (
      _vars: unknown,
      _logPath: string,
      command: string,
    ): Promise<ExecResult> => {
      commands.push(command);
      return { stdout: 'state-only dependency phase completed\n', stderr: '', exitCode: 0 };
    },
  },
});

const realFixtures = await import('../methods/slot/fixtures.js');
mock.module('../methods/slot/fixtures.js', {
  namedExports: {
    ...realFixtures,
    runFixtureSync: async () => undefined,
  },
});

const { slotPrepare } = await import('../methods/slot.js');

test('Farmslot state-only backend prepare executes core phases without visual or native launches', async (t) => {
  commands.length = 0;
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'farmslot-core-prepare-'));
  const slotRepo = path.join(fixtureRoot, 'slot');
  const originRepo = path.join(fixtureRoot, 'origin.git');
  const repoRoot = path.resolve(new URL('../../../../', import.meta.url).pathname);
  const slotId = `core-prepare-${process.pid}`;
  const poolPath = path.join(repoRoot, 'pool', `${slotId}.json`);
  t.after(async () => {
    const session = spawnSync('tmux', ['has-session', '-t', `=${slotId}`], { encoding: 'utf8' });
    if (session.status === 0) await execFileAsync('tmux', ['kill-session', '-t', `=${slotId}`]);
    else assert.equal(session.status, 1, session.stderr); // No session when prepare failed before launch.
    await rm(poolPath, { force: true });
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  await execFileAsync('git', ['init', '--initial-branch=main', slotRepo]);
  await execFileAsync('git', ['init', '--bare', '--initial-branch=main', originRepo]);
  await writeFile(path.join(slotRepo, 'README.md'), 'state-only fixture\n');
  await execFileAsync('git', ['-C', slotRepo, 'add', 'README.md']);
  await execFileAsync('git', [
    '-C',
    slotRepo,
    '-c',
    'user.name=Farmslot Test',
    '-c',
    'user.email=farmslot-test@example.invalid',
    'commit',
    '-m',
    'fixture',
  ]);
  await execFileAsync('git', ['-C', slotRepo, 'remote', 'add', 'origin', originRepo]);
  await execFileAsync('git', ['-C', slotRepo, 'push', '--set-upstream', 'origin', 'main']);
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
            resources: { 'dev-server': { port: 48808, metro_port: 48878 } },
          },
        ],
      },
      null,
      2,
    )}\n`,
  );

  const events: Array<{ event: string; payload: unknown }> = [];
  const result = await slotPrepare(
    { slotId, branch: 'state-only-work', prepareProfile: 'core' },
    (event, payload) => events.push({ event, payload }),
  );

  assert.equal(result.prepared, true);
  assert.deepEqual(result.profile, { selected: 'core', requested: 'core', fallbacks: [] });
  const { stdout: preparedBranch } = await execFileAsync('git', [
    '-C',
    slotRepo,
    'branch',
    '--show-current',
  ]);
  assert.equal(
    preparedBranch.trim(),
    'state-only-work',
    'backend prepare did not execute the core git phase',
  );
  assert.ok(commands.some((command) => command.includes('yarn install')));

  const dispatched = commands.join('\n').toLowerCase();
  for (const launchSignature of [
    'debug-chrome',
    '--remote-debugging-port',
    'sandbox-dev.sh start',
    'companion-prepare.sh',
    'expo start',
    'simctl boot',
    'adb install',
  ]) {
    assert.equal(
      dispatched.includes(launchSignature),
      false,
      `${launchSignature} was dispatched by the core backend prepare`,
    );
  }

  const eventText = JSON.stringify(events).toLowerCase();
  assert.match(eventText, /prepare profile 'core' — phases: git, fixtures, deps/);
  assert.match(eventText, /preflight skipped \(profile core\)/);
  assert.match(eventText, /health check skipped \(profile core\)/);

  const replayParams = { slotId, branch: 'early-failure-work', prepareProfile: 'core' };
  await t.test('unknown state and failed persistence block branch creation', async () => {
    await assert.rejects(
      slotPrepare(replayParams, () => {}, undefined, { preserveBranch: true }),
      /Replay cannot preserve/,
    );
    await assert.rejects(
      slotPrepare(replayParams, () => {}, undefined, {
        preserveBranch: true,
        allowMissingReplayBranch: true,
        beforeBranchSetup: async () => {
          throw new Error('intent persistence failed');
        },
      }),
      /intent persistence failed/,
    );
    await assert.rejects(
      execFileAsync('git', [
        '-C',
        slotRepo,
        'show-ref',
        '--verify',
        'refs/heads/early-failure-work',
      ]),
    );
  });

  await t.test('a known early failure creates the branch after recording intent', async () => {
    let branchSetupRecorded = false;
    await slotPrepare(replayParams, () => {}, undefined, {
      preserveBranch: true,
      allowMissingReplayBranch: true,
      beforeBranchSetup: async () => {
        await assert.rejects(
          execFileAsync('git', [
            '-C',
            slotRepo,
            'show-ref',
            '--verify',
            'refs/heads/early-failure-work',
          ]),
        );
        branchSetupRecorded = true;
      },
    });
    assert.equal(branchSetupRecorded, true);
  });

  await t.test('replay preserves committed and uncommitted work', async () => {
    await writeFile(path.join(slotRepo, 'README.md'), 'committed work\n');
    await execFileAsync('git', ['-C', slotRepo, 'add', 'README.md']);
    await execFileAsync('git', [
      '-C',
      slotRepo,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-m',
      'work',
    ]);
    await writeFile(path.join(slotRepo, 'README.md'), 'uncommitted work\n');
    const head = (await execFileAsync('git', ['-C', slotRepo, 'rev-parse', 'HEAD'])).stdout;
    await slotPrepare(replayParams, () => {}, undefined, { preserveBranch: true });
    assert.equal(await readFile(path.join(slotRepo, 'README.md'), 'utf8'), 'uncommitted work\n');
    assert.equal((await execFileAsync('git', ['-C', slotRepo, 'rev-parse', 'HEAD'])).stdout, head);
  });

  await t.test('a lost previously established branch fails closed', async () => {
    await execFileAsync('git', ['-C', slotRepo, 'checkout', '-b', 'saved-work']);
    await execFileAsync('git', ['-C', slotRepo, 'branch', '-D', 'early-failure-work']);
    await assert.rejects(
      slotPrepare(replayParams, () => {}, undefined, { preserveBranch: true }),
      /Replay cannot preserve/,
    );
  });
});
