// Reclaims only the private fixture produced by slotless-review-retention.mts.
import assert from 'node:assert/strict';
import type { Run, RepeatReviewContext } from '@farmslot/protocol';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { mock } from 'node:test';
const repo = process.cwd();
const packet = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
assert.equal(packet.pass, true);
const root = packet.root;
assert(root.startsWith('/tmp/slotless-review-proof-'));
assert.equal(
  JSON.parse(fs.readFileSync(path.join(root, 'proof-owned.json'), 'utf8')).purpose,
  'slotless-review-retention',
);
Object.assign(process.env, {
  FARMSLOT_ROOT: root,
  FARMSLOT_HOME: path.join(root, 'home'),
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
  FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  FARMSLOT_NATIVE_STATE_DIR: path.join(root, 'native'),
  FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID: packet.ownerId,
  FARMSLOT_DISABLE_ORCHESTRATION: '1',
  FARMSLOT_TEST_STATUS_FILE: path.join(root, 'status.json'),
  NODE_TEST_CONTEXT: '1',
  TMUX_TMPDIR: path.join(root, 'tmux'),
});
const load = (relative: string) => import(pathToFileURL(path.join(repo, relative)).href);
const { createGatewayAuthRuntime } = await load('services/gateway/src/security/auth.ts');
const auth = createGatewayAuthRuntime({ FARMSLOT_HOME: process.env.FARMSLOT_HOME });
const { loadAllRuns, getAllRuns, getRun, createRun } = await load(
  'services/gateway/src/runs/store.ts',
);
await loadAllRuns();
const { initPRRules } = await load('services/gateway/src/methods/pr-rules.ts');
const { PRMonitorStore } = await load('services/gateway/src/pr-monitoring/store.ts');
const { PRMonitoringService } = await load('services/gateway/src/pr-monitoring/service.ts');
await initPRRules(
  auth,
  () => {},
  false,
  new PRMonitoringService(
    await PRMonitorStore.load(path.join(root, 'monitors.json')),
    () => true,
    () => {},
  ),
);
const { cleanupExpiredReviewWorkspaces } = await load(
  'services/gateway/src/review-workspaces/retention.ts',
);
const { configureWorkspaceContinuity } = await load(
  'services/gateway/src/review-workspaces/continuity.ts',
);
const { reviewRequestContextForRun } = await load('packages/review-dispatch/src/index.ts');
const { runCancel } = await load('services/gateway/src/methods/run/lifecycle-control.ts');
const originals = [packet.round1.id, packet.round2.id].map((id) => {
  const record: Run | undefined = getRun(id);
  assert(record?.reviewWorkspace && record.reviewResult?.session && record.agentContexts);
  return record;
});
const snapshot = originals.map((run) => ({
  id: run.id,
  result: structuredClone(run.reviewResult),
  workspace: run.reviewWorkspace!.checkoutPath,
  report: path.join(root, 'runs/review-workspace-tasks', run.id, 'view/artifacts/review.md'),
}));
const hash = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const hashes = snapshot.map((row) => hash(row.report));
const session = originals[0].agentContexts!.find((c) => c.id === 'review')!.runnerSessionPath!;
const now =
  Math.max(...originals.map((run) => Date.parse(run.reviewWorkspace!.retainedUntil!))) + 1000;
for (const candidate of getAllRuns()) {
  if (!['done', 'failed', 'cancelled', 'blocked'].includes(candidate.status)) {
    assert.equal(candidate.nativeOwnerPrincipalId, packet.ownerId);
    assert(!candidate.agentContexts?.length);
    await runCancel({ runId: candidate.id });
  }
}
const pending = createRun(
  {
    flowType: 'review-pr',
    project: 'fixture',
    ticketOrPr: 'example/fixture#42',
    mode: 'autonomous',
    runner: 'codex',
    model: 'gpt-6.1-sol',
    effort: 'low',
    transport: 'tmux',
    reviewMode: 'cold',
    reviewWorkspaceTarget: { machine: 'mini' },
  },
  { nativeOwnerPrincipalId: packet.ownerId, createdByPrincipalId: packet.ownerId },
);
assert.deepEqual(await cleanupExpiredReviewWorkspaces(now), []);
assert(snapshot.every((row) => fs.existsSync(row.workspace)));
assert(fs.existsSync(session));
await runCancel({ runId: pending.id });
const coldCurrent: Run = {
  ...originals[1],
  reviewMode: 'warm',
  reviewContext: reviewRequestContextForRun(originals[1]),
  reviewWorkspaceTarget: { machine: 'mini' },
};
const context: RepeatReviewContext = {
  generation: 2,
  verdict: 'pass',
  repository: 'example/fixture',
  prNumber: 42,
  unresolvedFindings: [],
  artifactRefs: [],
  farmslotEvidenceRefs: [],
  priorFamilyId: originals[1].familyId,
  ...originals[1].repeatReviewContext,
  session: originals[1].reviewResult!.session,
  priorRunId: originals[1].id,
  priorReviewedHeadSha: packet.nextHead,
  currentHeadSha: packet.nextHead,
};
mock.timers.enable({ apis: ['Date'], now });
try {
  configureWorkspaceContinuity(coldCurrent, originals[1], context, {
    ...originals[1].reviewWorkspaceSubject,
    baseSha: packet.base,
  });
} finally {
  mock.timers.reset();
}
assert.equal(context.mode, 'cold');
assert(context.session?.fallback);
assert.match(context.session.fallback.detail, /expired/);
const removed = await cleanupExpiredReviewWorkspaces(now + 300001);
assert.deepEqual(new Set(removed), new Set(snapshot.map((row) => row.workspace)));
assert(snapshot.every((row) => !fs.existsSync(row.workspace)));
assert.equal(fs.existsSync(session), false);
for (const [index, row] of snapshot.entries()) {
  assert(getRun(row.id));
  assert.deepEqual(getRun(row.id).reviewResult, row.result);
  assert.equal(hash(row.report), hashes[index]);
  assert(fs.existsSync(path.join(root, 'runs', row.id + '.json')));
}
const result = {
  pass: true,
  root,
  pendingProtected: true,
  pendingRun: pending.id,
  removed,
  sessionRemoved: !fs.existsSync(session),
  runRecordsPreserved: true,
  reportsUnchanged: true,
  expiryFallback: context.session.fallback,
  runCount: getAllRuns().length,
};
fs.writeFileSync(
  path.join(path.dirname(process.argv[2]), 'retention.json'),
  JSON.stringify(result, null, 2),
);
console.log(JSON.stringify(result, null, 2));
const { makeOwnerWritable } = await load('services/gateway/src/core/owned-copy.ts');
await makeOwnerWritable(root);
fs.rmSync(root, { recursive: true });
assert(!fs.existsSync(root));
process.exit(0);
