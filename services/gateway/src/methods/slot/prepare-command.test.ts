import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { SlotVars } from '../../core/index.js';
import { resolveWorkspaceRoot } from '../../projects/repo-root.js';

import {
  buildPrepareWrappedCommand,
  clearStalePrepareProcess,
  prepareSignalHint,
} from './prepare-command.js';

test('prepareSignalHint names external tmux kills and ignores ordinary exit codes', () => {
  assert.match(prepareSignalHint(129) ?? '', /SIGHUP/);
  assert.match(prepareSignalHint(129) ?? '', /killed externally/);
  assert.match(prepareSignalHint(143) ?? '', /SIGTERM/);
  assert.equal(prepareSignalHint(1), null);
  assert.equal(prepareSignalHint(0), null);
  assert.equal(prepareSignalHint(null), null);
});

// Local slot: execOnSlot runs the cleanup script via execLocal (bash -c) on this
// host, so the kill-detection path exercises the real shell + PID-liveness marker
// contract that recovery relies on. projectName/slotId are deliberately unique so
// the always-on fallback patterns match nothing on the test machine.
function localVars(): SlotVars {
  return {
    host: 'localhost',
    machine: 'localhost',
    remoteRepo: os.tmpdir(),
    projectName: `no-such-project-${randomUUID()}`,
    slotId: `no-such-slot-${randomUUID()}`,
  } as unknown as SlotVars;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('clearStalePrepareProcess returns true and kills the tracked in-flight preflight', async () => {
  // The tracked-PID branch fires only when the pid is alive AND its command
  // looks like a preflight. Pass a `preflight.sh` path as $0 so it shows up in
  // the process command line; the while-loop keeps bash from exec-optimising and
  // dropping that argv.
  const child = spawn(
    'bash',
    ['-c', 'while :; do sleep 1; done', '/tmp/farmslot-test/setup/preflight.sh'],
    { stdio: 'ignore' },
  );
  child.unref();
  const pidFile = path.join(os.tmpdir(), `farmslot-preflight-test-${randomUUID()}.pid`);
  await writeFile(pidFile, String(child.pid), 'utf-8');

  let killed: boolean;
  try {
    await delay(300); // let the child be visible to ps/kill
    killed = await clearStalePrepareProcess(localVars(), pidFile, 'test', []);
  } finally {
    if (isAlive(child.pid)) {
      try {
        process.kill(child.pid!, 'SIGKILL');
      } catch {
        // best-effort: process may already be gone
      }
    }
  }

  assert.equal(killed, true);
  await delay(200);
  assert.equal(isAlive(child.pid), false, 'tracked preflight should be terminated');
});

test('resolveWorkspaceRoot returns the workspace root (parent holding state.json), not $HOME/farmslot', () => {
  // Fake install layout: <ws>/farmslot (the clone) + <ws>/state.json. With no
  // FARMSLOT_WORKSPACE in env, the resolver must climb to the parent that holds
  // state.json — the same value the CLI's resolveWorkspace produces — so pack
  // runway scripts write under this workspace instead of $HOME/farmslot.
  const ws = mkdtempSync(path.join(os.tmpdir(), 'farmslot-ws-'));
  const clone = path.join(ws, 'farmslot');
  mkdirSync(clone, { recursive: true });
  writeFileSync(path.join(ws, 'state.json'), '{"schema_version":1}\n');

  const resolved = resolveWorkspaceRoot({} as NodeJS.ProcessEnv, clone);

  assert.equal(resolved, ws);
  assert.notEqual(resolved, path.join(os.homedir(), 'farmslot'));
});

test('resolveWorkspaceRoot honours an explicit FARMSLOT_WORKSPACE without overriding it', () => {
  const explicit = mkdtempSync(path.join(os.tmpdir(), 'farmslot-explicit-'));
  const resolved = resolveWorkspaceRoot(
    { FARMSLOT_WORKSPACE: explicit } as NodeJS.ProcessEnv,
    '/some/unrelated/clone',
  );
  assert.equal(resolved, explicit);
});

test('resolveWorkspaceRoot returns null for a plain dev checkout with no workspace', () => {
  const bare = mkdtempSync(path.join(os.tmpdir(), 'farmslot-bare-'));
  const clone = path.join(bare, 'farmslot');
  mkdirSync(clone, { recursive: true });
  // No state.json beside the clone → no surrounding workspace.
  assert.equal(resolveWorkspaceRoot({} as NodeJS.ProcessEnv, clone), null);
});

test('buildPrepareWrappedCommand exports the resolved FARMSLOT_WORKSPACE, not $HOME/farmslot', () => {
  const wsRoot = '/data/farms/dev-farm';
  const wrapped = buildPrepareWrappedCommand('echo hi', '/tmp/scratch/s.exit', '/tmp/scratch', {
    workspaceRoot: wsRoot,
  });
  assert.match(wrapped, /export FARMSLOT_WORKSPACE='\/data\/farms\/dev-farm'/);
  assert.ok(
    !wrapped.includes(path.join(os.homedir(), 'farmslot')),
    'must not fall back to $HOME/farmslot when a workspace is resolvable',
  );
});

test('buildPrepareWrappedCommand omits the export when no workspace resolves', () => {
  const wrapped = buildPrepareWrappedCommand('echo hi', '/tmp/scratch/s.exit', '/tmp/scratch', {
    workspaceRoot: null,
  });
  assert.ok(
    !wrapped.includes('FARMSLOT_WORKSPACE'),
    'a plain dev checkout must leave FARMSLOT_WORKSPACE unset for the pack default',
  );
});

test('buildPrepareWrappedCommand persists an opaque prepare scope through an exact sentinel', () => {
  const command = buildPrepareWrappedCommand('echo ok', '/tmp/prep.exit', '/tmp/prep', {
    prepareScope: {
      token: '11111111111111111111111111111111',
      identityPath: '/tmp/runtime/preflight.identity',
    },
  });

  assert.match(command, /FARMSLOT_PREPARE_SCOPE='11111111111111111111111111111111'/);
  assert.match(command, /farmslot-prepare-scope '11111111111111111111111111111111'/);
  assert.match(command, /preflight\.identity/);
  assert.match(command, /FARMSLOT_PREPARE_SENTINEL_PID/);
  assert.match(command, /parent.*FARMSLOT_PREPARE_SENTINEL_PID.*return/);
});

test('clearStalePrepareProcess returns false when there is no live tracked preflight', async () => {
  // Missing pid file: the tracked-PID branch is skipped and the fallback sweep
  // matches nothing real, so no kill is reported. This guards against the
  // fallback sweep self-signalling a kill under `bash -c`.
  const pidFile = path.join(os.tmpdir(), `farmslot-preflight-test-${randomUUID()}.pid`);

  const killed = await clearStalePrepareProcess(localVars(), pidFile, 'test', [
    `no-match-pattern-${randomUUID()}`,
  ]);

  assert.equal(killed, false);
});
