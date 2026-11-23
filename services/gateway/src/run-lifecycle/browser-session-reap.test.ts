import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, afterEach, mock, test } from 'node:test';

import type { SlotVars } from '../core/config.js';

mock.module('../methods/runtime-capabilities.js', {
  namedExports: {
    getRuntimeCapabilityRegistry: () => ({ settledStatus: async () => ({ leases: [] }) }),
  },
});
const { reapSlotBrowserSession } = await import('./browser-session-reap.js');

const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'agent-browser-reap-')));
const repo = path.join(root, 'slot');
const other = path.join(root, 'elsewhere');
// An install path with a space: the executable is read from the kernel, not split arguments.
const bin = path.join(root, 'Browser Tools/agent-browser/bin/agent-browser-darwin-arm64');
// Unix socket paths are short (104 bytes on macOS), like agent-browser's ~/.agent-browser.
const socketDir = mkdtempSync('/tmp/abr-');
for (const dir of [repo, other, path.dirname(bin)]) mkdirSync(dir, { recursive: true });
// A stand-in daemon: node under agent-browser's executable name, listening on `<session>.sock`.
symlinkSync(process.execPath, bin);
// argv: the session socket, an optional TCP port, then an optional second socket.
const DAEMON = `const net = require('node:net'); net.createServer().listen(process.argv[1]); if (process.argv[2]) net.createServer().listen(Number(process.argv[2]), '127.0.0.1'); if (process.argv[3]) net.createServer().listen(process.argv[3]); setInterval(() => {}, 1e6)`;
const CDP_PORT = '59547';

const vars: SlotVars = {
  slotId: 'agent-browser-reap',
  machine: 'local',
  platform: 'cli',
  host: 'localhost',
  sshUser: 'fixture',
  osType: 'macos',
  claudePath: '',
  codexPath: '',
  opencodePath: '',
  cursorPath: '',
  grokPath: '',
  dispatchCmd: '',
  recycleCmd: '',
  repo,
  remoteRepo: repo,
  session: 'agent-browser-reap',
  slotMode: 'dispatch',
  slotEnabled: true,
  sshTarget: 'localhost',
  projectName: 'fixture',
  resourceVars: {},
};

/** A daemon the way agent-browser leaves one: detached (parent 1), cwd where it was started. */
const started = new Set<string>();
// A failed case must not leave a daemon holding a socket or port the next case needs.
afterEach(() => {
  for (const pid of started) spawnSync('kill', [pid]);
  started.clear();
});

async function orphanDaemon(
  cwd: string,
  session: string,
  port = '',
  secondSession = '',
): Promise<string> {
  const socket = path.join(socketDir, `${session}.sock`);
  // A stopped daemon leaves its socket file behind.
  rmSync(socket, { force: true });
  const second = secondSession.includes('/')
    ? secondSession
    : secondSession && path.join(socketDir, `${secondSession}.sock`);
  if (second) rmSync(second, { force: true });
  const pid = spawnSync(
    'sh',
    [
      '-c',
      `cd "$1" && ("$2" -e "$3" "$4" "$5" "$6" </dev/null >/dev/null 2>&1 & echo $!)`,
      'sh',
      cwd,
      bin,
      DAEMON,
      socket,
      port,
      second,
    ],
    { encoding: 'utf8' },
  ).stdout.trim();
  assert.match(pid, /^\d+$/, 'fixture daemon started');
  started.add(pid);
  for (let tries = 0; tries < 100 && !existsSync(socket); tries++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(existsSync(socket), `fixture daemon ${pid} listens on ${socket}`);
  // macOS reports the exec'd path, Linux a short name; either is agent-browser's.
  const comm = spawnSync('ps', ['-o', 'comm=', '-p', pid], { encoding: 'utf8' }).stdout.trim();
  assert.match(comm, /(?:^|\/)agent-browser/);
  return pid;
}
const parentOf = (pid: string) =>
  spawnSync('ps', ['-o', 'ppid=', '-p', pid], { encoding: 'utf8' }).stdout.trim();
// The reaper takes only detached processes (parent 1); a host whose orphans go to a
// subreaper cannot stage one.
const probe = await orphanDaemon(other, 'probe');
const detachedToInit = parentOf(probe) === '1';
spawnSync('kill', [probe]);
const skip = !detachedToInit && 'orphans reparent to a subreaper on this host';
const alive = (pid: string) => spawnSync('kill', ['-0', pid]).status === 0;
after(() => {
  spawnSync('pkill', ['-f', bin]);
  rmSync(root, { recursive: true, force: true });
  rmSync(socketDir, { recursive: true, force: true });
});

test(
  'terminal cleanup stops this slot’s and task-named agent-browser daemons, keeping default',
  { skip },
  async () => {
    const slotSession = await orphanDaemon(other, vars.slotId);
    const named = await orphanDaemon(repo, 'tat4626-settings');
    const namedElsewhere = await orphanDaemon(other, 'tat4626-stable');
    // On the slot's CDP port too, which takes other detached helpers there.
    const shared = await orphanDaemon(repo, 'default', CDP_PORT);

    assert.equal(
      await reapSlotBrowserSession(
        { ...vars, resourceVars: { cdp_port: CDP_PORT } },
        { includeSlotProfiles: true, stopSlotDaemons: true },
      ),
      null,
    );
    assert.equal(alive(slotSession), false, 'the slot session daemon is stopped wherever it runs');
    assert.equal(alive(named), false, 'a task-named session started in this checkout is stopped');
    assert.equal(alive(shared), true, 'the default session may serve workers on other slots');
    assert.equal(alive(namedElsewhere), true, 'a named session started outside the checkout stays');
    spawnSync('kill', [shared, namedElsewhere]);
  },
);

test(
  'cleanup that has not verified the run stopped leaves the slot daemons',
  { skip },
  async () => {
    const slotSession = await orphanDaemon(repo, vars.slotId);
    // Attached to the slot's CDP port, which takes other detached helpers there.
    const named = await orphanDaemon(repo, 'tat4626-alternate', CDP_PORT);
    // Prepare's clear, and a release that has not proved its workers stopped.
    for (const opts of [{}, { includeSlotProfiles: true }])
      assert.equal(
        await reapSlotBrowserSession({ ...vars, resourceVars: { cdp_port: CDP_PORT } }, opts),
        null,
      );
    assert.equal(alive(slotSession), true);
    assert.equal(alive(named), true);
    spawnSync('kill', [slotSession, named]);
  },
);

test('a daemon listening on more than one session socket is not attributed', { skip }, async () => {
  const ambiguous = await orphanDaemon(repo, 'default', '', 'tat4626-config-before');
  assert.equal(
    await reapSlotBrowserSession(vars, { includeSlotProfiles: true, stopSlotDaemons: true }),
    null,
  );
  assert.equal(alive(ambiguous), true);
  spawnSync('kill', [ambiguous]);
});

test(
  'two sockets with one session name in different directories are not attributed',
  { skip },
  async () => {
    const otherDir = mkdtempSync('/tmp/abr-');
    try {
      const ambiguous = await orphanDaemon(
        repo,
        'tat4626-reconciled',
        '',
        path.join(otherDir, 'tat4626-reconciled.sock'),
      );
      assert.equal(
        await reapSlotBrowserSession(vars, { includeSlotProfiles: true, stopSlotDaemons: true }),
        null,
      );
      assert.equal(alive(ambiguous), true);
      spawnSync('kill', [ambiguous]);
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  },
);
