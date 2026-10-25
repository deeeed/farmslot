import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import type { SlotRecovery } from '@farmslot/protocol';

const root = await mkdtemp(path.join(os.tmpdir(), 'release-recovery-owner-'));
for (const name of [
  'pool',
  'projects/proof',
  'repo',
  'services/gateway',
  'scripts',
  'home',
  'runs',
])
  await mkdir(path.join(root, name), { recursive: true });
Object.assign(process.env, {
  NODE_TEST_CONTEXT: '1',
  FARMSLOT_ROOT: root,
  FARMSLOT_HOME: path.join(root, 'home'),
  FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
  FARMSLOT_NATIVE_STATE_DIR: path.join(root, 'native'),
  FARMSLOT_TEST_STATUS_FILE: path.join(root, 'status.json'),
});
after(() => rm(root, { recursive: true, force: true }));
await writeFile(path.join(root, 'CLAUDE.md'), '# Owned release fixture\n');
await writeFile(path.join(root, 'scripts/dev.sh'), 'exit 1\n');
await writeFile(path.join(root, 'services/gateway/package.json'), '{}');
await writeFile(
  path.join(root, 'projects/proof/project.json'),
  JSON.stringify({ name: 'proof', default_branch: 'main' }),
);
await writeFile(
  path.join(root, 'pool/local.json'),
  JSON.stringify({
    machine: os.hostname(),
    host: 'localhost',
    ssh_user: os.userInfo().username,
    platform: 'cli',
    project: 'proof',
    slots: [{ id: 'owned-recovery', repo: path.join(root, 'repo'), session: 'owned-recovery' }],
  }),
);
await import('../../runtime/mock-pty.test-support.js');
let reachedCleanup = false;
const store = await import('../../runs/store.js');
const owner = store.createRun({
  project: 'proof',
  flowType: 'dev',
  ticketOrPr: 'PROOF-1',
  mode: 'validation',
  slotId: 'owned-recovery',
});
store.updateRun(owner.id, { status: 'done', completedAt: new Date().toISOString() });
const recovery: SlotRecovery = {
  id: 'recovery-1',
  identity: {
    epoch: 4,
    currentRunId: owner.id,
    cleanupRunId: null,
    handoffRunId: null,
    branch: 'previous',
    headSha: 'a'.repeat(40),
    dirtyFingerprint: 'b'.repeat(64),
    recoveryId: 'recovery-1',
  },
  completed: ['inspect'],
  phase: 'cleanup',
};
const row = {
  slot: 'owned-recovery',
  lifecycle: 'busy',
  phase: 'releasing',
  slot_epoch: 4,
  current_run_id: owner.id,
  workspace_recovery: recovery,
};
await writeFile(path.join(root, 'status.json'), JSON.stringify({ slots: [row] }));
const { slotRelease } = await import('./release.js');

test('a recovery continuation keeps the terminal owner of its borrowed release fence', async () => {
  await assert.rejects(
    slotRelease({ slotId: 'owned-recovery', preserveAgents: true }, () => {}, {
      workspaceRecovery: {
        id: recovery.id,
        epoch: 4,
        verifyWork: async () => {
          reachedCleanup = true;
          throw new Error('OWNED_CLEANUP_REACHED');
        },
        discardLocalWork: false,
      },
    }),
    /OWNED_CLEANUP_REACHED/,
  );
  assert.equal(reachedCleanup, true);
});
