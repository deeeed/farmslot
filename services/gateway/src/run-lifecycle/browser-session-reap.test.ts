import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

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
const DAEMON = `require('node:net').createServer().listen(process.argv[1]); setInterval(() => {}, 1e6)`;

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
async function orphanDaemon(cwd: string, session: string): Promise<string> {
  const socket = path.join(socketDir, `${session}.sock`);
  rmSync(socket, { force: true }); // A stopped daemon leaves its socket file behind.
  const pid = spawnSync(
    'sh',
    [
      '-c',
      `cd "$1" && ("$2" -e "$3" "$4" </dev/null >/dev/null 2>&1 & echo $!)`,
      'sh',
      cwd,
      bin,
      DAEMON,
      socket,
    ],
    { encoding: 'utf8' },
  ).stdout.trim();
  assert.match(pid, /^\d+$/, 'fixture daemon started');
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
    const shared = await orphanDaemon(repo, 'default');

    assert.equal(await reapSlotBrowserSession(vars, { includeSlotProfiles: true }), null);
    assert.equal(alive(slotSession), false, 'the slot session daemon is stopped wherever it runs');
    assert.equal(alive(named), false, 'a task-named session started in this checkout is stopped');
    assert.equal(alive(shared), true, 'the default session may serve workers on other slots');
    assert.equal(alive(namedElsewhere), true, 'a named session started outside the checkout stays');
  },
);

test('cleanup that has not verified the run stopped leaves the slot daemon', { skip }, async () => {
  const slotSession = await orphanDaemon(repo, vars.slotId);
  // With a CDP port the census runs; the daemon is neither on it nor using a slot profile.
  assert.equal(
    await reapSlotBrowserSession({ ...vars, resourceVars: { cdp_port: '59543' } }),
    null,
  );
  assert.equal(alive(slotSession), true);
});
