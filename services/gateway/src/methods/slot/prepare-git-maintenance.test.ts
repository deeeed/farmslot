import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';

import { execOnSlot } from '../../core/exec.js';
import { shellQuote } from '../../core/tmux.js';
import { makeVars } from '../../runners/test-fixtures.js';

import { buildPrepareWrappedCommand } from './prepare-command.js';

const hasTmux = spawnSync('tmux', ['-V']).status === 0;

for (const existingServer of [false, true]) {
  test(
    `prepare Git scope with ${existingServer ? 'existing' : 'new'} tmux server`,
    { skip: !hasTmux },
    async (t) => {
      // A short private path also fits Unix socket limits under the test runner.
      const root = mkdtempSync('/tmp/prepare-git-scope-');
      const socket = path.join(root, 'tmux.sock');
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        TMUX_TMPDIR: root,
        GIT_CONFIG_PARAMETERS: '',
        GIT_CONFIG_COUNT: '0',
      };
      delete env.TMUX;
      const tmuxArgs = ['-S', socket, '-f', '/dev/null'];
      const tmux = (...args: string[]) =>
        execFileSync('tmux', [...tmuxArgs, ...args], { env, encoding: 'utf8' });
      t.after(() => {
        // Only this fixture's socket is ever addressed, even after a failed assertion.
        const result = spawnSync('tmux', [...tmuxArgs, 'kill-server'], { env });
        if (result.error) throw result.error;
        rmSync(root, { recursive: true, force: true });
      });
      const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { env });
      git('init', '-q', '-b', 'main');
      git(
        '-c',
        'commit.gpgsign=false',
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '--allow-empty',
        '-qm',
        'baseline',
      );
      git('remote', 'add', 'origin', root);
      git('config', 'gc.auto', '23');
      git('config', 'maintenance.auto', 'true');
      const workerRepo = path.join(root, 'worker-repo');
      mkdirSync(workerRepo);
      const workerGit = (...args: string[]) =>
        execFileSync('git', ['-C', workerRepo, ...args], { env });
      workerGit('init', '-q');
      workerGit('config', 'gc.auto', '23');
      workerGit('config', 'maintenance.auto', 'true');
      const config = readFileSync(path.join(root, '.git/config'), 'utf8');
      if (existingServer) tmux('new-session', '-d', '-s', 'fixture', '-c', root, 'sleep 60');
      const vars = makeVars({ host: 'localhost', machine: 'fixture', remoteRepo: root });
      const command = `env -u TMUX TMUX_TMPDIR=${shellQuote(root)} tmux ${tmuxArgs.map(shellQuote).join(' ')}`;
      // Same generic slot execution used by prepare's ensure-session command.
      const ensured = await execOnSlot(
        vars,
        `${command} has-session -t fixture 2>/dev/null || ${command} new-session -d -s fixture -c ${shellQuote(root)} 'sleep 60'`,
      );
      assert.equal(ensured.exitCode, 0, ensured.stderr);
      const output = path.join(root, 'hook.out');
      const trace = path.join(root, 'fetch.jsonl');
      const sentinel = path.join(root, 'hook.exit');
      const script = path.join(root, 'hook.sh');
      writeFileSync(
        script,
        buildPrepareWrappedCommand(
          `GIT_TRACE2_EVENT=${shellQuote(trace)} GIT_TRACE2_CONFIG_PARAMS=gc.auto,maintenance.auto git fetch origin main && git config --get gc.auto > ${shellQuote(output)}; git config --get maintenance.auto >> ${shellQuote(output)}`,
          sentinel,
          root,
          { cwd: root },
        ),
      );
      tmux('new-window', '-d', '-t', 'fixture', '-n', 'prepare', 'sleep 60');
      tmux('respawn-pane', '-k', '-t', 'fixture:prepare', 'bash', script);
      const waitFor = async (file: string) => {
        const until = Date.now() + 3000;
        while (!existsSync(file) && Date.now() < until) await setTimeout(10);
        assert.ok(existsSync(file), `missing ${path.basename(file)}`);
        return readFileSync(file, 'utf8');
      };
      assert.equal((await waitFor(sentinel)).trim(), '0');
      const worker = path.join(root, 'worker.out');
      tmux(
        'new-window',
        '-d',
        '-t',
        'fixture',
        '-n',
        'worker',
        '-c',
        workerRepo,
        `cd -- ${shellQuote(workerRepo)} && git config --get gc.auto > ${shellQuote(worker)}; git config --get maintenance.auto >> ${shellQuote(worker)}; touch ${shellQuote(`${worker}.done`)}`,
      );
      await waitFor(`${worker}.done`);
      assert.equal(
        readFileSync(worker, 'utf8'),
        '23\ntrue\n',
        'ordinary worker Git keeps its settings',
      );
      assert.equal(
        readFileSync(output, 'utf8'),
        '0\nfalse\n',
        'staged hook Git receives command scope',
      );
      const events = readFileSync(trace, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      for (const [key, value] of [
        ['gc.auto', '0'],
        ['maintenance.auto', 'false'],
      ]) {
        assert.ok(
          events.some(
            (event) =>
              event.event === 'def_param' &&
              event.param === key &&
              event.value === value &&
              event.scope === 'command',
          ),
          `fetch has command-scoped ${key}`,
        );
      }
      assert.deepEqual(
        events.filter(
          (event) =>
            event.event === 'child_start' &&
            event.argv.some((arg: string) => /^(gc|maintenance)$/.test(arg)),
        ),
        [],
      );
      assert.equal(readFileSync(path.join(root, '.git/config'), 'utf8'), config);
    },
  );
}
