import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';
import { promisify } from 'node:util';

import type { ExecResult } from '@farmslot/protocol';

import { claimSlotStatusIf } from '../core/state.js';

// Audiolab shape: scripts/agentic is a Yarn workspace whose committed manifest
// lists @farmslot/adapter-rn after pngjs. Yarn 4 re-sorts workspace dependencies
// on every install, --immutable included, so prepare used to leave
// ` M scripts/agentic/package.json` and the run failed 30 minutes later at
// completion. Prepare now fails at the deps phase and names the file.
const tmuxSandbox =
  !process.env.TMUX &&
  process.env.TMUX_TMPDIR &&
  process.env.FARMSLOT_TMUX_SANDBOX ===
    `${process.env.TMUX_TMPDIR}/tmux-${process.getuid?.() ?? 0}/default`
    ? process.env.FARMSLOT_TMUX_SANDBOX
    : null;
const needsTmuxSandbox = {
  skip: !tmuxSandbox && 'needs the test runner tmux sandbox (FARMSLOT_TMUX_SANDBOX)',
};

const execFileAsync = promisify(execFile);
const manifestPath = 'scripts/agentic/package.json';
const unsortedManifest = `${JSON.stringify(
  {
    name: '@siteed/audiolab-agentic',
    private: true,
    dependencies: {
      '@farmslot/adapter-sdk': '0.25.2',
      '@farmslot/recipe-cli': '0.32.1',
      pngjs: '^7.0.0',
      '@farmslot/adapter-rn': '0.29.2',
    },
  },
  null,
  2,
)}\n`;

// Stands in for `yarn install --immutable`: rewrites the workspace manifest with
// dependencies sorted, as Yarn's manifest persistence does.
const yarnPersist = `node -e '
const fs = require("fs");
const file = ${JSON.stringify(manifestPath)};
const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
manifest.dependencies = Object.fromEntries(Object.entries(manifest.dependencies).sort(([a], [b]) => a.localeCompare(b)));
fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\\n");
'`;

const commands: string[] = [];
const realPrepareCommand = await import('../methods/slot/prepare-command.js');
mock.module('../methods/slot/prepare-command.js', {
  namedExports: {
    ...realPrepareCommand,
    runPrepareCommand: async (
      vars: { remoteRepo: string },
      _logPath: string,
      command: string,
    ): Promise<ExecResult> => {
      commands.push(command);
      if (!command.includes('yarn install')) return { stdout: '', stderr: '', exitCode: 0 };
      const r = spawnSync('bash', ['-c', yarnPersist], { cwd: vars.remoteRepo, encoding: 'utf8' });
      return { stdout: r.stdout, stderr: r.stderr, exitCode: r.status ?? 1 };
    },
  },
});

const realFixtures = await import('../methods/slot/fixtures.js');
mock.module('../methods/slot/fixtures.js', {
  namedExports: { ...realFixtures, runFixtureSync: async () => undefined },
});

const { slotPrepare } = await import('../methods/slot.js');

async function git(repo: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', [
    '-C',
    repo,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'commit.gpgsign=false',
    ...args,
  ]);
  return stdout.trim();
}

test(
  'prepare fails at deps when the install rewrites a tracked manifest',
  needsTmuxSandbox,
  async (t) => {
    const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'farmslot-prepare-tracked-'));
    const slotRepo = path.join(fixtureRoot, 'slot');
    const originRepo = path.join(fixtureRoot, 'origin.git');
    const repoRoot = path.resolve(new URL('../../../../', import.meta.url).pathname);
    const slotId = `prepare-tracked-${process.pid}`;
    const poolPath = path.join(repoRoot, 'pool', `${slotId}.json`);
    t.after(async () => {
      const session = spawnSync('tmux', ['-S', tmuxSandbox!, 'has-session', '-t', `=${slotId}`]);
      if (session.status === 0)
        await execFileAsync('tmux', ['-S', tmuxSandbox!, 'kill-session', '-t', `=${slotId}`]);
      await rm(poolPath, { force: true });
      await rm(fixtureRoot, { recursive: true, force: true });
    });

    await execFileAsync('git', ['init', '--initial-branch=main', slotRepo]);
    await execFileAsync('git', ['init', '--bare', '--initial-branch=main', originRepo]);
    await mkdir(path.join(slotRepo, 'scripts/agentic'), { recursive: true });
    await writeFile(path.join(slotRepo, manifestPath), unsortedManifest);
    await writeFile(path.join(slotRepo, 'README.md'), 'fixture\n');
    await git(slotRepo, 'add', '.');
    await git(slotRepo, 'commit', '-qm', 'fixture: unsorted agentic manifest');
    await git(slotRepo, 'remote', 'add', 'origin', originRepo);
    await git(slotRepo, 'push', '-q', '--set-upstream', 'origin', 'main');
    await writeFile(
      poolPath,
      `${JSON.stringify({
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
            resources: { 'dev-server': { port: 48818, metro_port: 48888 } },
          },
        ],
      })}\n`,
    );
    const reset = () =>
      claimSlotStatusIf(slotId, () => true, {
        lifecycle: 'ready',
        phase: null,
        agent: 'idle',
        current_run_id: null,
      });

    await reset();
    const events: string[] = [];
    await assert.rejects(
      slotPrepare({ slotId, branch: 'unsorted-work', prepareProfile: 'core' }, (_event, payload) =>
        events.push(JSON.stringify(payload)),
      ),
      (error: Error) => {
        assert.match(
          error.message,
          /prepare deps changed 1 tracked file on prepare-tracked-\d+: scripts\/agentic\/package\.json/,
        );
        assert.match(error.message, /yarn install/);
        return true;
      },
    );
    assert.ok(commands.some((command) => command.includes('yarn install')));
    assert.ok(events.some((line) => line.includes('changed 1 tracked file')));

    await t.test('a manifest already in the written form prepares cleanly', async () => {
      await git(slotRepo, 'checkout', '-q', 'main');
      await git(slotRepo, 'checkout', '-q', '--', '.');
      spawnSync('bash', ['-c', yarnPersist], { cwd: slotRepo });
      await git(slotRepo, 'commit', '-qam', 'chore: sort agentic dependencies');
      await git(slotRepo, 'push', '-q', 'origin', 'main');
      await reset();
      const result = await slotPrepare(
        { slotId, branch: 'sorted-work', prepareProfile: 'core' },
        () => {},
      );
      assert.equal(result.prepared, true);
      assert.equal(await git(slotRepo, 'status', '--porcelain', '--untracked-files=no'), '');
    });

    await t.test('uncommitted work a replay preserves is the baseline, not a change', async () => {
      await writeFile(path.join(slotRepo, 'README.md'), 'uncommitted work\n');
      await reset();
      const result = await slotPrepare(
        { slotId, branch: 'sorted-work', prepareProfile: 'core' },
        () => {},
        undefined,
        { preserveBranch: true },
      );
      assert.equal(result.prepared, true);
      assert.equal(await readFile(path.join(slotRepo, 'README.md'), 'utf8'), 'uncommitted work\n');
    });
  },
);
