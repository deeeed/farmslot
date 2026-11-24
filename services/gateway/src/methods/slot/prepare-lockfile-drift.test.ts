import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  isLockfile,
  lockfileDrift,
  lockfileDriftAllowed,
  lockfileRewrittenCommand,
  readLogTail,
} from './prepare-lockfile-drift.js';

// Yarn 4 colours its output and links each error code with a BEL-terminated OSC 8 hyperlink.
const code = (id: string, slug: string) =>
  `\x1b]8;;https://yarnpkg.com/advanced/error-codes#${id.toLowerCase()}---${slug}\x07${id}\x1b]8;;\x07`;
const arrow = '\x1b[91m➤\x1b[39m ';

test('yarn naming a pinned package the lockfile lacks is drift on that package', () => {
  const log = [
    `${arrow}\x1b[90mYN0000\x1b[39m: ┌ Resolution step`,
    `${arrow}${code('YN0000', 'unnamed')}: │ \x1b[38;2;215;95;0m@metamask/\x1b[39m\x1b[38;2;215;135;95mperps-controller\x1b[39m@\x1b[38;2;0;175;175mnpm:25.0.0\x1b[39m: This package doesn't seem to be present in your lockfile; run "yarn install" to update the lockfile`,
  ].join('\n');
  assert.deepEqual(lockfileDrift(log), { package: '@metamask/perps-controller' });
});

test('an immutable install refusing to rewrite the lockfile names the first added entry', () => {
  const log = [
    `${arrow}\x1b[90mYN0000\x1b[39m: ┌ Resolution step`,
    `${arrow}${code('YN0028', 'frozen_lockfile_exception')}: │ -"@metamask/perps-controller@npm:25.0.0-preview.3":`,
    `${arrow}${code('YN0028', 'frozen_lockfile_exception')}: │ +"@metamask/perps-controller@npm:25.0.0":`,
    `${arrow}${code('YN0028', 'frozen_lockfile_exception')}: │ The lockfile would have been modified by this install, which is explicitly forbidden.`,
  ].join('\n');
  assert.deepEqual(lockfileDrift(log), { package: '@metamask/perps-controller' });
});

test('yarn names a patched, ranged or workspace descriptor the lockfile lacks', () => {
  for (const [descriptor, name] of [
    ['foo@patch:foo@npm%3A1.0.0#~/.yarn/patches/foo.patch::version=1.0.0&hash=abc', 'foo'],
    ['foo@npm:>=1 <2', 'foo'],
    ['@scope/a@workspace:packages/a', '@scope/a'],
  ])
    assert.deepEqual(
      lockfileDrift(
        `${arrow}${code('YN0000', 'unnamed')}: │ ${descriptor}: This package doesn't seem to be present in your lockfile; run "yarn install" to update the lockfile`,
      ),
      { package: name },
      descriptor,
    );
});

test('yarn classic and npm drift are recognised', () => {
  assert.deepEqual(
    lockfileDrift(
      'error Your lockfile needs to be updated, but yarn was run with `--frozen-lockfile`.',
    ),
    { package: null },
  );
  assert.deepEqual(
    lockfileDrift(
      'npm ERR! `npm ci` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync.\nnpm ERR! Missing: left-pad@1.3.0 from lock file',
    ),
    { package: 'left-pad' },
  );
});

test('a package added on a successful npm line is not taken for the drifted one', () => {
  assert.deepEqual(
    lockfileDrift(
      '+ left-pad@1.3.0\nerror Your lockfile needs to be updated, but yarn was run with `--frozen-lockfile`.',
    ),
    { package: null },
  );
});

test('other install failures are not drift', () => {
  assert.equal(
    lockfileDrift(`${arrow}${code('YN0001', 'exception')}: │ Error: getaddrinfo ENOTFOUND`),
    null,
  );
  assert.equal(lockfileDrift('error An unexpected error occurred: "ECONNRESET".'), null);
});

test('only runs on an existing PR branch may update its lockfile', () => {
  assert.equal(lockfileDriftAllowed('pr-complete', false), true);
  assert.equal(lockfileDriftAllowed('dev', true), true);
  assert.equal(lockfileDriftAllowed('dev', false), false);
  assert.equal(lockfileDriftAllowed('fix-bug', true), false);
  assert.equal(lockfileDriftAllowed(undefined, true), false);
  assert.deepEqual(
    ['yarn.lock', 'scripts/inpage-bridge/yarn.lock', 'package-lock.json', 'package.json'].map(
      isLockfile,
    ),
    [true, true, true, false],
  );
});

test('a log the command never wrote reads as empty', async () => {
  assert.equal(await readLogTail(`/nonexistent-${process.pid}/deps.log`), '');
});

test('only a working-tree rewrite of the lockfile counts, and a Git error refuses it', (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'lockfile-rewritten-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@localhost', ...args], {
      cwd: repo,
    });
  git('init', '-q');
  writeFileSync(join(repo, 'yarn.lock'), 'a\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  const rewritten = () =>
    spawnSync('sh', ['-c', lockfileRewrittenCommand(repo, 'yarn.lock')]).status === 0;
  assert.equal(rewritten(), false, 'unchanged');
  appendFileSync(join(repo, 'yarn.lock'), 'b\n');
  assert.equal(rewritten(), true, 'rewritten in the working tree');
  git('add', 'yarn.lock');
  assert.equal(rewritten(), false, 'only staged');
  appendFileSync(join(repo, 'yarn.lock'), 'c\n');
  writeFileSync(join(repo, '.git', 'index'), 'not an index');
  assert.equal(rewritten(), false, 'git diff failed');
});
