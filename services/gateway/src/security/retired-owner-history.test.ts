import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test, type TestContext } from 'node:test';

import type { Principal, Run, RunStatus } from '@farmslot/protocol';

const root = mkdtempSync(path.join(tmpdir(), 'retired-owner-history-'));
const home = path.join(root, 'home');
mkdirSync(home, { recursive: true });
const previousHome = process.env.FARMSLOT_HOME;
const previousOwner = process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
process.env.FARMSLOT_HOME = home;
after(() => {
  if (previousHome === undefined) delete process.env.FARMSLOT_HOME;
  else process.env.FARMSLOT_HOME = previousHome;
  if (previousOwner === undefined) delete process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
  else process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = previousOwner;
  rmSync(root, { recursive: true, force: true });
});

const { buildFollowUpLineage } = await import('../family-observability/context.js');
const { createRun, deleteRun, updateRun } = await import('../runs/store.js');
const { runWithSessionOriginator } = await import('./work-originator.js');

const principal = (id: string, generation?: number): Principal => ({
  id,
  subject: { type: 'service', displayName: id },
  roles: [{ role: 'admin', scope: { kind: 'global' } }],
  ...(generation ? { generation } : {}),
});
const legacy = principal('legacy-env-test');
const automation = principal('farm-automation-test');
const otherLive = principal('other-live-owner-test');
const reused = principal('reused-owner-test', 1);

function writeStore(store: {
  principals: Principal[];
  retiredPrincipalIds?: string[];
  principalIdReuses?: { principalId: string; generation: number; reusedAt: string }[];
}): void {
  writeFileSync(
    path.join(home, 'credentials.json'),
    JSON.stringify({
      schemaVersion: 2,
      activatedAt: null,
      credentials: [],
      personSessions: [],
      personAccessTokens: [],
      ...store,
    }),
  );
}

function reviewParams() {
  return {
    flowType: 'review-pr' as const,
    project: 'native-worker-test',
    ticketOrPr: `MetaMask/metamask-mobile#${randomInt(100_000, 999_999)}`,
    transport: 'tmux' as const,
    reviewWorkspaceTarget: { machine: 'review-node-test' },
  };
}

/** A review the owner ran while it was the node's native owner, now at `status`. */
function priorReview(t: TestContext, owner: Principal, status: RunStatus) {
  process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = owner.id;
  writeStore({ principals: [owner] });
  const params = reviewParams();
  const run = runWithSessionOriginator(owner, () => createRun(params));
  updateRun(run.id, { status, taskFile: `/tmp/${run.id}/TASK.md` });
  const created: Run[] = [run];
  t.after(async () => {
    for (const record of created) {
      updateRun(record.id, { status: 'done', completedAt: new Date().toISOString() });
      await deleteRun(record.id);
    }
  });
  // The automation identity now owns the node's native profile.
  process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = automation.id;
  return { params, run, created };
}

test('a finished review of a retired principal is history, not ownership of the next review', (t) => {
  // Shape of Mobile #37454/#37269: finished tmux workspace reviews 1b621b87/e63feb11
  // belonged to legacy-env, which was then retired. run.create auto-links a new
  // review to the latest same-PR run through buildFollowUpLineage.
  const { params, run, created } = priorReview(t, legacy, 'done');
  writeStore({ principals: [automation], retiredPrincipalIds: [legacy.id] });

  const next = runWithSessionOriginator(automation, () =>
    createRun({ ...params, ...buildFollowUpLineage(run) }),
  );
  created.push(next);

  assert.equal(next.nativeOwnerPrincipalId, automation.id);
  assert.equal(next.parentRunId, run.id);
  assert.equal(next.familyId, run.familyId);
  assert.equal(run.nativeOwnerPrincipalId, legacy.id);
  assert.equal(run.status, 'done');
});

test('a live run of a retired principal still refuses another owner', (t) => {
  const { params, run } = priorReview(t, legacy, 'monitoring');
  writeStore({ principals: [automation], retiredPrincipalIds: [legacy.id] });

  assert.throws(
    () =>
      runWithSessionOriginator(automation, () =>
        createRun({ ...params, ...buildFollowUpLineage(run) }),
      ),
    /Workspace review belongs to another principal/,
  );
});

test('a finished review of a live principal still refuses another owner', (t) => {
  const { params, run } = priorReview(t, otherLive, 'done');
  writeStore({ principals: [automation, otherLive] });

  assert.throws(
    () =>
      runWithSessionOriginator(automation, () =>
        createRun({ ...params, ...buildFollowUpLineage(run) }),
      ),
    /Workspace review belongs to another principal/,
  );
});

test('a finished review of a since-reused id stays fail-closed', (t) => {
  const { params, run } = priorReview(t, { ...reused, generation: undefined }, 'done');
  writeStore({
    principals: [automation, reused],
    principalIdReuses: [
      { principalId: reused.id, generation: 1, reusedAt: '2026-10-16T00:00:00.000Z' },
    ],
  });

  assert.throws(
    () =>
      runWithSessionOriginator(automation, () =>
        createRun({ ...params, ...buildFollowUpLineage(run) }),
      ),
    /Workspace review belongs to another principal/,
  );
});
