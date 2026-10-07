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

// Run persistence may still be flushing when the suite ends.
test.after(() => rm(testDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

const backlog = await import('../backlog/store.js');
const queue = await import('../backlog/dispatch-queue.js');
const runs = await import('../runs/store.js');
const workGraph = await import('../work-graph/store.js');
const { contributionDiffBaseSpec, contributionStack } = await import('./diff-artifacts.js');
const { ensureRunStack, scheduledGraphOf, setUpstreamPrReaderForTests, stackPrBase } =
  await import('./stack-base.js');
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

test('ensureRunStack stamps a stacked graph run and leaves every other run alone', async (t) => {
  type Pr = Awaited<ReturnType<typeof import('../work-graph/stack-retarget.js').readUpstreamPr>>;
  let upstreamPr: Pr = {
    state: 'open',
    merged: false,
    headRef: 'feat/upstream',
    sameRepo: true,
    url: 'https://github.com/deeeed/farmslot/pull/41',
  };
  const reads: number[] = [];
  setUpstreamPrReaderForTests(async (_project, prNumber) => {
    reads.push(prNumber);
    return upstreamPr;
  });
  t.after(() => setUpstreamPrReaderForTests(null));
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
  assert.deepEqual(reads, [41], 'only the stacked run asks GitHub');

  // GitHub, not the last ci-watch observation, decides what the upstream PR is.
  const fresh = () =>
    runs.createRun({
      flowType: 'dev',
      project: 'farmslot-farm',
      ticketOrPr: items[1]!.item.sourceRef,
      workGraphId: graphId,
      workNodeId: 'wn_down',
    }).id;
  upstreamPr = { ...upstreamPr, state: 'closed', merged: true };
  assert.equal((await ensureRunStack(fresh())).stack, undefined, 'merged: start from default');
  upstreamPr = { ...upstreamPr, merged: false };
  await assert.rejects(ensureRunStack(fresh()), /is closed/);
  upstreamPr = { ...upstreamPr, state: 'open', sameRepo: false };
  await assert.rejects(ensureRunStack(fresh()), /comes from a fork/);
});

test('a follow-up measures its diff from the stacked run it continues', async () => {
  const root = runs.createRun({ flowType: 'dev', project: 'farmslot-farm', ticketOrPr: 'S-1' });
  runs.updateRun(root.id, { stack: STACK });
  const followUp = runs.createRun({
    flowType: 'pr-complete',
    project: 'farmslot-farm',
    ticketOrPr: 'deeeed/farmslot#42',
    familyId: root.familyId,
    parentRunId: root.id,
  });
  assert.deepEqual(await contributionStack(runs.getRun(followUp.id)!), STACK);
  // A sibling candidate in the same family stacked on a newer upstream commit:
  // its own follow-up takes the candidate's stack, not the family root's.
  const candidate = runs.createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: 'S-1',
    familyId: root.familyId,
    parentRunId: root.id,
  });
  const newer = { ...STACK, resolvedSha: 'b'.repeat(40) };
  runs.updateRun(candidate.id, { stack: newer });
  const candidateFollowUp = runs.createRun({
    flowType: 'pr-complete',
    project: 'farmslot-farm',
    ticketOrPr: 'deeeed/farmslot#43',
    familyId: root.familyId,
    parentRunId: candidate.id,
  });
  assert.deepEqual(await contributionStack(runs.getRun(candidateFollowUp.id)!), newer);
  const unrelated = runs.createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: 'S-2',
  });
  assert.equal(await contributionStack(unrelated), undefined);
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
    stackBranch: 'feat/upstream',
  });
  // Retargeting alone does not move the base: the checkout's history does
  // (settleStackedDiffBase, covered with real git in stacked-diff-base.test.ts).
  assert.deepEqual(
    contributionDiffBaseSpec({ stack: { ...STACK, retargetedTo: 'main' } }, 'main'),
    { baseRef: 'stack:feat/upstream', commitish: STACK.resolvedSha, stackBranch: 'feat/upstream' },
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

test("a follow-up of a stacked run reports that run's graph; other runs only their own", () => {
  const stacked = runs.createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: 'G-1',
    workGraphId: 'wg_stacked',
    workNodeId: 'wn_b',
  });
  runs.updateRun(stacked.id, { stack: STACK });
  const followUp = runs.createRun({
    flowType: 'pr-complete',
    project: 'farmslot-farm',
    ticketOrPr: 'deeeed/farmslot#44',
    familyId: stacked.familyId,
    parentRunId: stacked.id,
  });
  assert.equal(scheduledGraphOf(runs.getRun(followUp.id)!), 'wg_stacked');
  const plainParent = runs.createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: 'G-2',
    workGraphId: 'wg_plain',
    workNodeId: 'wn_x',
  });
  const plainFollowUp = runs.createRun({
    flowType: 'pr-complete',
    project: 'farmslot-farm',
    ticketOrPr: 'deeeed/farmslot#45',
    familyId: plainParent.familyId,
    parentRunId: plainParent.id,
  });
  assert.equal(scheduledGraphOf(runs.getRun(plainFollowUp.id)!), undefined, 'unchanged');
  assert.equal(scheduledGraphOf(plainParent), 'wg_plain');
});

test('a follow-up keeps its stack after the stacked run is archived', async () => {
  const stacked = runs.createRun({ flowType: 'dev', project: 'farmslot-farm', ticketOrPr: 'AR-1' });
  runs.updateRun(stacked.id, {
    stack: STACK,
    status: 'done',
    completedAt: new Date().toISOString(),
  });
  const followUp = runs.createRun({
    flowType: 'pr-complete',
    project: 'farmslot-farm',
    ticketOrPr: 'deeeed/farmslot#46',
    familyId: stacked.familyId,
    parentRunId: stacked.id,
  });
  await runs.persistRunNow(runs.getRun(stacked.id)!, 'test');
  assert.equal(await runs.archiveRun(stacked.id), true);
  assert.equal(runs.getRun(stacked.id), undefined, 'gone from the live store');
  assert.deepEqual(await contributionStack(runs.getRun(followUp.id)!), STACK);
});
