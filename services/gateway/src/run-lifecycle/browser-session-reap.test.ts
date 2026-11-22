import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
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
for (const dir of [repo, other, path.dirname(bin)]) mkdirSync(dir, { recursive: true });
symlinkSync('/bin/sleep', bin);

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
async function orphanDaemon(cwd: string, seconds: number): Promise<string> {
  const pid = spawnSync(
    'sh',
    ['-c', `cd "$1" && ("$2" ${seconds} </dev/null >/dev/null 2>&1 & echo $!)`, 'sh', cwd, bin],
    { encoding: 'utf8' },
  ).stdout.trim();
  assert.match(pid, /^\d+$/, 'fixture daemon started');
  // The subshell exits at once; wait for the daemon to run as the reparented executable.
  for (let tries = 0; tries < 50; tries++) {
    const row = spawnSync('ps', ['-o', 'ppid=,comm=', '-p', pid], { encoding: 'utf8' }).stdout;
    if (row.trim() === `1 ${bin}`) return pid;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`fixture daemon ${pid} never ran detached as ${bin}`);
}
const alive = (pid: string) => spawnSync('kill', ['-0', pid]).status === 0;
after(() => {
  spawnSync('pkill', ['-f', bin]);
  rmSync(root, { recursive: true, force: true });
});

test('terminal cleanup stops a detached agent-browser daemon working in the slot checkout', async () => {
  const inside = await orphanDaemon(repo, 301);
  const outside = await orphanDaemon(other, 302);

  assert.equal(await reapSlotBrowserSession(vars, { includeSlotProfiles: true }), null);
  assert.equal(alive(inside), false, 'the slot daemon is stopped');
  assert.equal(alive(outside), true, 'a daemon outside the checkout is left alone');
});

test('cleanup that has not verified the run stopped leaves the daemon', async () => {
  const inside = await orphanDaemon(repo, 303);
  // With a CDP port the census runs; the daemon is neither on it nor using a slot profile.
  assert.equal(
    await reapSlotBrowserSession({ ...vars, resourceVars: { cdp_port: '59543' } }),
    null,
  );
  assert.equal(alive(inside), true);
});
