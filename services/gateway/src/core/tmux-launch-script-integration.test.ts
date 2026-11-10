import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const tmuxSandbox = process.env.FARMSLOT_TMUX_SANDBOX;
const isolated =
  !process.env.TMUX &&
  Boolean(process.env.TMUX_TMPDIR) &&
  tmuxSandbox === `${process.env.TMUX_TMPDIR}/tmux-${process.getuid?.() ?? 0}/default`;

test(
  'private tmux rejects the old inline launch and runs the script with diagnostic hold and shell fallback',
  {
    skip: !isolated,
  },
  async (t) => {
    // No gateway imports until the process is confined to the test runner's socket.
    assert.ok(isolated);
    const { buildRoleLaunchCommandWithDiagnosticHold } =
      await import('../methods/dispatch/execute.js');
    const { writeTmuxLaunchScript } = await import('./tmux-launch-script.js');
    const { shellQuote } = await import('./tmux.js');
    const { makeVars } = await import('../runners/test-fixtures.js');
    const { syntheticPiLaunch } = await import('./tmux-launch-script.test-support.js');
    const root = await mkdtemp(path.join(os.tmpdir(), 'tmux-launch-live-'));
    const session = `launch-script-${process.pid}`;
    const vars = makeVars({ machine: 'local', remoteRepo: path.join(root, 'repo') });
    await mkdir(vars.remoteRepo);
    const bin = path.join(root, 'bin');
    await mkdir(bin);
    const holding = path.join(root, 'holding');
    const release = path.join(root, 'release');
    const restored = path.join(root, 'restored');
    const roleShell = path.join(bin, 'role-shell');
    // Replace only the long diagnostic sleep. The test proves its requested
    // duration and blocks until released, without spending 45 seconds in the suite.
    await writeFile(
      path.join(bin, 'sleep'),
      `#!/bin/bash\nprintf '%s' "$1" > ${shellQuote(holding)}\nwhile [ ! -f ${shellQuote(release)} ]; do /bin/sleep 0.01; done\n`,
      { mode: 0o700 },
    );
    await writeFile(roleShell, `#!/bin/bash\npwd > ${shellQuote(restored)}\nexec /bin/cat\n`, {
      mode: 0o700,
    });
    const env = {
      ...process.env,
      HOME: root,
      SHELL: '/bin/bash',
      PATH: `${bin}:${process.env.PATH}`,
    };
    const tmux = (...args: string[]) =>
      spawnSync('tmux', ['-S', tmuxSandbox!, '-f', '/dev/null', ...args], {
        env,
        encoding: 'utf8',
        timeout: 3_000,
      });
    const checked = (...args: string[]) => {
      const result = tmux(...args);
      assert.equal(result.status, 0, result.stderr || result.error?.message);
      return result.stdout;
    };
    t.after(async () => {
      const killed = tmux('kill-session', '-t', `=${session}`);
      await rm(root, { recursive: true, force: true });
      assert.equal(killed.status, 0, killed.stderr);
    });
    checked('new-session', '-d', '-s', session, '-n', 'dev', '-c', vars.remoteRepo, '/bin/cat');
    const target = `${session}:dev`;
    const pi = syntheticPiLaunch(vars);
    const oldPiCommand = buildRoleLaunchCommandWithDiagnosticHold(pi, vars.remoteRepo);
    const oldPi = tmux('respawn-window', '-k', '-t', target, '-c', vars.remoteRepo, oldPiCommand);
    t.diagnostic(
      `real pi launch bytes=${Buffer.byteLength(pi)}, old tmux argv bytes=${Buffer.byteLength(oldPiCommand)}`,
    );
    assert.notEqual(oldPi.status, 0);
    assert.match(oldPi.stderr, /command too long/);
    t.diagnostic(
      `real pi old tmux argv bytes=${Buffer.byteLength(oldPiCommand)}, shell-quoted argument bytes=${Buffer.byteLength(shellQuote(oldPiCommand))}: ${oldPi.stderr.trim()}`,
    );
    const launch = `exit 23 # ${'x'.repeat(65_536)}`;
    const wrapped = buildRoleLaunchCommandWithDiagnosticHold(launch, vars.remoteRepo);
    const old = tmux('respawn-window', '-k', '-t', target, '-c', vars.remoteRepo, wrapped);
    assert.notEqual(old.status, 0);
    assert.match(old.stderr, /command too long/);
    t.diagnostic(
      `old inline tmux payload bytes=${Buffer.byteLength(wrapped)}: ${old.stderr.trim()}`,
    );
    const fixtureEnv = `export PATH=${shellQuote(env.PATH)} SHELL=${shellQuote(roleShell)}\n`;
    const entry = await writeTmuxLaunchScript(vars, target, `${fixtureEnv}${wrapped}`);
    checked('respawn-window', '-k', '-t', target, '-c', vars.remoteRepo, entry);
    const until = async (condition: () => boolean) => {
      const deadline = Date.now() + 3_000;
      while (!condition()) {
        assert.ok(Date.now() < deadline, 'timed out waiting for fixture process');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    await until(() => existsSync(holding));
    assert.equal(await readFile(holding, 'utf8'), '45');
    assert.equal(existsSync(restored), false, 'role shell waits for the diagnostic hold');
    const output = checked('capture-pane', '-p', '-t', target);
    assert.match(output, /runner launch command exited 23/);
    assert.match(output, /preserving pane for launch diagnostics/);
    await writeFile(release, '');
    await until(() => existsSync(restored));
    assert.equal((await readFile(restored, 'utf8')).trim(), vars.remoteRepo);

    await rm(holding);
    await rm(restored);
    const success = await writeTmuxLaunchScript(
      vars,
      target,
      fixtureEnv + buildRoleLaunchCommandWithDiagnosticHold('exit 0', vars.remoteRepo),
    );
    assert.equal(success, entry, 'one file per role target');
    checked('respawn-window', '-k', '-t', target, '-c', vars.remoteRepo, success);
    await until(() => existsSync(restored));
    assert.equal(existsSync(holding), false, 'successful launches skip the hold');
    assert.match(checked('capture-pane', '-p', '-t', target), /runner launch command exited 0/);
  },
);
