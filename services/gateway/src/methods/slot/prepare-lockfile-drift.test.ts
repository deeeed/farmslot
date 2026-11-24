import assert from 'node:assert/strict';
import test from 'node:test';

import { isLockfile, lockfileDrift, lockfileDriftAllowed } from './prepare-lockfile-drift.js';

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
