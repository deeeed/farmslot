import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { SlotVars } from '../../core/config.js';

import { runHealthCheck } from './check.js';

function makeSlotVars(remoteRepo: string): SlotVars {
  return {
    slotId: 'health-test',
    machine: os.hostname(),
    platform: 'ios',
    host: 'localhost',
    sshUser: 'test',
    osType: 'darwin',
    claudePath: '',
    codexPath: '',
    opencodePath: '',
    cursorPath: '',
    dispatchCmd: '',
    recycleCmd: '',
    repo: remoteRepo,
    session: 'health-test',
    slotMode: 'dispatch',
    slotEnabled: true,
    sshTarget: '',
    remoteRepo,
    projectName: 'health-test',
    resourceVars: {},
  };
}

test('runHealthCheck ignores stdout from failed health commands', async (t) => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'farmslot-health-'));
  t.after(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  const result = await runHealthCheck(
    makeSlotVars(repo),
    `printf '%s\\n' '{"ready":true,"route":"WalletView"}'; exit 7`,
    'python3 -c "import json,sys; print(json.load(sys.stdin).get(\\"route\\", \\"\\"))"',
  );

  assert.equal(result, '');
});
