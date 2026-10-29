import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { ResourceChangedPayload } from '@farmslot/protocol';
import { resourceQuery } from '@farmslot/protocol/client-cache';

import { GatewayMethodError } from '../core/method-error.js';
import { farmslotRoot } from '../projects/repo-root.js';
import { createGatewayAuthRuntime, initializeGatewayIdentity } from '../security/auth.js';
import type { ClientState } from '../server/client-state.js';

import { canReadResourceKey } from './authorization.js';
import { publishPlanningResources } from './planning-changes.js';
import { GatewayResourceRevisions, resourceRevisions } from './revisions.js';

// Select private storage before loading the owning stores, once per isolated test process.
const writerHome = mkdtempSync(path.join(os.tmpdir(), 'farmslot-planning-writers-'));
process.env.FARMSLOT_BACKLOG_FILE = path.join(writerHome, 'backlog.json');
process.env.FARMSLOT_DISPATCH_QUEUE_FILE = path.join(writerHome, 'queue.json');
process.env.FARMSLOT_ROADMAP_DIR = path.join(writerHome, 'roadmap');
process.env.FARMSLOT_WORK_GRAPH_DIR = path.join(writerHome, 'graphs');
const backlog = await import('../backlog/store.js');
const roadmap = await import('../roadmap/store.js');
const workGraph = await import('../work-graph/store.js');
const queue = await import('../backlog/dispatch-queue.js');
test.after(async () => {
  await backlog.flushBacklogForTests();
  await queue.persistQueueNow();
  await rm(writerHome, { recursive: true, force: true });
});

test('deleting a planning item changes collection membership and deletes only its detail', async () => {
  const revisions = new GatewayResourceRevisions();
  const packets: ResourceChangedPayload[] = [];
  revisions.setPublisher((packet) => packets.push(packet));
  try {
    publishPlanningResources('roadmap', 'item', 'deleted', revisions);
    await Promise.resolve();
    assert.deepEqual(
      packets.flatMap((packet) => packet.changes),
      [
        {
          key: { family: 'planning', collection: 'roadmap' },
          revision: 1,
          kind: 'updated',
        },
        {
          key: { family: 'planning', collection: 'roadmap', itemId: 'item' },
          revision: 1,
          kind: 'deleted',
        },
      ],
    );
    assert.equal(revisions.revision({ family: 'planning', collection: 'backlog' }), 0);
  } finally {
    revisions.dispose();
  }
});

