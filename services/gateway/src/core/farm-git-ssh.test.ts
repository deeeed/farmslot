import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { withFarmGitArgv, withFarmGitConfig } from './farm-git.js';
import { shellQuote } from './tmux.js';

for (const source of [
  'environment',
  'repository',
  'parameters',
  'count',
  'default',
  'GIT_SSH',
  'auto',
  'argv',
]) {
  test(`farm SSH keepalives compose with ${source} configuration`, (t) => {
    const root = mkdtempSync(path.join(tmpdir(), 'farm-ssh-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const repo = path.join(root, 'repo');
    const remote = path.join(root, 'remote.git');
    const bin = path.join(root, 'bin with spaces');
    const capture = path.join(root, 'argv');
    mkdirSync(bin);
    const ssh = path.join(bin, source === 'GIT_SSH' ? 'alternate ssh' : 'ssh');
    writeFileSync(
      ssh,
      `#!/bin/sh\nprintf '%s\\n' "\${FIXTURE_SSH:-default}" "$@" > ${shellQuote(capture)}\nfor arg do [ "$arg" = -G ] && exit 0; last=$arg; done\nexec sh -c "$last"\n`,
      { mode: 0o755 },
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_SSH_VARIANT: 'ssh',
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    };
    delete env.GIT_SSH_COMMAND;
    delete env.GIT_SSH;
    delete env.GIT_CONFIG_PARAMETERS;
    delete env.GIT_CONFIG_COUNT;
    if (source === 'default' || source === 'auto') delete env.GIT_SSH_VARIANT;
    const git = (...args: string[]) => execFileSync('git', args, { env, stdio: 'pipe' });
    git('init', '-q', repo);
    git('init', '-q', '--bare', remote);
    const custom = `env FIXTURE_SSH='custom with spaces' ${shellQuote(ssh)} -p 2222 -o StrictHostKeyChecking=yes`;
    if (source === 'environment' || source === 'auto') {
      env.GIT_SSH_COMMAND = custom;
      git('-C', repo, 'config', 'core.sshCommand', 'must-not-run');
    } else if (source === 'repository') {
      git('-C', repo, 'config', 'core.sshCommand', custom);
    } else if (source === 'parameters') {
      env.GIT_CONFIG_PARAMETERS = shellQuote(`core.sshCommand=${custom}`);
    } else if (source === 'count') {
      env.GIT_CONFIG_COUNT = '1';
      env.GIT_CONFIG_KEY_0 = 'core.sshCommand';
      env.GIT_CONFIG_VALUE_0 = custom;
    } else if (source === 'GIT_SSH') {
      env.GIT_SSH = ssh;
    }
    const before = readFileSync(path.join(repo, '.git/config'), 'utf8');
    const argv = [
      'git',
      '-C',
      repo,
      ...(source === 'argv' ? ['-c', `core.sshCommand=${custom}`] : []),
      'ls-remote',
      `fixture@localhost:${remote}`,
    ];
    // Run outside the repo so core.sshCommand must resolve in Git's own cwd.
    const wrapped = withFarmGitArgv(argv);
    if (['parameters', 'count', 'default', 'GIT_SSH'].includes(source)) {
      execFileSync(
        process.platform === 'darwin' ? 'zsh' : 'bash',
        ['-c', withFarmGitConfig(argv.map(shellQuote).join(' '))],
        {
          cwd: root,
          env,
          stdio: 'pipe',
        },
      );
    } else {
      execFileSync(wrapped[0], wrapped.slice(1), { cwd: root, env, stdio: 'pipe' });
    }
    const actual = readFileSync(capture, 'utf8').trim().split('\n');
    assert.ok(actual.includes('ServerAliveInterval=20'), actual.join(' '));
    assert.ok(actual.includes('ServerAliveCountMax=30'), actual.join(' '));
    if (['environment', 'repository', 'parameters', 'count', 'auto', 'argv'].includes(source)) {
      assert.equal(actual[0], 'custom with spaces');
      assert.ok(actual.includes('2222'));
      assert.ok(actual.includes('StrictHostKeyChecking=yes'));
    }
    assert.equal(readFileSync(path.join(repo, '.git/config'), 'utf8'), before);
    // The wrapper's exported SSH command cannot affect a local/HTTPS transport.
    execFileSync('bash', ['-c', withFarmGitConfig(`git ls-remote ${shellQuote(remote)}`)], {
      cwd: root,
      env: { ...env, GIT_SSH_COMMAND: 'exit 99' },
      stdio: 'pipe',
    });
  });
}

test('HTTPS keeps its remote helper transport without invoking SSH', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'farm-https-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const capture = path.join(root, 'helper-argv');
  writeFileSync(
    path.join(root, 'git-remote-https'),
    `#!/bin/sh\nprintf '%s\\n' "$@" > ${shellQuote(capture)}\nexit 23\n`,
    { mode: 0o755 },
  );
  const result = spawnSync(
    'bash',
    ['-c', withFarmGitConfig('git ls-remote https://fixture.invalid/example/repo.git')],
    {
      cwd: root,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_EXEC_PATH: root,
        GIT_SSH_COMMAND: 'exit 99',
      },
      encoding: 'utf8',
    },
  );
  if (result.error) throw result.error;
  assert.equal(result.status, 128, 'Git reports the intentionally failed HTTPS helper');
  assert.match(readFileSync(capture, 'utf8'), /https:\/\/fixture.invalid\/example\/repo.git/);
});

for (const variant of ['plink', 'simple', 'auto-plink', 'auto-simple']) {
  for (const source of ['GIT_SSH', 'environment', 'repository']) {
    test(`farm preserves ${variant} ${source} argv`, (t) => {
      const root = mkdtempSync(path.join(tmpdir(), 'farm-variant-'));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const repo = path.join(root, 'repo');
      const capture = path.join(root, 'argv');
      const transport = path.join(root, variant.includes('plink') ? 'plink' : 'wrapper');
      writeFileSync(
        transport,
        `#!/bin/sh\nprintf '%s\\n' "$@" > ${shellQuote(capture)}\nfor arg do [ "$arg" = -G ] && exit 1; done\nexit 0\n`,
        { mode: 0o755 },
      );
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
      };
      for (const key of Object.keys(env))
        if (
          /^GIT_(SSH|CONFIG_)/.test(key) &&
          !['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'].includes(key)
        )
          delete env[key];
      if (!variant.startsWith('auto-') && source !== 'repository') env.GIT_SSH_VARIANT = variant;
      execFileSync('git', ['init', '-q', repo], { env });
      const custom = `${shellQuote(transport)}${variant.includes('plink') ? ' -batch' : ''}`;
      if (source === 'GIT_SSH') env.GIT_SSH = transport;
      else if (source === 'environment') env.GIT_SSH_COMMAND = custom;
      else {
        execFileSync('git', ['-C', repo, 'config', 'core.sshCommand', custom], { env });
        execFileSync(
          'git',
          ['-C', repo, 'config', 'ssh.variant', variant.startsWith('auto-') ? 'auto' : variant],
          { env },
        );
      }
      // A port makes Git's plink versus simple argument contract observable.
      const remote = variant.includes('plink')
        ? 'ssh://fixture@localhost:2222/repo'
        : 'fixture@localhost:repo';
      const argv = ['git', '-C', repo, 'ls-remote', remote];
      spawnSync(argv[0], argv.slice(1), { env });
      const expected = readFileSync(capture, 'utf8');
      const wrapped = withFarmGitArgv(argv);
      spawnSync(wrapped[0], wrapped.slice(1), { cwd: root, env });
      assert.equal(readFileSync(capture, 'utf8'), expected);
    });
  }
}
