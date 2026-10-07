import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import type { RunStack } from '@farmslot/protocol';

const testDir = mkdtempSync(path.join(os.tmpdir(), 'farmslot-stack-base-test-'));
process.env.FARMSLOT_BACKLOG_FILE = path.join(testDir, 'backlog.json');
process.env.FARMSLOT_DISPATCH_QUEUE_FILE = path.join(testDir, 'queue.json');
process.env.FARMSLOT_WORK_GRAPH_DIR = path.join(testDir, 'graphs');
process.env.FARMSLOT_RUNS_DIR = path.join(testDir, 'runs');

test.after(() => rm(testDir, { recursive: true, force: true }));

const backlog = await import('../backlog/store.js');
const queue = await import('../backlog/dispatch-queue.js');
const runs = await import('../runs/store.js');
const workGraph = await import('../work-graph/store.js');
const { contributionDiffBaseSpec } = await import('./diff-artifacts.js');
const { ensureRunStack, stackPrBase } = await import('./stack-base.js');
const { stackSection } = await import('../tasks/stack-section.js');

backlog.initBacklogStore(() => {});
queue.initDispatchQueue(
  () => {},
  async () => {},
);
workGraph.initWorkGraphStore(() => {});
await queue.loadQueue();
await backlog.loadBacklog();
await workGraph.loadWorkGraphs();
await runs.loadAllRuns();

const STACK: RunStack = {
  upstreamNodeId: 'wn_up',
  upstreamRunId: 'run-up',
  baseBranch: 'feat/upstream',
  upstreamPrNumber: 41,
  upstreamPrUrl: 'https://github.com/deeeed/farmslot/pull/41',
  resolvedSha: 'a'.repeat(40),
};

test('ensureRunStack stamps a stacked graph run and leaves every other run alone', async () => {
  const items = await Promise.all(
    ['Upstream', 'Downstream'].map((title) =>
      backlog.createBacklogItem(
        { project: 'farmslot-farm', title, sourceKind: 'manual', flowType: 'dev', status: 'ready' },
        { kind: 'system' },
      ),
    ),
  );
  const graph = await workGraph.createWorkGraph(
    { project: 'farmslot-farm', title: 'Stack base' },
    { kind: 'system' },
  );
  const graphId = graph.graph.graph.id;
  await workGraph.addWorkGraphNode({ graphId, id: 'wn_up', backlogItemId: items[0]!.item.id });
  await workGraph.addWorkGraphNode({ graphId, id: 'wn_down', backlogItemId: items[1]!.item.id });
  await workGraph.addWorkGraphEdge({
    graphId,
    fromNodeId: 'wn_up',
    toNodeId: 'wn_down',
    condition: { kind: 'published' },
  });
  await workGraph.activateWorkGraph({ graphId });
  const upstreamRun = runs.createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: items[0]!.item.sourceRef,
    backlogItemId: items[0]!.item.id,
    workGraphId: graphId,
    workNodeId: 'wn_up',
  });
  runs.updateRun(upstreamRun.id, { branch: 'feat/upstream', prNumber: 41, prState: 'OPEN' });
  await workGraph.schedulerTick({ graphId });

  const stacked = runs.createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: items[1]!.item.sourceRef,
    backlogItemId: items[1]!.item.id,
    workGraphId: graphId,
    workNodeId: 'wn_down',
  });
  const stamped = await ensureRunStack(stacked.id);
  assert.deepEqual(stamped.stack, {
    upstreamNodeId: 'wn_up',
    upstreamRunId: upstreamRun.id,
    baseBranch: 'feat/upstream',
    upstreamPrNumber: 41,
    upstreamPrUrl: 'https://github.com/deeeed/farmslot/pull/41',
  });

  const reviewOnSameNode = runs.createRun({
    flowType: 'review-pr',
    project: 'farmslot-farm',
    ticketOrPr: 'deeeed/farmslot#9',
    workGraphId: graphId,
    workNodeId: 'wn_down',
  });
  const plain = runs.createRun({ flowType: 'dev', project: 'farmslot-farm', ticketOrPr: 'X-1' });
  const bottom = runs.createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: 'X-2',
    workGraphId: graphId,
    workNodeId: 'wn_up',
  });
  for (const run of [reviewOnSameNode, plain, bottom]) {
    assert.equal((await ensureRunStack(run.id)).stack, undefined, run.ticketOrPr);
  }
});

test('stackPrBase targets the upstream branch until the run is retargeted', () => {
  assert.equal(stackPrBase({}), undefined);
  assert.equal(stackPrBase({ stack: STACK }), 'feat/upstream');
  assert.equal(stackPrBase({ stack: { ...STACK, retargetedTo: 'main' } }), 'main');
});

test('a stacked run diffs against the commit it branched from', () => {
  assert.deepEqual(contributionDiffBaseSpec({}, 'main'), {
    baseRef: 'origin/main',
    commitish: 'origin/main',
  });
  assert.deepEqual(contributionDiffBaseSpec({ stack: STACK }, 'main'), {
    baseRef: 'stack:feat/upstream',
    commitish: STACK.resolvedSha,
  });
  assert.deepEqual(
    contributionDiffBaseSpec({ stack: { ...STACK, retargetedTo: 'main' } }, 'main'),
    { baseRef: 'origin/main', commitish: 'origin/main' },
  );
});

test('the Stack section names the upstream PR, its branch and the downstream nodes', () => {
  assert.equal(stackSection({}), null);
  assert.equal(
    stackSection({ stack: { ...STACK, downstream: ['Polish (wn_polish)'] } }),
    [
      '## Stack',
      '',
      "You are on top of https://github.com/deeeed/farmslot/pull/41 (`feat/upstream`). Your branch starts from that PR's head and your PR targets `feat/upstream`. Do not change its files unless your task needs it.",
      'Downstream: Polish (wn_polish).',
    ].join('\n'),
  );
  assert.match(
    stackSection({ stack: { ...STACK, retargetedTo: 'main' } }) ?? '',
    /That PR has merged, so your PR targets `main`\. .*\nDownstream: none\./,
  );
});