test('real backlog, roadmap and graph stores invalidate after their new facts are readable', async (t) => {
  const project = path.basename(writerHome);
  const projectDir = path.join(farmslotRoot, 'projects', project);
  await mkdir(projectDir);
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  await writeFile(
    path.join(projectDir, 'project.json'),
    JSON.stringify({
      name: project,
      repo_url: `git@example.com:${project}.git`,
      default_branch: 'main',
    }),
    { flag: 'wx' },
  );
  const originator = { kind: 'system' } as const;
  const backlogKey = { family: 'planning', collection: 'backlog' } as const;
  const roadmapKey = { family: 'planning', collection: 'roadmap' } as const;
  const graphKey = { family: 'planning', collection: 'work-graphs' } as const;
  const beforeBacklog = resourceRevisions.revision(backlogKey);
  backlog.initBacklogStore(() => {
    assert(resourceRevisions.revision(backlogKey) > beforeBacklog);
  });

  const created = await backlog.createBacklogItem(
    { project, title: 'Candidate', sourceKind: 'manual', flowType: 'dev' },
    originator,
  );
  assert.equal(resourceRevisions.revision(backlogKey), beforeBacklog + 1);
  await backlog.updateBacklogItem({ itemId: created.item.id, title: 'Renamed' }, originator);
  assert.equal(backlog.listBacklogItems().items[0].title, 'Renamed');
  assert.equal(resourceRevisions.revision(backlogKey), beforeBacklog + 2);
  await backlog.markBacklogItemNeedsAttention({ itemId: created.item.id, reason: 'test archive' });
  await backlog.archiveBacklogItem({ itemId: created.item.id }, originator);
  assert.equal(backlog.listBacklogItems().items.length, 0);
  assert.equal(resourceRevisions.revision(backlogKey), beforeBacklog + 4);
  await backlog.deleteBacklogItem(created.item.id);
  assert.equal(backlog.listBacklogItems({ includeArchived: true }).items.length, 0);
  assert.equal(resourceRevisions.revision(backlogKey), beforeBacklog + 5);

  const beforeRoadmap = resourceRevisions.revision(roadmapKey);
  const saved = await roadmap.saveRoadmapItem({
    item: { title: 'Roadmap candidate', body: 'Original body.' },
  });
  assert.equal(resourceRevisions.revision(roadmapKey), beforeRoadmap + 1);
  const detailKey = { ...roadmapKey, itemId: saved.item.id };
  assert.equal(resourceRevisions.revision(detailKey), 1);
  const updated = await roadmap.saveRoadmapItem({
    expectedHash: saved.item.fileHash,
    item: { ...saved.item, title: 'Changed candidate', body: 'Changed body.' },
  });
  assert.equal(
    (await roadmap.getRoadmapItem({ itemId: saved.item.id })).item.body.trim(),
    'Changed body.',
  );
  assert.match(await readFile(updated.item.filePath, 'utf-8'), /Changed body\./);
  assert.equal(resourceRevisions.revision(roadmapKey), beforeRoadmap + 2);
  assert.equal(resourceRevisions.revision(detailKey), 2);
  await assert.rejects(
    roadmap.saveRoadmapItem({
      expectedHash: saved.item.fileHash,
      item: { ...updated.item, body: 'Refused old hash.' },
    }),
    /changed on disk/,
  );
  assert.equal(resourceRevisions.revision(detailKey), 2, 'Refused writes cannot publish a change');
  await roadmap.deleteRoadmapItem({ itemId: saved.item.id, expectedHash: updated.item.fileHash });
  assert.equal(resourceRevisions.revision(detailKey), 3);
  assert.equal((await roadmap.listRoadmapItems()).items.length, 0);
  await assert.rejects(
    roadmap.getRoadmapItem({ itemId: saved.item.id }),
    (error) => error instanceof GatewayMethodError && error.code === 'NOT_FOUND',
  );

  const beforeGraph = resourceRevisions.revision(graphKey);
  const graph = await workGraph.createWorkGraph({ project, title: 'Plan' }, originator);
  assert.equal(resourceRevisions.revision(graphKey), beforeGraph + 1);
  await workGraph.pauseWorkGraph({ graphId: graph.graph.graph.id }, originator);
  assert.equal(
    workGraph.getWorkGraph({ graphId: graph.graph.graph.id }).graph.graph.status,
    'paused',
  );
  assert.equal(resourceRevisions.revision(graphKey), beforeGraph + 2);

  const queueKey = { family: 'planning', collection: 'dispatch-queue' } as const;
  const beforeQueue = resourceRevisions.revision(queueKey);
  const queued = queue.addItem(
    { project, flowType: 'dev', ticketOrPr: 'MANUAL-000001' },
    originator,
  );
  assert.equal(resourceRevisions.revision(queueKey), beforeQueue + 1);
  const claim = queue.claimQueueItem(queued.id, 'planning-test');
  assert(claim);
  assert.equal(queue.listItems().length, 0);
  assert.equal(resourceRevisions.revision(queueKey), beforeQueue + 2);
  assert.equal(queue.releaseQueueClaim(claim), true);
  assert.equal(queue.listItems().length, 1);
  assert.equal(resourceRevisions.revision(queueKey), beforeQueue + 3);
  queue.removeQueueItemInternal(queued.id);
  assert.equal(queue.listItems().length, 0);
  assert.equal(resourceRevisions.revision(queueKey), beforeQueue + 4);

  const query = resourceQuery('roadmap.get', { itemId: saved.item.id });
  const stamp = resourceRevisions.sample(query.dependencies);
  assert(
    stamp.dependencies.some(
      ({ key, revision }) =>
        key.family === 'planning' && key.collection === 'backlog' && revision === beforeBacklog + 5,
    ),
  );
});

test('planning notification authorization keeps admin roadmap data separate from operator lists', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'farmslot-planning-authorization-'));
  try {
    const runtime = createGatewayAuthRuntime({ FARMSLOT_HOME: home });
    initializeGatewayIdentity(runtime, { host: '127.0.0.1' });
    const principal = runtime.writer.createPrincipal({ type: 'person', displayName: 'Planner' }, [
      { role: 'operator', scope: { kind: 'global' } },
    ]);
    const issued = runtime.writer.issueCredential(principal.id, 'planning-tests');
    const grant = runtime.writer.exchangePersonCredential(issued.secret, {
      deviceName: 'Planning test',
      deviceKind: 'cli',
    });
    const resolution = runtime.resolver.resolveSecret(grant.accessToken, 'token');
    assert(resolution.ok && resolution.authentication);
    const state = {
      authenticated: true,
      clientKind: 'ui',
      authentication: resolution.authentication,
    } as ClientState;
    for (const collection of ['backlog', 'work-graphs', 'dispatch-queue'] as const)
      assert.equal(canReadResourceKey(runtime, state, { family: 'planning', collection }), true);
    assert.equal(
      canReadResourceKey(runtime, state, { family: 'planning', collection: 'roadmap' }),
      false,
    );
    runtime.writer.grantRole(principal.id, 'admin', { kind: 'global' });
    assert.equal(
      canReadResourceKey(runtime, state, { family: 'planning', collection: 'roadmap' }),
      true,
    );
    runtime.writer.revokeRole(principal.id, 'admin', { kind: 'global' });
    runtime.writer.revokeRole(principal.id, 'operator', { kind: 'global' });
    for (const collection of ['backlog', 'roadmap', 'work-graphs', 'dispatch-queue'] as const)
      assert.equal(canReadResourceKey(runtime, state, { family: 'planning', collection }), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
