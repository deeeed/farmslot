import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { withBlindTrialBoundary } from './blind-git.js';

function generatedProfile(t: TestContext) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'seatbelt-unit-')));
  t.after(() => rmSync(root, { recursive: true }));
  mkdirSync(path.join(root, 'boundary'));
  const home = path.join(root, 'boundary/home');
  mkdirSync(home);
  mkdirSync(path.join(root, 'credentials'));
  symlinkSync(path.join(root, 'credentials'), path.join(home, '.ssh'));
  writeFileSync(path.join(root, 'state.json'), '{"originalIsDirectory":true}');
  const profile = execFileSync(
    'python3',
    [
      '-c',
      `
import json, os, pathlib, runpy, sys
from unittest.mock import patch
blind = runpy.run_path(sys.argv[1], run_name='fixture')
with patch.dict(os.environ, {'HOME': sys.argv[2] + '/boundary/home', 'TMUX_TMPDIR': '/tmp/fixture-tmux', 'TMUX': '/tmp/fixture-inherited/server,123,0'}, clear=True):
    print(blind['sandbox_profile']({'repo': sys.argv[2]}, pathlib.Path(sys.argv[2]), ['/tmp/fixture-discovered/server']))
`,
      fileURLToPath(new URL('./blind-git.py', import.meta.url)),
      root,
    ],
    { encoding: 'utf8', timeout: 4500 },
  );
  return { root, home, profile };
}

test('blind profile denies outbound Unix sockets except the system DNS endpoint', (t) => {
  const { profile } = generatedProfile(t);
  for (const prefix of ['/tmp', '/private/tmp']) {
    for (const directory of [
      `tmux-${process.getuid!()}`,
      `fixture-tmux/tmux-${process.getuid!()}`,
    ]) {
      assert.ok(
        profile.includes(`(remote unix-socket (subpath "${prefix}/${directory}"))`),
        profile,
      );
    }
    for (const socket of ['fixture-inherited/server', 'fixture-discovered/server']) {
      assert.ok(profile.includes(`(remote unix-socket (literal "${prefix}/${socket}"))`), profile);
    }
  }
  assert.ok(profile.includes('(deny network-outbound (remote unix-socket)'), profile);
  // /var/run resolves through /private on macOS and /run on Ubuntu.
  const resolverPaths = new Set([
    '/var/run/mDNSResponder',
    path.join(realpathSync('/var/run'), 'mDNSResponder'),
  ]);
  assert.equal(
    profile.split('\n').find((line) => line.startsWith('(allow network-outbound')),
    `(allow network-outbound ${[...resolverPaths]
      .sort()
      .map((socket) => `(remote unix-socket (literal "${socket}"))`)
      .join(' ')})`,
  );
  assert.equal(profile.split('(allow network-outbound').length, 2);
});

test('blind profile blocks SSH and remote shell TCP, SSH executables and credential paths', (t) => {
  const { root, home, profile } = generatedProfile(t);
  // Wildcard addresses also cover localhost DNS, IPv6 and other 127/8 aliases.
  for (const port of [22, 512, 513, 514])
    assert.ok(profile.includes(`(remote tcp "*:${port}")`), profile);
  assert.match(profile, /\(deny network-outbound \(remote tcp/u);
  for (const executable of ['ssh', 'scp', 'sftp'])
    assert.ok(profile.includes(`(literal "/usr/bin/${executable}")`), profile);
  assert.match(profile, /\(deny process-exec /u);
  for (const directory of [path.join(home, '.ssh'), path.join(root, 'credentials')]) {
    const rule = `(deny file-read* (subpath ${JSON.stringify(directory)}))`;
    assert.ok(profile.includes(rule), profile);
    assert.ok(profile.indexOf(rule) > profile.indexOf('(allow file-read*'), profile);
  }
});

test('blind profile hides boundary and node internals after runtime read exceptions', (t) => {
  const { root, home, profile } = generatedProfile(t);
  for (const installation of ['farmslot-node', 'farmslot-node-dev']) {
    const directory = path.join(home, installation);
    assert.ok(profile.includes(`(deny file-read* (subpath ${JSON.stringify(directory)}))`));
    for (const ancestor of [directory, path.join(directory, 'packages')])
      assert.ok(
        profile.includes(`(allow file-read-metadata (literal ${JSON.stringify(ancestor)}))`),
      );
    for (const runtime of ['support', 'node_modules', 'packages/agent-runtime']) {
      const rule = `(allow file-read* (subpath ${JSON.stringify(path.join(directory, runtime))}))`;
      assert.ok(profile.includes(rule));
    }
  }
  for (const file of [
    path.join(home, '.pi/agent/settings.json'),
    path.join(root, 'boundary/sandbox.sb'),
  ]) {
    const rule = `(deny file-read* (subpath ${JSON.stringify(file)}))`;
    assert.ok(profile.includes(rule));
    assert.ok(profile.indexOf(rule) > profile.lastIndexOf('(allow file-read*'));
  }
  assert.ok(profile.includes('/blind-git[.](py|ts|js)$'));
  assert.ok(profile.includes('(deny file-write-unlink '));
  for (const file of [path.join(home, '.ssh'), path.join(root, 'boundary/sandbox.sb')])
    assert.ok(profile.includes(`(deny file-write* (subpath ${JSON.stringify(file)}))`));
});

test('blind boundary strips tmux and SSH agent variables, keeps pane identity, opts into outer-seatbelt Chrome', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'seatbelt-env-'));
  t.after(() => rmSync(root, { recursive: true }));
  const command = withBlindTrialBoundary('env', { capsule: root, baseSha: 'a'.repeat(40) });
  // Inspect the shell setup on every platform without launching a real sandbox.
  const setup = command.slice(0, command.indexOf('/usr/bin/sandbox-exec'));
  const worker = spawnSync('/bin/sh', ['-c', `${setup} env`], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      TMUX: '/fixture/socket,1,0',
      TMUX_TMPDIR: '/fixture',
      TMUX_PANE: '%42',
      SSH_AUTH_SOCK: '/fixture/agent.sock',
      SSH_AGENT_PID: '123',
    },
    timeout: 4500,
  });
  assert.equal(worker.status, 0, worker.stderr);
  assert.doesNotMatch(worker.stdout, /^TMUX(?:_TMPDIR)?=/mu);
  assert.doesNotMatch(worker.stdout, /^SSH_(?:AUTH_SOCK|AGENT_PID)=/mu);
  assert.match(worker.stdout, /^TMUX_PANE=%42$/mu);
  assert.match(worker.stdout, /^FARMSLOT_BLIND_SEATBELT=1$/mu);
  assert.match(worker.stdout, /^FARMSLOT_CI_BASE_REF=a{40}$/mu);
});
