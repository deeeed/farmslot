import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { withBlindTrialBoundary } from './blind-git.js';

test('blind profile denies outbound Unix sockets except the system DNS endpoint', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'seatbelt-unit-'));
  t.after(() => rmSync(root, { recursive: true }));
  mkdirSync(path.join(root, 'boundary'));
  writeFileSync(path.join(root, 'state.json'), '{"originalIsDirectory":true}');
  const profile = execFileSync(
    'python3',
    [
      '-c',
      `
import json, os, pathlib, runpy, sys
from unittest.mock import patch
blind = runpy.run_path(sys.argv[1], run_name='fixture')
with patch.dict(os.environ, {'TMUX_TMPDIR': '/tmp/fixture-tmux', 'TMUX': '/tmp/fixture-inherited/server,123,0'}, clear=True):
    print(blind['sandbox_profile']({'repo': sys.argv[2]}, pathlib.Path(sys.argv[2]), ['/tmp/fixture-discovered/server']))
`,
      fileURLToPath(new URL('./blind-git.py', import.meta.url)),
      root,
    ],
    { encoding: 'utf8', timeout: 4500 },
  );
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

test('blind boundary strips tmux control variables, keeps pane identity, opts into outer-seatbelt Chrome', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'seatbelt-env-'));
  t.after(() => rmSync(root, { recursive: true }));
  const command = withBlindTrialBoundary('env', root);
  // Inspect the shell setup on every platform without launching a real sandbox.
  const setup = command.slice(0, command.indexOf('/usr/bin/sandbox-exec'));
  const worker = spawnSync('/bin/sh', ['-c', `${setup} env`], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      TMUX: '/fixture/socket,1,0',
      TMUX_TMPDIR: '/fixture',
      TMUX_PANE: '%42',
    },
    timeout: 4500,
  });
  assert.equal(worker.status, 0, worker.stderr);
  assert.doesNotMatch(worker.stdout, /^TMUX(?:_TMPDIR)?=/mu);
  assert.match(worker.stdout, /^TMUX_PANE=%42$/mu);
  assert.match(worker.stdout, /^FARMSLOT_BLIND_SEATBELT=1$/mu);
});
