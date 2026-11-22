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
const bin = path.join(root, 'npm/agent-browser/bin/agent-browser-darwin-arm64');
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
function orphanDaemon(cwd: string, seconds: number): string {
  spawnSync('sh', ['-c', `cd '${cwd}' && ('${bin}' ${seconds} </dev/null >/dev/null 2>&1 &)`]);
  const pid = spawnSync('pgrep', ['-f', `${bin} ${seconds}$`], { encoding: 'utf8' })
    .stdout.trim()
    .split('\n')[0];
  assert.ok(pid, 'fixture daemon started');
  return pid;
}
const alive = (pid: string) => spawnSync('kill', ['-0', pid]).status === 0;
after(() => {
  spawnSync('pkill', ['-f', bin]);
  rmSync(root, { recursive: true, force: true });
});

test('terminal cleanup stops a detached agent-browser daemon working in the slot checkout', async () => {
  const inside = orphanDaemon(repo, 301);
  const outside = orphanDaemon(other, 302);
  assert.equal(
    spawnSync('ps', ['-o', 'ppid=', '-p', inside], { encoding: 'utf8' }).stdout.trim(),
    '1',
  );

  assert.equal(await reapSlotBrowserSession(vars, { includeSlotProfiles: true }), null);
  assert.equal(alive(inside), false, 'the slot daemon is stopped');
  assert.equal(alive(outside), true, 'a daemon outside the checkout is left alone');
});

test('cleanup that has not verified the run stopped leaves the daemon', async () => {
  const inside = orphanDaemon(repo, 303);
  assert.equal(await reapSlotBrowserSession(vars), null);
  assert.equal(alive(inside), true);
});
