import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import type { QueueItem } from '@farmslot/protocol';

const root = mkdtempSync(path.join(tmpdir(), 'delegated-review-dispatch-'));
for (const dir of ['scripts', 'services/gateway', 'pool', 'projects/review/shared/review-pr']) {
  mkdirSync(path.join(root, dir), { recursive: true });
}
writeFileSync(path.join(root, 'CLAUDE.md'), '# Test root\n');
writeFileSync(path.join(root, 'scripts/dev.sh'), '#!/bin/sh\n');
writeFileSync(path.join(root, 'services/gateway/package.json'), '{}');
writeFileSync(
  path.join(root, 'projects/review/project.json'),
  JSON.stringify({
    name: 'review',
    repo_url: 'https://github.com/owner/repo.git',
    ci: { repo: 'owner/repo' },
    static_review: { template_id: 'review-pr/default' },
    execution_templates: {
      sources: [{ id: 'workspace:shared', kind: 'workspace', root: { projectPath: 'shared' } }],
    },
  }),
);
writeFileSync(
  path.join(root, 'projects/review/shared/review-pr/default.md'),
  '---\nplatforms: [cli]\n---\n\n- [ ] Review the change.\n',
);
writeFileSync(
  path.join(root, 'pool/review.json'),
  JSON.stringify({
    machine: 'review-node',
    project: 'review',
    host: 'localhost',
    platform: 'cli',
    slots: [],
    review_workspaces: { max_concurrent: 2 },
  }),
);
process.env.FARMSLOT_ROOT = root;
process.env.FARMSLOT_POOL_DIR = path.join(root, 'pool');
process.env.FARMSLOT_PROJECTS_DIR = path.join(root, 'projects');
process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = 'farm-automation';
process.env.FARMSLOT_HOME = path.join(root, 'home');
process.env.FARMSLOT_DISPATCH_PRESSURE_ADMISSION = 'off';
after(() => rmSync(root, { recursive: true, force: true }));

const { addItem, getQueueSnapshot, initDispatchQueue, removeItem, tryDispatchNext } =
  await import('./dispatch-queue.js');

test('a queued delegated static review is placed for its native owner, not its requester', async () => {
  const dispatched: QueueItem[] = [];
  initDispatchQueue(
    () => {},
    async (item) => {
      dispatched.push(item);
    },
  );
  const review = {
    flowType: 'review-pr' as const,
    project: 'review',
    ticketOrPr: 'owner/repo#1',
    reviewWorkspaceTarget: { machine: 'review-node' },
    runner: 'codex',
    model: 'gpt-6-astra',
    effort: 'high',
    transport: 'tmux' as const,
  };
  // The generation-one requester holds no native ownership of its own.
  const requester = { kind: 'principal' as const, principalId: 'arthur', principalGeneration: 1 };
  const delegated = addItem(review, requester, { delegatedOwnerPrincipalId: 'farm-automation' });
  const own = addItem({ ...review, ticketOrPr: 'owner/repo#2' }, requester);
  try {
    await tryDispatchNext();
    await tryDispatchNext();
    assert.deepEqual(
      dispatched.map((item) => [item.id, item.delegatedOwnerPrincipalId]),
      [[delegated.id, 'farm-automation']],
    );
    const waiting = getQueueSnapshot().find((row) => row.id === own.id);
    assert.equal(waiting?.status, 'queued');
    assert.match(waiting?.waitingReason ?? '', /does not own this local execution node/);
  } finally {
    for (const row of [delegated, own])
      if (getQueueSnapshot().some((item) => item.id === row.id)) removeItem(row.id);
  }
});

test('a live static review request from an admin replacement plans under the native owner', async () => {
  const { CredentialStoreRuntime, CredentialStoreWriter } =
    await import('@farmslot/credential-store');
  const { planRunCreation } = await import('../methods/run.js');
  const { runWithSessionOriginator } = await import('../security/work-originator.js');
  const writer = new CredentialStoreWriter(
    new CredentialStoreRuntime({ FARMSLOT_HOME: process.env.FARMSLOT_HOME }),
  );
  const admin = [{ role: 'admin' as const, scope: { kind: 'global' as const } }];
  const automation = writer.createPrincipal(
    { type: 'service', displayName: 'Automation' },
    admin,
    'farm-automation',
  );
  writer.issueCredential(automation.id, 'automation');
  writer.createPrincipal({ type: 'person', displayName: 'Arthur' }, admin, 'arthur');
  writer.retirePrincipals(['arthur']);
  const arthur = writer.createPrincipal(
    { type: 'person', displayName: 'Arthur' },
    admin,
    'arthur',
    {
      reuseRetiredId: true,
    },
  );
  const review = {
    flowType: 'review-pr' as const,
    project: 'review',
    ticketOrPr: 'owner/repo#3',
    reviewWorkspaceTarget: { machine: 'review-node' },
    runner: 'codex',
    model: 'gpt-6-astra',
    effort: 'high',
    transport: 'tmux' as const,
  };
  const plan = await runWithSessionOriginator(arthur, () =>
    planRunCreation(review, { reviewDelegation: 'live' }),
  );
  assert.deepEqual(plan.staticReviewOwner, {
    ownerId: 'farm-automation',
    requester: { principalId: 'arthur', principalGeneration: 1 },
  });
  // Without a live request the replacement is refused for native ownership.
  await assert.rejects(
    runWithSessionOriginator(arthur, () => planRunCreation(review)),
    /arthur is a replacement identity/,
  );
});
