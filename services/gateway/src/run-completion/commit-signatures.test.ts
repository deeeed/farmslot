import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { SlotVars } from '../core/config.js';

import { assertCommitSignatures } from './commit-signatures.js';

function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'commit-signatures-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Signature test');
  git('config', 'user.email', 'signature@example.invalid');
  git('config', 'core.hooksPath', '/dev/null');
  git('config', 'commit.gpgsign', 'false');
  git('commit', '-q', '--allow-empty', '-m', 'test: unsigned trusted base');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  const key = path.join(root, 'test-key');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]);
  git('config', 'gpg.format', 'ssh');
  git('config', 'user.signingkey', key);
  git('config', 'commit.gpgsign', 'true');
  const vars: SlotVars = {
    slotId: 'signature-fixture',
    machine: os.hostname(),
    host: 'localhost',
    remoteRepo: root,
    repo: root,
    projectName: 'proof',
    platform: 'cli',
    sshUser: '',
    osType: 'darwin',
    claudePath: '',
    codexPath: '',
    opencodePath: '',
    cursorPath: '',
    grokPath: '',
    dispatchCmd: '',
    recycleCmd: '',
    session: 'proof',
    slotMode: 'dispatch',
    slotEnabled: true,
    sshTarget: '',
    resourceVars: {},
  };
  return { root, git, vars };
}

test('refuses a commit-tree subject rewrite without -S even with a later signed commit', async (t) => {
  const { git, vars } = fixture(t);
  const tree = git('rev-parse', 'HEAD^{tree}');
  const parent = git('rev-parse', 'HEAD');
  const unsigned = git('commit-tree', tree, '-p', parent, '-m', 'test: rewritten subject');
  git('update-ref', 'HEAD', unsigned);
  git('commit', '-q', '--allow-empty', '-m', 'test: later signed change');
  await assert.rejects(assertCommitSignatures(vars, 'refs/remotes/origin/main'), (error: Error) => {
    assert.match(
      error.message,
      new RegExp(`Unsigned outgoing commit\\(s\\): ${unsigned.slice(0, 12)}`),
    );
    assert.match(error.message, /commit-tree requires -S/);
    return true;
  });
});

test('accepts signed contributions without requiring trusted base history to be signed', async (t) => {
  const { git, vars } = fixture(t);
  git('commit', '-q', '--allow-empty', '-m', 'test: signed change');
  await assertCommitSignatures(vars, 'refs/remotes/origin/main');
});

test('signature-like text in the commit message cannot count as a signature header', async (t) => {
  const { git, vars } = fixture(t);
  git('-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'gpgsig fake');
  await assert.rejects(
    assertCommitSignatures(vars, 'refs/remotes/origin/main'),
    /Unsigned outgoing/,
  );
});

test('refuses a missing contribution base instead of silently checking an empty range', async (t) => {
  const { vars } = fixture(t);
  await assert.rejects(
    assertCommitSignatures(vars, 'refs/remotes/origin/missing'),
    /Cannot check outgoing commit signatures/,
  );
});
