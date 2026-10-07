// The macOS session-lock probe the web-dapp launcher refuses a headful launch on.
// ioreg is injected: no test depends on the host's screen.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { macosSessionLocked, parseSessionLocked } from '../src/web-dapp/lib/session-lock.mjs';

const session = ({ locked, onConsole }) =>
  `<dict>${onConsole ? '<key>kCGSSessionOnConsoleKey</key><true/>' : '<key>kCGSSessionOnConsoleKey</key><false/>'}` +
  `${locked === undefined ? '' : `<key>CGSSessionScreenIsLocked</key>${locked ? '<true/>' : '<false/>'}`}</dict>`;
const plist = (...sessions) =>
  `<?xml version="1.0"?><plist version="1.0"><dict><key>IOConsoleUsers</key><array>${sessions.join('')}</array></dict></plist>`;

describe('parseSessionLocked', () => {
  it('reads CGSSessionScreenIsLocked from ioreg plist output', () => {
    assert.equal(parseSessionLocked(plist(session({ locked: true, onConsole: true }))), true);
    assert.equal(parseSessionLocked(plist(session({ locked: false, onConsole: true }))), false);
    assert.equal(parseSessionLocked(plist(session({ onConsole: true }))), false);
    assert.equal(parseSessionLocked('ioreg: not a plist'), null);
    // The plist guard runs before the lock flag: text with the key but no plist is unknown.
    assert.equal(parseSessionLocked('<key>CGSSessionScreenIsLocked</key><true/>'), null);
    // A top-level flag without IOConsoleUsers.
    const topLevel = (value) =>
      `<plist version="1.0"><dict><key>CGSSessionScreenIsLocked</key>${value}</dict></plist>`;
    assert.equal(parseSessionLocked(topLevel('<false/>')), false);
    assert.equal(parseSessionLocked(topLevel('<true/>')), true);
  });

  it("counts any session's flag when none is on console", () => {
    assert.equal(parseSessionLocked(plist(session({ locked: true, onConsole: false }))), true);
    assert.equal(parseSessionLocked(plist(session({ locked: false, onConsole: false }))), false);
    // Not only the first session: the lock flag of a later off-console session counts too.
    const second = plist(
      session({ locked: false, onConsole: false }),
      session({ locked: true, onConsole: false }),
    );
    assert.equal(parseSessionLocked(second), true);
  });

  it('reads the on-console session when several are logged in', () => {
    const output = plist(
      session({ locked: true, onConsole: false }),
      session({ locked: false, onConsole: true }),
    );
    assert.equal(parseSessionLocked(output), false);
    const locked = plist(
      session({ locked: false, onConsole: false }),
      session({ locked: true, onConsole: true }),
    );
    assert.equal(parseSessionLocked(locked), true);
  });
});

describe('macosSessionLocked', () => {
  it('probes ioreg with a 3 s bound and reports locked or unlocked', () => {
    const calls = [];
    const spawnSync = (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, stdout: plist(session({ locked: true, onConsole: true })) };
    };
    assert.equal(macosSessionLocked({ platform: 'darwin', spawnSync }), true);
    const unlocked = () => ({
      status: 0,
      stdout: plist(session({ locked: false, onConsole: true })),
    });
    assert.equal(macosSessionLocked({ platform: 'darwin', spawnSync: unlocked }), false);
    assert.deepEqual(calls[0].command, 'ioreg');
    assert.deepEqual(calls[0].args, ['-n', 'Root', '-d1', '-a']);
    assert.equal(calls[0].options.timeout, 3000);
  });

  it('is null, never a throw, when ioreg times out, fails or throws', () => {
    assert.equal(
      macosSessionLocked({
        platform: 'darwin',
        spawnSync: () => ({
          error: new Error('ETIMEDOUT'),
          stdout: plist(session({ locked: true, onConsole: true })),
        }),
      }),
      null,
    );
    assert.equal(
      // A failed ioreg is unknown even when its output says locked.
      macosSessionLocked({
        platform: 'darwin',
        spawnSync: () => ({ status: 1, stdout: plist(session({ locked: true, onConsole: true })) }),
      }),
      null,
    );
    assert.equal(
      macosSessionLocked({
        platform: 'darwin',
        spawnSync: () => {
          throw new Error('spawn failed');
        },
      }),
      null,
    );
  });

  it('is null off macOS without probing', () => {
    let probed = false;
    const spawnSync = () => {
      probed = true;
      return { status: 0, stdout: '' };
    };
    assert.equal(macosSessionLocked({ platform: 'linux', spawnSync }), null);
    assert.equal(probed, false);
  });
});
