import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import fsPromises, {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';

import {
  type AgentContext,
  type ReviewWorkspaceBinding,
  type Run,
  type RunArtifactBundleRef,
  type RunDecision,
  type RunReviewResult,
} from '@farmslot/protocol';
import { resolveFarmPaths } from '@farmslot/protocol/node/farm-paths';
import { DEFAULT_RUN_RETENTION_DAYS } from '@farmslot/run-bundle';

import { runBundleHome } from '../../run-completion/retained-artifacts.js';
import { findLatestPriorReviewRun } from '../../run-engine/engine-decisions.js';
import {
  DAY_MS,
  planRunRetention,
  type RunPrState,
  type RunRetentionContext,
  runRetentionHold,
  type RunRetentionRoots,
} from '../../runs/retention.js';
import { stageStoragePaths, storageArchiveManifest } from '../../runs/storage-archive.js';
import {
  archiveRun,
  createRun,
  getRunWithArchived,
  persistRunNow,
  runsDirectory,
  runSessionArchiveDir,
  updateRun,
  withTaskAdmission,
} from '../../runs/store.js';
import {
  type PrincipalOwner,
  runPrincipalOwner,
  samePrincipalOwner,
} from '../../security/work-originator.js';

import {
  formatRunRetention,
  retentionContext,
  RUN_RETENTION_DEPS,
  runRetentionPass,
} from './retention.js';
import { makeRun } from './test-fixtures.js';

const NOW = Date.parse('2026-10-20T12:00:00.000Z');
const RUN_RETENTION_AGE_MS = DEFAULT_RUN_RETENTION_DAYS * DAY_MS;
const settled = new Date(NOW - RUN_RETENTION_AGE_MS - 60_000).toISOString();
const context = (
  pr: RunPrState = 'none',
  warmReviewSource = false,
  activeSource?: string,
): RunRetentionContext => ({
  now: NOW,
  ageMs: RUN_RETENTION_AGE_MS,
  prState: () => pr,
  warmReviewSource: () => warmReviewSource,
  activeSource: () => activeSource,
});

const openDecision: RunDecision = {
  id: 'decision-1',
  type: 'engine_human_gate',
  title: 'Approve publication',
  description: 'Gate',
  actions: [],
  createdAt: settled,
};

function nativeContext(runId: string, stateDirectory: string, node = 'local'): AgentContext {
  return {
    id: 'fix-bug',
    role: 'fix-bug',
    label: 'Fix',
    status: 'complete',
    slotId: null,
    runId,
    nativeSession: {
      sessionId: path.basename(stateDirectory),
      executionNodeId: node,
      ownerPrincipalId: 'owner',
      leaseId: 'lease',
      commandId: 'command',
      stateDirectory,
      releasedAt: settled,
    },
  };
}

function workspace(dir: string, executionNodeId = 'local'): ReviewWorkspaceBinding {
  return {
    workspaceId: path.basename(dir),
    machine: executionNodeId === 'local' ? 'macwork' : executionNodeId,
    executionNodeId,
    checkoutPath: path.join(dir, 'source'),
    taskPath: path.join(dir, 'task'),
    artifactPath: path.join(dir, 'task', 'artifacts'),
    cleanedAt: settled,
  };
}

const bundle = (bundleDigest: string): RunArtifactBundleRef => ({
  storeId: 'store-1',
  bundleDigest,
  taskKey: 'run',
  manifestDigest: 'manifest',
});

async function file(target: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, 'x'.repeat(4096));
}

async function retentionRoots(t: test.TestContext, runsDir?: string): Promise<RunRetentionRoots> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'farmslot-retention-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const archiveRoot = path.join(tmp, 'archive-root');
  await mkdir(archiveRoot);
  return {
    archiveRoot,
    runsDir: runsDir ?? path.join(tmp, 'runs'),
    sessionArchive: runsDir
      ? runSessionArchiveDir
      : (id) => path.join(tmp, 'runs', 'session-archives', id),
    taskRoots: [path.join(tmp, 'tasks')],
    taskPins: path.join(tmp, 'pins'),
    nativeSessions: path.join(tmp, 'native'),
    reviewWorkspaces: path.join(tmp, 'review-workspaces'),
    bundles: { id: 'store-1', root: path.join(tmp, 'bundles') },
  };
}

/** A pin for `taskDir` whose provenance was written at `writtenAt`. */
async function pin(roots: RunRetentionRoots, name: string, taskDir: string, writtenAt: number) {
  const provenance = path.join(roots.taskPins, name, 'provenance.json');
  await mkdir(path.dirname(provenance), { recursive: true });
  await writeFile(provenance, JSON.stringify({ taskDir, receipt: {} }));
  const at = new Date(writtenAt);
  await utimes(provenance, at, at);
  return path.dirname(provenance);
}

test('retention archives settled run storage only after 7 days with nothing open', () => {
  const done: Run = { ...makeRun({ status: 'done' }), updatedAt: settled };
  assert.equal(runRetentionHold(done, context()), undefined);
  assert.equal(runRetentionHold({ ...done, status: 'cancelled' }, context()), undefined);
  assert.equal(
    runRetentionHold({ ...done, status: 'failed', archivedAt: settled }, context()),
    undefined,
  );
  for (const status of ['monitoring', 'human-gating', 'blocked', 'failed'] as const)
    assert.equal(
      runRetentionHold({ ...done, status }, context()),
      'not done, cancelled or archived',
    );
  const recent = new Date(NOW - RUN_RETENTION_AGE_MS + 60_000).toISOString();
  assert.equal(
    runRetentionHold({ ...done, completedAt: recent }, context()),
    'settled less than 7 days ago',
  );
  // Bookkeeping that touches a long-completed run does not restart its 7 days.
  assert.equal(
    runRetentionHold({ ...done, completedAt: settled, updatedAt: recent }, context()),
    undefined,
  );
  assert.equal(
    runRetentionHold({ ...done, decisions: [openDecision] }, context()),
    'still needs its execution storage',
  );
  // Archiving is a reversible move, so only the keep tag holds a run's storage in place.
  assert.equal(runRetentionHold({ ...done, tags: ['demo', 'unsteered'] }, context()), undefined);
  assert.equal(runRetentionHold({ ...done, tags: ['perps', 'keep'] }, context()), 'tagged keep');
  // Past the age, an open or unknown PR keeps only a warm review source.
  assert.equal(runRetentionHold(done, context('open')), undefined);
  assert.equal(runRetentionHold(done, context('unknown')), undefined);
  assert.equal(runRetentionHold(done, context('open', true)), 'warm review source of an open PR');
  assert.equal(
    runRetentionHold(done, context('unknown', true)),
    'warm review source of a PR in unknown state',
  );
  assert.equal(runRetentionHold(done, context('settled', true)), undefined);
  assert.equal(
    runRetentionHold(done, context('none', false, 'inherited by an unsettled follow-up')),
    'inherited by an unsettled follow-up',
  );
  assert.equal(
    runRetentionHold(
      { ...done, completedAt: new Date(NOW - 60_000).toISOString() },
      { ...context(), ageMs: DAY_MS },
    ),
    'settled less than 1 day ago',
  );
});

const reviewed: RunReviewResult = {
  recommendation: 'approve',
  reviewMd: 'review.md',
  lineComments: [],
};
const ago = (days: number) => new Date(NOW - days * DAY_MS).toISOString();

function reviewerContext(runId: string, reviewId: string): AgentContext {
  return {
    id: `review-${reviewId}`,
    role: 'review',
    label: 'Review',
    status: 'complete',
    slotId: null,
    runId,
    reviewId,
  };
}

/** A settled review-pr run on `pr`, `days` after it completed. */
const reviewRun = (id: string, pr: string, days: number, overrides: Partial<Run> = {}): Run => ({
  ...makeRun({
    id,
    familyId: id,
    status: 'done',
    flowType: 'review-pr',
    project: 'p',
    ticketOrPr: pr,
  }),
  completedAt: ago(days),
  ...overrides,
});

/** A settled intake review round on o/r#7 owned by `ownerId`. */
const intakeRun = (id: string, ownerId: string, days: number): Run =>
  reviewRun(id, 'o/r#7', days, {
    reviewResult: reviewed,
    prWork: {
      kind: 'review',
      id: `review:${id}`,
      sourceId: id,
      pr: { host: 'github.com', repo: 'o/r', number: 7 },
      headSha: 'bbbbbbbbbbbbbbbb',
      review: { profile: 'standard', ownerId, options: { mode: 'cold' } },
    },
  });

async function holdsFor(runs: Run[], retentionDays = DEFAULT_RUN_RETENTION_DAYS) {
  const context = await retentionContext(runs, NOW, {
    retentionDays: () => retentionDays,
    projectRepo: async () => 'o/r',
    openPrs: async (repo) => {
      if (repo === 'o/down') throw new Error('rate limited');
      return [1, 2, 3, 4, 7];
    },
  });
  return Object.fromEntries(runs.map((run) => [run.id, runRetentionHold(run, context)]));
}

test('the age comes from runRetentionDays', async () => {
  const runs = [6, 8, 4].map((days) => ({
    ...makeRun({
      id: `${days}-days`,
      familyId: `${days}`,
      status: 'done',
      ticketOrPr: `PROJ-${days}`,
    }),
    completedAt: ago(days),
  }));
  assert.deepEqual(await holdsFor(runs), {
    '6-days': 'settled less than 7 days ago',
    '8-days': undefined,
    '4-days': 'settled less than 7 days ago',
  });
  assert.deepEqual(await holdsFor(runs, 3), {
    '6-days': undefined,
    '8-days': undefined,
    '4-days': undefined,
  });
  assert.equal((await holdsFor(runs, 7.5))['6-days'], 'settled less than 7.5 days ago');
});

test('an open PR holds exactly the runs its warm review chains continue from', async () => {
  const runs = [
    // A: an older review archived after the newer one does not displace it.
    reviewRun('a-old', 'o/r#1', 20, { archivedAt: ago(8), reviewResult: reviewed }),
    reviewRun('a-new', 'o/r#1', 10, { reviewResult: reviewed }),
    // A review still running does not displace the settled review either.
    reviewRun('a-running', 'o/r#1', 1, { status: 'monitoring' }),
    // B: a cancelled re-review without a result is not a warm predecessor.
    reviewRun('b-reviewed', 'o/r#2', 10, { reviewResult: reviewed }),
    reviewRun('b-cancelled', 'o/r#2', 9, { status: 'cancelled' }),
    // C: a failed review archived later by cleanup is not one either.
    reviewRun('c-reviewed', 'o/r#3', 10, { reviewResult: reviewed }),
    reviewRun('c-failed', 'o/r#3', 12, { status: 'failed', archivedAt: ago(9) }),
    // Two lineages on one PR each keep their own predecessor.
    reviewRun('codex-older', 'o/r#4', 30, {
      reviewResult: reviewed,
      agentContexts: [reviewerContext('codex-older', 'codex')],
    }),
    reviewRun('codex', 'o/r#4', 20, {
      reviewResult: reviewed,
      agentContexts: [reviewerContext('codex', 'codex')],
    }),
    reviewRun('claude', 'o/r#4', 10, {
      reviewResult: reviewed,
      agentContexts: [reviewerContext('claude', 'claude')],
    }),
    // Intake rounds chain per owner and profile, so each owner keeps its own predecessor.
    intakeRun('owner-a-older', 'a', 30),
    intakeRun('owner-a', 'a', 20),
    intakeRun('owner-b', 'b', 10),
    // An unknown PR state holds only the chain's predecessor.
    reviewRun('down-old', 'o/down#5', 20, { reviewResult: reviewed }),
    reviewRun('down-new', 'o/down#5', 10, { reviewResult: reviewed }),
    // A closed PR releases its predecessor after the age.
    reviewRun('closed', 'o/r#6', 10, { reviewResult: reviewed }),
    // A non-review run on an open PR follows the age rule.
    {
      ...makeRun({
        id: 'dev',
        familyId: 'dev',
        status: 'done',
        flowType: 'pr-complete',
        ticketOrPr: 'o/r#1',
      }),
      completedAt: ago(10),
    },
  ];
  assert.deepEqual(await holdsFor(runs), {
    'a-old': undefined,
    'a-new': 'warm review source of an open PR',
    'a-running': 'not done, cancelled or archived',
    'b-reviewed': 'warm review source of an open PR',
    'b-cancelled': undefined,
    'c-reviewed': 'warm review source of an open PR',
    'c-failed': undefined,
    'codex-older': undefined,
    codex: 'warm review source of an open PR',
    claude: 'warm review source of an open PR',
    'down-old': undefined,
    'down-new': 'warm review source of a PR in unknown state',
    'owner-a-older': undefined,
    'owner-a': 'warm review source of an open PR',
    'owner-b': 'warm review source of an open PR',
    closed: undefined,
    dev: undefined,
  });
  // The held runs are the ones the warm review lookup itself returns.
  const next = (pr: string, reviewId?: string) =>
    findLatestPriorReviewRun(
      {
        ...makeRun({ id: 'next', flowType: 'review-pr', project: 'p', ticketOrPr: pr }),
        reviewContext: { reviewLineages: reviewId ? [{ reviewId }] : [] },
      },
      runs,
    )?.id;
  assert.deepEqual(
    [next('o/r#1'), next('o/r#2'), next('o/r#3'), next('o/r#4', 'codex'), next('o/r#4', 'claude')],
    ['a-new', 'b-reviewed', 'c-reviewed', 'codex', 'claude'],
  );
});

test('an unsettled follow-up keeps the family it inherits from', async () => {
  const parent: Run = {
    ...makeRun({
      id: 'parent',
      familyId: 'parent',
      status: 'done',
      flowType: 'fix-bug',
      ticketOrPr: 'PROJ-1',
    }),
    completedAt: ago(20),
  };
  const child: Run = makeRun({
    id: 'child',
    familyId: 'parent',
    parentRunId: 'parent',
    status: 'monitoring',
    flowType: 'pr-complete',
    ticketOrPr: 'PROJ-1',
  });
  const other: Run = { ...parent, id: 'other', familyId: 'other' };
  assert.deepEqual(await holdsFor([parent, child, other]), {
    parent: 'inherited by an unsettled follow-up',
    child: 'not done, cancelled or archived',
    other: undefined,
  });
  const settledChild = { ...child, status: 'done' as const, completedAt: ago(8) };
  assert.equal((await holdsFor([parent, settledChild, other])).parent, undefined);
});

/** A review intake's PR work: `ownerId` reviews o/r#`number` under `profile`. */
const intakeWork = (ownerId: string, profile: string, number: number): Run['prWork'] => ({
  kind: 'review',
  id: `review:${ownerId}:${profile}`,
  sourceId: ownerId,
  pr: { host: 'github.com', repo: 'o/r', number },
  headSha: 'bbbbbbbbbbbbbbbb',
  review: { profile, ownerId, options: { mode: 'cold' } },
});

/** A native reviewer context in lineage `reviewId`, run by `runner` and owned by `owner`. */
function nativeReviewer(
  runId: string,
  reviewId: string,
  runner = 'codex',
  owner = 'fa',
): AgentContext {
  return {
    ...reviewerContext(runId, reviewId),
    id: `review-${reviewId}-${runner}-${owner}`,
    runner,
    nativeSession: {
      sessionId: `${runId}-${reviewId}`,
      executionNodeId: 'local',
      ownerPrincipalId: owner,
      leaseId: 'lease',
      commandId: 'command',
      stateDirectory: `/native/${runId}`,
      releasedAt: settled,
    },
  };
}

/** The warm-review request a reader would build. */
const nextReview = (pr: string, prWork?: Run['prWork'], reviewId?: string): Run => ({
  ...makeRun({ id: 'next', flowType: 'review-pr', project: 'p', ticketOrPr: pr }),
  prWork,
  reviewContext: { reviewLineages: reviewId ? [{ reviewId }] : [] },
});

const sameOwnerAs = (owner: PrincipalOwner | undefined) => (run: Run) => {
  const candidate = runPrincipalOwner(run);
  return !!owner && !!candidate && samePrincipalOwner(owner, candidate);
};

test('readers that narrow by owner or fall back to a manual run keep their predecessor', async () => {
  const runs = [
    // The workspace pipeline and PR-rule continuity only continue from the same owner's runs.
    reviewRun('fa-review', 'o/r#1', 20, { reviewResult: reviewed, createdByPrincipalId: 'fa' }),
    reviewRun('legacy-review', 'o/r#1', 10, {
      reviewResult: reviewed,
      createdByPrincipalId: 'legacy',
    }),
    // A first intake round of a new owner or profile falls back to the latest manual run.
    reviewRun('manual', 'o/r#2', 20, { reviewResult: reviewed }),
    reviewRun('intake-a', 'o/r#2', 10, {
      reviewResult: reviewed,
      prWork: intakeWork('a', 'standard', 2),
    }),
    // The same holds inside one lineage.
    reviewRun('manual-codex', 'o/r#3', 20, {
      reviewResult: reviewed,
      agentContexts: [reviewerContext('manual-codex', 'codex')],
    }),
    reviewRun('intake-codex', 'o/r#3', 10, {
      reviewResult: reviewed,
      prWork: intakeWork('a', 'standard', 3),
      agentContexts: [reviewerContext('intake-codex', 'codex')],
    }),
  ];
  const holds = await holdsFor(runs);
  const pipeline = (owner: string) =>
    findLatestPriorReviewRun(nextReview('o/r#1'), runs.filter(sameOwnerAs({ ownerId: owner })))?.id;
  assert.deepEqual(
    [
      pipeline('fa'),
      pipeline('legacy'),
      findLatestPriorReviewRun(nextReview('o/r#2', intakeWork('b', 'standard', 2)), runs)?.id,
      findLatestPriorReviewRun(nextReview('o/r#2', intakeWork('a', 'deep', 2)), runs)?.id,
      findLatestPriorReviewRun(nextReview('o/r#3', intakeWork('a', 'deep', 3), 'codex'), runs)?.id,
    ],
    ['fa-review', 'legacy-review', 'manual', 'manual', 'manual-codex'],
  );
  for (const run of runs) assert.equal(holds[run.id], 'warm review source of an open PR', run.id);
});

/** Deterministic PRNG, so every failing history can be replayed from its seed. */
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

test('every warm review reader selects a run that retention holds (seeded histories)', async () => {
  const owners = ['fa', 'legacy'];
  const lineages = ['codex', 'claude'];
  const runners = ['codex', 'claude'];
  const intakes = [
    ['a', 'standard'],
    ['a', 'deep'],
    ['b', 'standard'],
  ] as const;
  let checked = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const random = mulberry32(seed);
    const pick = <T>(values: readonly T[]) => values[Math.floor(random() * values.length)];
    const runs: Run[] = [];
    for (let index = 0, count = 2 + Math.floor(random() * 8); index < count; index++) {
      const id = `s${seed}-r${index}`;
      const days = 8 + random() * 30;
      const intake = random() < 0.4 ? pick(intakes) : undefined;
      runs.push(
        reviewRun(id, 'o/r#1', days, {
          status: pick(['done', 'done', 'done', 'cancelled', 'failed', 'blocked'] as const),
          ...(random() < 0.75 ? { reviewResult: reviewed } : {}),
          ...(random() < 0.3 ? { archivedAt: ago(8 + random() * (days - 8)) } : {}),
          ...(random() < 0.7 ? { createdByPrincipalId: pick(owners) } : {}),
          ...(intake ? { prWork: intakeWork(intake[0], intake[1], 1) } : {}),
          agentContexts: Array.from({ length: Math.floor(random() * 3) }, () =>
            nativeReviewer(id, pick(lineages), pick(runners), pick(owners)),
          ),
        }),
      );
    }
    const context = await retentionContext(runs, NOW, {
      retentionDays: () => DEFAULT_RUN_RETENTION_DAYS,
      projectRepo: async () => 'o/r',
      openPrs: async () => [1],
    });
    const expectHeld = (reader: string, selected: Run | null) => {
      if (!selected) return;
      checked++;
      assert.ok(
        runRetentionHold(selected, context),
        `seed ${seed}: ${reader} continues from ${selected.id}, which retention releases`,
      );
    };
    for (const reviewId of [undefined, ...lineages, 'unseen'])
      for (const intake of [undefined, ...intakes, ['z', 'unseen'] as const]) {
        const request = nextReview(
          'o/r#1',
          intake && intakeWork(intake[0], intake[1], 1),
          reviewId,
        );
        expectHeld('unfiltered', findLatestPriorReviewRun(request, runs));
        for (const owner of owners)
          expectHeld(
            `pipeline(${owner})`,
            findLatestPriorReviewRun(request, runs.filter(sameOwnerAs({ ownerId: owner }))),
          );
        if (intake)
          expectHeld(
            `continuity(${intake[0]})`,
            findLatestPriorReviewRun(request, runs.filter(sameOwnerAs({ ownerId: intake[0] }))),
          );
      }
    for (const reviewId of lineages)
      for (const runner of runners)
        for (const owner of owners)
          expectHeld(
            `session(${reviewId}, ${runner}, ${owner})`,
            findLatestPriorReviewRun(
              nextReview('o/r#1', undefined, reviewId),
              runs.filter((run) =>
                run.agentContexts?.some(
                  (agent) =>
                    agent.reviewId === reviewId &&
                    agent.runner === runner &&
                    agent.nativeSession?.ownerPrincipalId === owner,
                ),
              ),
            ),
          );
  }
  assert.ok(checked > 1000, `only ${checked} selections were checked`);
});

test('an in-flight review keeps the prior it recorded', async () => {
  const prior = (id: string) => reviewRun(id, 'o/r#9', 20);
  const inFlight: Run = {
    ...reviewRun('in-flight', 'o/r#9', 1, { status: 'monitoring' }),
    repeatReviewContext: {
      version: 1,
      chainId: 'chain',
      generation: 2,
      priorRunId: 'recorded-prior',
      priorFamilyId: 'recorded-prior',
      repository: 'o/r',
      prNumber: 9,
      currentHeadSha: 'cccccccccccccccc',
      verdict: 'request changes',
      unresolvedFindings: [],
      artifactRefs: [],
      farmslotEvidenceRefs: [],
      mode: 'warm',
      validationDepth: 'static-code',
      session: { mode: 'warm', continuity: 'resumed', priorRunId: 'session-prior' },
    },
  };
  const runs = [prior('recorded-prior'), prior('session-prior'), prior('unrelated'), inFlight];
  assert.deepEqual(await holdsFor(runs), {
    'recorded-prior': 'prior of an in-flight review',
    'session-prior': 'prior of an in-flight review',
    unrelated: undefined,
    'in-flight': 'not done, cancelled or archived',
  });
  const done = { ...inFlight, status: 'done' as const, completedAt: ago(8) };
  assert.equal((await holdsFor([prior('recorded-prior'), done]))['recorded-prior'], undefined);
});

test('a warm source fails closed when its PR resolves to no state, and a reopened PR counts as open', async () => {
  const runs = [
    // `repo#5` chains for warm review but names no GitHub repository.
    reviewRun('bare-ref', 'repo#5', 20, { reviewResult: reviewed }),
    // Recorded closed, but the live open list has it again.
    reviewRun('reopened', 'o/r#2', 20, { reviewResult: reviewed, prState: 'CLOSED' }),
    reviewRun('closed', 'o/r#6', 20, { reviewResult: reviewed, prState: 'CLOSED' }),
  ];
  assert.deepEqual(await holdsFor(runs), {
    'bare-ref': 'warm review source of a PR in unknown state',
    reopened: 'warm review source of an open PR',
    closed: undefined,
  });
});

test("the pass reads runRetentionDays from the gateway's run-bundle-retention.json", async (t) => {
  const config = path.join(
    resolveFarmPaths({ home: runBundleHome(), role: 'node' }).config,
    'run-bundle-retention.json',
  );
  assert.equal(existsSync(config), false, 'the test home has no settings file');
  assert.equal(RUN_RETENTION_DEPS.retentionDays(), DEFAULT_RUN_RETENTION_DAYS);
  await mkdir(path.dirname(config), { recursive: true });
  t.after(() => rm(config, { force: true }));
  await writeFile(config, JSON.stringify({ runBundleRetention: { runRetentionDays: 3 } }));
  assert.equal(RUN_RETENTION_DEPS.retentionDays(), 3);
});

test('a PR keeps its run unless its repository was read and the PR is not open', async () => {
  const run = (id: string, overrides: Partial<Run>): Run => ({ ...makeRun({ id }), ...overrides });
  const runs = [
    run('link-open', { links: [{ label: 'PR', url: 'https://github.com/o/r/pull/1' }] }),
    run('ticket-merged', { ticketOrPr: 'o/r#2' }),
    run('no-repo', { prNumber: 3, project: 'no-ci-repo', ticketOrPr: 'PROJ-3' }),
    run('full-page', { prNumber: 4, project: 'big', ticketOrPr: 'PROJ-4' }),
    run('unreadable', { links: [{ label: 'PR', url: 'https://github.com/o/down/pull/5' }] }),
    run('bad-link', { links: [{ label: 'PR', url: 'not a url' }], ticketOrPr: 'PROJ-6' }),
    run('recorded', { prNumber: 7, prState: 'MERGED', ticketOrPr: 'PROJ-7' }),
    run('no-pr', { ticketOrPr: 'PROJ-8' }),
    // An issue ticket resolves to a closed number, but the run's own PR is open.
    run('issue-and-pr', { ticketOrPr: 'o/r#20', prNumber: 1, project: 'repo' }),
  ];
  const reads: string[] = [];
  const { prState } = await retentionContext(runs, NOW, {
    retentionDays: () => DEFAULT_RUN_RETENTION_DAYS,
    projectRepo: async (project) => ({ big: 'o/big', repo: 'o/r' })[project],
    openPrs: async (repo) => {
      reads.push(repo);
      if (repo === 'o/down') throw new Error('rate limited');
      return repo === 'o/big' ? Array.from({ length: 1000 }, (_, i) => i + 10) : [1];
    },
  });
  assert.deepEqual(Object.fromEntries(runs.map((r) => [r.id, prState(r)])), {
    'link-open': 'open',
    'ticket-merged': 'settled',
    'no-repo': 'unknown',
    'full-page': 'unknown',
    unreadable: 'unknown',
    'bad-link': 'unknown',
    recorded: 'settled',
    'no-pr': 'none',
    'issue-and-pr': 'open',
  });
  assert.deepEqual(reads.sort(), ['o/big', 'o/down', 'o/r'], 'one read per repository');
});

test('a retention plan lists only storage that removable runs alone own on this node', async (t) => {
  const roots = await retentionRoots(t);
  const own = path.join(roots.taskRoots[0], 'feat', 'own');
  const shared = path.join(roots.taskRoots[0], 'feat', 'shared');
  const slotCopy = path.join(path.dirname(roots.taskPins), 'slot', 'temp', 'tasks', 'feat', 'own');
  const native = path.join(roots.nativeSessions, 'workers', 'owner', 'session-1');
  const remoteNative = path.join(roots.nativeSessions, 'workers', 'owner', 'session-remote');
  const localWorkspace = path.join(roots.reviewWorkspaces, 'owner', 'runs', 'w1');
  const workspaceNative = path.join(roots.nativeSessions, 'workers', 'owner', 'w1');
  const remoteWorkspace = path.join(roots.reviewWorkspaces, 'owner', 'runs', 'w2');
  const bundleRoot = roots.bundles!.root;
  for (const target of [
    path.join(own, 'TASK.md'),
    path.join(shared, 'TASK.md'),
    path.join(slotCopy, 'TASK.md'),
    path.join(native, 'state.json'),
    path.join(remoteNative, 'state.json'),
    path.join(workspaceNative, 'state.json'),
    path.join(localWorkspace, 'task', 'report.md'),
    path.join(remoteWorkspace, 'task', 'report.md'),
    path.join(bundleRoot, 'sha256', 'own', 'manifest.json'),
    path.join(bundleRoot, 'sha256', 'shared', 'manifest.json'),
  ])
    await file(target);
  const old = RUN_RETENTION_AGE_MS + 60_000;
  const retired = await pin(roots, 'retired', path.join(roots.taskRoots[0], 'gone'), NOW - old);
  await pin(roots, 'fresh', path.join(roots.taskRoots[0], 'gone'), NOW - 60_000);
  await pin(roots, 'in-use', slotCopy, NOW - old);

  const removable: Run = {
    ...makeRun({
      id: 'removable',
      status: 'done',
      taskFile: path.join(own, 'TASK.md'),
      activeTaskFile: path.join(slotCopy, 'TASK.md'),
      agentContexts: [nativeContext('removable', native)],
    }),
    updatedAt: settled,
    reviewWorkspace: workspace(localWorkspace),
    artifactBundle: bundle('own'),
  };
  // Another node's paths look identical to this node's; they are not this pass's to remove.
  const remote: Run = {
    ...makeRun({
      id: 'remote',
      status: 'done',
      taskFile: path.join(shared, 'TASK.md'),
      agentContexts: [nativeContext('remote', remoteNative, 'macpro')],
    }),
    updatedAt: settled,
    reviewWorkspace: workspace(remoteWorkspace, 'macpro'),
    artifactBundle: bundle('shared'),
  };
  const live: Run = {
    ...makeRun({ id: 'live', status: 'monitoring', taskFile: path.join(shared, 'TASK.md') }),
    artifactBundle: bundle('shared'),
  };
  const slotHolder: Run = {
    ...makeRun({ id: 'slot-holder', status: 'cancelled', slotId: 'slot-1' }),
    updatedAt: settled,
  };

  const { plan } = await planRunRetention(
    [removable, remote, live, slotHolder],
    context(),
    roots,
    async (run) => run.slotId === 'slot-1',
  );

  assert.deepEqual(plan.runs, ['removable', 'remote']);
  assert.deepEqual(plan.held, { 'not done, cancelled or archived': 1, 'holds its slot': 1 });
  assert.deepEqual(plan.paths['task-dirs'], [own], 'not the shared one or the slot copy');
  assert.deepEqual(plan.paths['review-workspaces'], [localWorkspace]);
  assert.deepEqual(plan.paths['native-sessions'].sort(), [native, workspaceNative].sort());
  assert.deepEqual(plan.paths['run-bundles'], [path.join(bundleRoot, 'sha256', 'own')]);
  assert.deepEqual(plan.paths['task-pins'], [retired]);
  assert.equal(plan.stores['task-dirs'].entries, 1);
  assert.ok(plan.stores['task-dirs'].bytes >= 4096);
});

const privateDeps = {
  ...RUN_RETENTION_DEPS,
  withBundleLock: async <T>(operation: () => Promise<T>) => operation(),
};

test('a settled untagged 7-day-old run keeps both live and archived records while all eligible storage moves', async (t) => {
  const roots = await retentionRoots(t, runsDirectory());
  const runIds: string[] = [];
  const originals: string[] = [];
  for (const archived of [false, true]) {
    const run = createRun({
      flowType: 'fix-bug',
      project: 'farmslot-farm',
      mode: 'autonomous',
      ticketOrPr: `RETENTION-${archived}`,
    });
    const task = path.join(roots.taskRoots[0], run.id);
    const native = path.join(roots.nativeSessions, 'workers', run.id);
    const review = path.join(roots.reviewWorkspaces, 'owner', 'runs', run.id);
    updateRun(run.id, {
      status: 'done',
      completedAt: settled,
      taskFile: path.join(task, 'TASK.md'),
      agentContexts: [nativeContext(run.id, native)],
      reviewWorkspace: workspace(review),
      artifactBundle: bundle(run.id),
    });
    await persistRunNow(run);
    if (archived) assert.equal(await archiveRun(run.id), true);
    const record = path.join(roots.runsDir, ...(archived ? ['archive'] : []), `${run.id}.json`);
    assert.ok(existsSync(record));
    originals.push(record);
    runIds.push(run.id);
    for (const directory of [
      task,
      native,
      review,
      roots.sessionArchive(run.id),
      path.join(roots.bundles!.root, 'sha256', run.id),
    ])
      await file(path.join(directory, 'bytes'));
    await symlink('bytes', path.join(task, 'linked'));
    await pin(roots, run.id, task, NOW - RUN_RETENTION_AGE_MS - 60000);
  }
  const passNow = Date.now() + RUN_RETENTION_AGE_MS + 60000;
  const events: string[] = [];
  const plan = await runRetentionPass({ apply: false, roots, now: passNow }, privateDeps);
  assert.equal('run-records' in plan.stores, false);
  assert.equal('run-records' in plan.paths, false);
  const result = await runRetentionPass(
    { apply: true, roots, now: passNow, emit: (event) => events.push(event) },
    privateDeps,
  );
  assert.deepEqual(new Set(result.runs), new Set(runIds));
  assert.deepEqual(events, [], 'storage archival does not announce run deletion');
  for (const [index, id] of runIds.entries()) {
    assert.ok(
      existsSync(originals[index]),
      'history record stays in exactly its original location',
    );
    const record = JSON.parse(await readFile(originals[index], 'utf8'));
    assert.equal(record.id, id);
    const manifestFile = path.join(roots.archiveRoot, id, 'manifest.json');
    assert.ok(
      record.links.some(
        (link: { url: string }) => link.url === new URL(`file://${manifestFile}`).href,
      ),
    );
    assert.ok(await getRunWithArchived(id));
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    assert.ok(manifest.entries.length >= 5);
    for (const entry of manifest.entries) {
      assert.equal(existsSync(entry.source), false);
      if (entry.store === 'task-pins' || entry.store === 'review-workspaces') {
        assert.equal(entry.state, 'deleted');
        assert.equal('destination' in entry, false);
        assert.equal('staged' in entry, false);
        assert.ok(entry.bytes > 0);
        assert.ok(entry.deletedAt);
        continue;
      }
      assert.ok(existsSync(entry.destination));
      assert.ok(entry.destination.endsWith(entry.source));
      if (entry.store !== 'task-pins')
        assert.equal(
          await readFile(path.join(entry.destination, 'bytes'), 'utf8'),
          'x'.repeat(4096),
        );
      assert.ok(entry.completedAt);
    }
  }
  const after = await runRetentionPass({ apply: true, roots, now: passNow }, privateDeps);
  assert.deepEqual(after.runs, [], 'a repeat pass never destroys or duplicates archived storage');
  assert.equal(after.stores['task-dirs'].entries, 0);
  for (const record of originals) assert.ok(existsSync(record));
});

test(
  'a restarted pass finishes pending archives before staging another run stalls',
  { timeout: 4500 },
  async (t) => {
    const roots = await retentionRoots(t, runsDirectory());
    const source = path.join(roots.taskRoots[0], 'interrupted');
    await file(path.join(source, 'bytes'));
    const bytes = await readFile(path.join(source, 'bytes'));
    await stageStoragePaths(roots.archiveRoot, 'interrupted', [{ source, store: 'task-dirs' }]);
    const manifestFile = storageArchiveManifest(roots.archiveRoot, 'interrupted');
    const readEntry = async () => JSON.parse(await readFile(manifestFile, 'utf8')).entries[0];
    const staged = await readEntry();
    assert.equal(staged.state, 'staged');
    assert.ok(existsSync(staged.staged));
    assert.equal(existsSync(staged.destination), false);

    const run = createRun({
      flowType: 'fix-bug',
      project: 'farmslot-farm',
      mode: 'autonomous',
      ticketOrPr: 'RETENTION-RESTART',
    });
    const task = path.join(roots.taskRoots[0], run.id);
    updateRun(run.id, {
      status: 'done',
      completedAt: settled,
      taskFile: path.join(task, 'TASK.md'),
    });
    await persistRunNow(run);
    await file(path.join(task, 'TASK.md'));

    let release = () => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    let blocked = false;
    let finished = false;
    const pass = runRetentionPass(
      { apply: true, roots, now: Date.now() + RUN_RETENTION_AGE_MS + 60000 },
      {
        ...privateDeps,
        holdsSlot: async (candidate) => {
          // The first check plans this run; the second is inside its staging turn.
          if (candidate.id === run.id && ++calls === 2) {
            blocked = true;
            await hold;
          }
          return false;
        },
      },
    ).finally(() => {
      finished = true;
    });
    try {
      const deadline = Date.now() + 500;
      let entry = await readEntry();
      while ((!blocked || entry.state !== 'archived') && Date.now() < deadline) {
        await setTimeout(10);
        entry = await readEntry();
      }
      assert.equal(blocked, true, 'the new pass is stuck in another candidate staging turn');
      assert.equal(finished, false);
      assert.equal(entry.state, 'archived');
      assert.deepEqual(await readFile(path.join(entry.destination, 'bytes')), bytes);
      assert.equal(existsSync(entry.staged), false);
    } finally {
      release();
      await pass;
    }
  },
);

test('missing and unwritable archive roots fail before touching run records or storage', async (t) => {
  const roots = await retentionRoots(t, runsDirectory());
  const run = createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    mode: 'autonomous',
    ticketOrPr: 'RETENTION-ROOT',
  });
  const task = path.join(roots.taskRoots[0], run.id);
  updateRun(run.id, { status: 'done', completedAt: settled, taskFile: path.join(task, 'TASK.md') });
  await persistRunNow(run);
  await file(path.join(task, 'bytes'));
  const record = path.join(roots.runsDir, `${run.id}.json`);
  const before = await readFile(record, 'utf8');
  await assert.rejects(
    runRetentionPass(
      {
        apply: true,
        roots: { ...roots, archiveRoot: path.join(roots.archiveRoot, 'missing') },
        now: NOW,
      },
      privateDeps,
    ),
    /ENOENT/,
  );
  const { chmod } = await import('node:fs/promises');
  await chmod(roots.archiveRoot, 0o500);
  try {
    await assert.rejects(
      runRetentionPass({ apply: true, roots, now: NOW }, privateDeps),
      /cannot write/,
    );
  } finally {
    await chmod(roots.archiveRoot, 0o700);
  }
  assert.equal(await readFile(record, 'utf8'), before);
  assert.equal(await readFile(path.join(task, 'bytes'), 'utf8'), 'x'.repeat(4096));
});

test('a follow-up dispatched during a pass keeps its parent from being staged', async (t) => {
  const roots = await retentionRoots(t, runsDirectory());
  const parent = createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    mode: 'autonomous',
    ticketOrPr: 'RETENTION-FOLLOW-UP',
  });
  const task = path.join(roots.taskRoots[0], parent.id);
  updateRun(parent.id, {
    status: 'done',
    completedAt: settled,
    taskFile: path.join(task, 'TASK.md'),
  });
  await persistRunNow(parent);
  await file(path.join(task, 'TASK.md'));
  let dispatched = false;
  const result = await runRetentionPass(
    { apply: true, roots, now: Date.now() + RUN_RETENTION_AGE_MS + 60_000 },
    {
      ...privateDeps,
      // The first lock turn comes after the pass computed its context.
      withBundleLock: async (operation) => {
        if (!dispatched) {
          dispatched = true;
          const child = createRun({
            flowType: 'pr-complete',
            project: 'farmslot-farm',
            mode: 'autonomous',
            ticketOrPr: 'RETENTION-FOLLOW-UP',
          });
          updateRun(child.id, { parentRunId: parent.id, familyId: parent.familyId });
        }
        return operation();
      },
    },
  );
  assert.ok(dispatched);
  assert.equal(result.runs.includes(parent.id), false, 'the parent is not archived');
  assert.ok(existsSync(path.join(task, 'TASK.md')), 'the follow-up can still inherit its task');
});

test('a processed run replayed before the next candidate keeps its shared task', async (t) => {
  const roots = await retentionRoots(t, runsDirectory());
  const task = path.join(roots.taskRoots[0], 'shared-replay');
  await file(path.join(task, 'TASK.md'));
  const make = () => {
    const run = createRun({
      flowType: 'fix-bug',
      project: 'farmslot-farm',
      mode: 'autonomous',
      ticketOrPr: 'RETENTION-REPLAY',
    });
    updateRun(run.id, {
      status: 'done',
      completedAt: settled,
      taskFile: path.join(task, 'TASK.md'),
    });
    return run;
  };
  const first = make(),
    second = make();
  await persistRunNow(first);
  await persistRunNow(second);
  await file(path.join(roots.sessionArchive(first.id), 'session.jsonl'));
  const calls = new Map<string, number>();
  await runRetentionPass(
    { apply: true, roots, now: Date.now() + RUN_RETENTION_AGE_MS + 60000 },
    {
      ...privateDeps,
      holdsSlot: async (run) => {
        const count = (calls.get(run.id) ?? 0) + 1;
        calls.set(run.id, count);
        if (run.id === second.id && count === 2) updateRun(first.id, { status: 'monitoring' });
        return false;
      },
    },
  );
  assert.equal((await getRunWithArchived(first.id))?.status, 'monitoring');
  assert.ok(
    existsSync(path.join(task, 'TASK.md')),
    'reactivated processed owners are still owners',
  );
});

test('the pass holds the bundle lock one run at a time, so a waiting admission goes between runs', async (t) => {
  const roots = await retentionRoots(t, runsDirectory());
  const ids: string[] = [];
  for (const ticketOrPr of ['RETENTION-TURN-A', 'RETENTION-TURN-B']) {
    const run = createRun({
      flowType: 'fix-bug',
      project: 'farmslot-farm',
      mode: 'autonomous',
      ticketOrPr,
    });
    const task = path.join(roots.taskRoots[0], run.id);
    updateRun(run.id, {
      status: 'done',
      completedAt: settled,
      taskFile: path.join(task, 'TASK.md'),
    });
    await persistRunNow(run);
    await file(path.join(task, 'TASK.md'));
    ids.push(run.id);
  }
  // A FIFO lock like the store's: each caller runs after every earlier holder releases.
  let tail: Promise<unknown> = Promise.resolve();
  let held = false;
  const withBundleLock = <T>(operation: () => Promise<T>): Promise<T> => {
    const turn = tail.then(async () => {
      held = true;
      try {
        return await operation();
      } finally {
        held = false;
      }
    });
    tail = turn.catch(() => {});
    return turn;
  };
  const order: string[] = [];
  let admission: Promise<void> | undefined;
  await runRetentionPass(
    { apply: true, roots, now: Date.now() + RUN_RETENTION_AGE_MS + 60000 },
    {
      ...privateDeps,
      withBundleLock,
      holdsSlot: async (run) => {
        // Other tests' settled runs may be candidates too; only this test's two are traced.
        if (held && ids.includes(run.id)) {
          order.push(run.id);
          admission ??= withBundleLock(async () => {
            order.push('admission');
          });
        }
        return false;
      },
    },
  );
  await admission;
  assert.equal(order[1], 'admission');
  assert.deepEqual([order[0], order[2]].sort(), [...ids].sort());
});

async function recreatableRun(t: test.TestContext) {
  const roots = await retentionRoots(t, runsDirectory());
  const run = createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    mode: 'autonomous',
    ticketOrPr: 'RETENTION-DELETE',
  });
  const task = path.join(roots.taskRoots[0], run.id);
  const review = path.join(roots.reviewWorkspaces, 'owner', 'runs', run.id);
  updateRun(run.id, {
    status: 'done',
    completedAt: settled,
    taskFile: path.join(task, 'TASK.md'),
    reviewWorkspace: workspace(review),
  });
  await persistRunNow(run);
  await file(path.join(task, 'TASK.md'));
  await file(path.join(review, 'source', 'copy'));
  const taskPin = await pin(roots, run.id, task, NOW - RUN_RETENTION_AGE_MS - 60_000);
  const options = { apply: true, roots, now: Date.now() + RUN_RETENTION_AGE_MS + 60_000 };
  const manifest = async () =>
    JSON.parse(await readFile(storageArchiveManifest(roots.archiveRoot, run.id), 'utf8'));
  return { roots, run, task, review, taskPin, options, manifest };
}

test(
  'settled retention deletes recreatable copies and journals them beside the archived task',
  { timeout: 4500 },
  async (t) => {
    const f = await recreatableRun(t);
    await runRetentionPass(f.options, privateDeps);
    assert.equal(existsSync(f.taskPin), false);
    assert.equal(existsSync(f.review), false);
    assert.equal(existsSync(f.task), false);
    const { entries } = await f.manifest();
    for (const [store, source] of [
      ['task-pins', f.taskPin],
      ['review-workspaces', f.review],
    ]) {
      const entry = entries.find((entry: { source: string }) => entry.source === source);
      assert.deepEqual(Object.keys(entry).sort(), [
        'bytes',
        'deletedAt',
        'detached',
        'plannedAt',
        'source',
        'state',
        'store',
      ]);
      // The source was moved to a sibling before its removal; that sibling is gone too.
      assert.equal(path.dirname(entry.detached), path.dirname(source));
      assert.equal(existsSync(entry.detached), false);
      assert.equal(entry.state, 'deleted');
      assert.equal(entry.store, store);
      assert.ok(entry.bytes > 0);
      assert.ok(Number.isFinite(Date.parse(entry.deletedAt)));
    }
    const archived = entries.filter((entry: { state: string }) => entry.state === 'archived');
    assert.deepEqual(
      archived.map((entry: { store: string }) => entry.store),
      ['task-dirs'],
    );
    assert.equal(
      await readFile(path.join(archived[0].destination, 'TASK.md'), 'utf8'),
      'x'.repeat(4096),
    );
  },
);

test(
  'recreatable pins survive admission, a retention hold and an active run',
  { timeout: 4500 },
  async (t) => {
    const f = await recreatableRun(t);
    await withTaskAdmission(path.join(f.task, 'TASK.md'), async () => {
      await runRetentionPass(f.options, privateDeps);
      assert.ok(existsSync(f.taskPin));
    });
    for (const patch of [{ tags: ['keep'] }, { tags: [], status: 'monitoring' as const }]) {
      updateRun(f.run.id, patch);
      await runRetentionPass(f.options, privateDeps);
      assert.ok(existsSync(f.taskPin));
    }
    const other = await recreatableRun(t);
    await rm(f.task, { recursive: true });
    const activePlan = await runRetentionPass({ ...f.options, apply: false }, privateDeps);
    assert.equal(activePlan.paths['task-pins'].includes(f.taskPin), false);
    // The other candidate scans this pin root while the active owner has no task directory.
    await runRetentionPass(
      { ...other.options, roots: { ...other.roots, taskPins: f.roots.taskPins } },
      privateDeps,
    );
    assert.ok(existsSync(f.taskPin));
    // An admission can also precede writing a missing task directory.
    updateRun(f.run.id, { status: 'done' });
    await withTaskAdmission(path.join(f.task, 'TASK.md'), async () => {
      await runRetentionPass(f.options, privateDeps);
      assert.ok(existsSync(f.taskPin));
    });
    await runRetentionPass(f.options, {
      ...privateDeps,
      holdsSlot: async (run) => run.id === f.run.id,
    });
    assert.ok(existsSync(f.taskPin));
    await runRetentionPass(f.options, privateDeps);
    assert.equal(existsSync(f.taskPin), false);
    assert.equal(
      (await f.manifest()).entries.find((entry: { source: string }) => entry.source === f.taskPin)
        .state,
      'deleted',
    );
  },
);

test(
  'deleting a run workspace leaves shared review caches and symlink targets untouched',
  { timeout: 4500 },
  async (t) => {
    const f = await recreatableRun(t);
    const caches = ['repositories', 'support'].map((name) =>
      path.join(f.roots.reviewWorkspaces, 'owner', name, 'bytes'),
    );
    for (const cache of caches) await file(cache);
    await symlink(path.dirname(caches[0]), path.join(f.review, 'external-cache'));
    const shared = createRun({
      flowType: 'fix-bug',
      project: 'farmslot-farm',
      mode: 'autonomous',
      ticketOrPr: 'RETENTION-SHARED-REVIEW',
    });
    updateRun(shared.id, { status: 'monitoring', reviewWorkspace: workspace(f.review) });
    await persistRunNow(shared);
    await runRetentionPass(f.options, privateDeps);
    assert.ok(existsSync(f.review), 'an active shared owner keeps its workspace');
    updateRun(shared.id, { reviewWorkspace: undefined });
    await runRetentionPass(f.options, privateDeps);
    for (const cache of caches) assert.equal(await readFile(cache, 'utf8'), 'x'.repeat(4096));
    const entry = (await f.manifest()).entries.find(
      (entry: { source: string }) => entry.source === f.review,
    );
    assert.equal(entry.state, 'deleted');
    assert.equal('destination' in entry, false);
    const escaped = await recreatableRun(t);
    const owner = path.join(escaped.roots.reviewWorkspaces, 'owner');
    const outside = path.join(path.dirname(escaped.roots.reviewWorkspaces), 'outside-review');
    await rename(owner, outside);
    await symlink(outside, owner);
    await runRetentionPass(escaped.options, privateDeps);
    assert.ok(
      existsSync(path.join(outside, 'runs', escaped.run.id, 'source', 'copy')),
      'a symlink parent cannot redirect deletion outside the store',
    );
    assert.equal(
      (await escaped.manifest()).entries.some(
        (entry: { state: string }) => entry.state === 'deleted',
      ),
      false,
    );
  },
);

test(
  'deleted manifests resume cleanly and dry runs distinguish deleted bytes from archived bytes',
  { timeout: 4500 },
  async (t) => {
    const f = await recreatableRun(t);
    await stageStoragePaths(f.roots.archiveRoot, f.run.id, [
      { source: f.taskPin, store: 'task-pins' },
    ]);
    await pin(f.roots, f.run.id, f.task, NOW - RUN_RETENTION_AGE_MS - 60_000);
    const plan = await runRetentionPass({ ...f.options, apply: false }, privateDeps);
    const formatted = formatRunRetention(plan);
    assert.match(formatted, /task-pins deleted/);
    assert.match(formatted, /review-workspaces deleted/);
    assert.match(formatted, /task-dirs archived/);
    assert.ok(plan.stores['task-pins'].bytes > 0);
    assert.ok(plan.stores['review-workspaces'].bytes > 0);
    assert.ok(existsSync(f.taskPin));
    await runRetentionPass(f.options, privateDeps);
    const before = await f.manifest();
    const oldPin = before.entries.find(
      (entry: { store: string; state: string }) =>
        entry.store === 'task-pins' && entry.state === 'archived',
    );
    assert.ok(existsSync(oldPin.destination), 'previously archived pins remain archived');
    const again = await runRetentionPass(f.options, privateDeps);
    assert.deepEqual(again.runs, []);
    assert.equal(again.stores['task-pins'].entries, 0);
    assert.equal(again.stores['review-workspaces'].entries, 0);
    assert.deepEqual(await f.manifest(), before);
  },
);

/** Stop after the durable intent, or after the first detached tree's rm but before the completion save. */
async function interruptedDeletion(
  t: test.TestContext,
  f: Awaited<ReturnType<typeof recreatableRun>>,
  phase: 'intent' | 'removed',
) {
  const manifestPath = storageArchiveManifest(f.roots.archiveRoot, f.run.id);
  const renameFile = fsPromises.rename;
  const remove = fsPromises.rm;
  const fault =
    phase === 'intent'
      ? t.mock.method(
          fsPromises,
          'rename',
          async (...args: Parameters<typeof fsPromises.rename>) => {
            await renameFile(...args);
            if (String(args[1]) === manifestPath) {
              const manifest = await f.manifest();
              if (manifest.entries.some((entry: { state: string }) => entry.state === 'deleting'))
                throw new Error('crash after deletion intent');
            }
          },
        )
      : t.mock.method(fsPromises, 'rm', async (...args: Parameters<typeof fsPromises.rm>) => {
          await remove(...args);
          if (String(args[0]).includes('.retention-')) throw new Error('crash after removal');
        });
  syncBuiltinESMExports();
  t.after(() => {
    fault.mock.restore();
    syncBuiltinESMExports();
  });
  try {
    await assert.rejects(
      stageStoragePaths(f.roots.archiveRoot, f.run.id, [], () => true, [
        {
          source: f.review,
          store: 'review-workspaces',
          root: f.roots.reviewWorkspaces,
          bytes: 4096,
        },
        { source: f.taskPin, store: 'task-pins', root: f.roots.taskPins, bytes: 4096 },
      ]),
      /crash after/,
    );
  } finally {
    fault.mock.restore();
    syncBuiltinESMExports();
  }
}

test(
  'a crash after deletion intent retries eligibility and completes the same entries',
  { timeout: 4500 },
  async (t) => {
    const f = await recreatableRun(t);
    await interruptedDeletion(t, f, 'intent');
    const intents = (await f.manifest()).entries;
    assert.equal(intents.length, 2);
    for (const entry of intents) {
      assert.equal(entry.state, 'deleting');
      assert.ok(Number.isFinite(Date.parse(entry.plannedAt)));
      assert.ok(existsSync(entry.source));
    }
    await runRetentionPass(f.options, privateDeps);
    const completed = await f.manifest();
    for (const intent of intents) {
      const entries = completed.entries.filter(
        (entry: { source: string }) => entry.source === intent.source,
      );
      assert.equal(entries.length, 1);
      assert.equal(entries[0].state, 'deleted');
      assert.equal(entries[0].plannedAt, intent.plannedAt);
      assert.equal(entries[0].recovered, undefined);
      assert.equal(existsSync(intent.source), false);
    }
    await runRetentionPass(f.options, privateDeps);
    assert.deepEqual(await f.manifest(), completed);
  },
);

test(
  'a deletion intent becomes kept when a hold, admission or shared owner now applies',
  { timeout: 4500 },
  async (t) => {
    for (const hold of ['tag', 'slot', 'admission', 'owner'] as const) {
      const f = await recreatableRun(t);
      await interruptedDeletion(t, f, 'intent');
      if (hold === 'tag') updateRun(f.run.id, { tags: ['keep'] });
      if (hold === 'owner') {
        const shared = createRun({
          flowType: 'fix-bug',
          project: 'farmslot-farm',
          mode: 'autonomous',
          ticketOrPr: 'RECOVERY-OWNER',
        });
        updateRun(shared.id, {
          status: 'monitoring',
          reviewWorkspace: workspace(f.review),
          taskFile: path.join(f.task, 'TASK.md'),
        });
        await persistRunNow(shared);
      }
      const deps =
        hold === 'slot'
          ? { ...privateDeps, holdsSlot: async (run: Run) => run.id === f.run.id }
          : privateDeps;
      const pass = async () => {
        await runRetentionPass(f.options, deps);
        const kept = await f.manifest();
        await runRetentionPass(f.options, deps);
        assert.deepEqual(await f.manifest(), kept, 'kept entries are stable on repeat passes');
      };
      if (hold === 'admission') await withTaskAdmission(path.join(f.task, 'TASK.md'), pass);
      else await pass();
      const entries = (await f.manifest()).entries.filter(
        (entry: { source: string }) =>
          entry.source === (hold === 'admission' ? f.taskPin : f.review),
      );
      assert.equal(entries.length, 1);
      assert.equal(entries[0].state, 'kept', hold);
      assert.match(entries[0].reason, /keep|slot|ownership|admission/);
      assert.ok(existsSync(entries[0].source));
      const manifest = await f.manifest();
      assert.equal(
        manifest.entries.some((entry: { state: string }) => entry.state === 'deleting'),
        false,
      );
      for (const source of [f.review, f.taskPin]) {
        assert.equal(
          manifest.entries.filter((entry: { source: string }) => entry.source === source).length,
          1,
        );
      }
    }
  },
);

test(
  'a crash after rm recovers a missing source as deleted without duplicate entries',
  { timeout: 4500 },
  async (t) => {
    const f = await recreatableRun(t);
    await interruptedDeletion(t, f, 'removed');
    const intents = (await f.manifest()).entries;
    assert.equal(intents.length, 2);
    assert.ok(intents.every((entry: { state: string }) => entry.state === 'deleting'));
    // Both sources were detached before any removal; the crash came after the first one's rm.
    assert.equal(existsSync(f.review), false);
    assert.equal(existsSync(f.taskPin), false);
    const detached = (source: string) =>
      intents.find((entry: { source: string }) => entry.source === source).detached;
    assert.equal(existsSync(detached(f.review)), false);
    assert.ok(existsSync(detached(f.taskPin)));
    const recoveryStarted = Date.now();
    await runRetentionPass(f.options, privateDeps);
    const completed = await f.manifest();
    const entries = completed.entries.filter(
      (entry: { source: string }) => entry.source === f.review,
    );
    assert.equal(entries.length, 1);
    assert.equal(entries[0].state, 'deleted');
    assert.equal(entries[0].recovered, true);
    assert.ok(Date.parse(entries[0].deletedAt) >= recoveryStarted);
    assert.equal(entries[0].plannedAt, intents[0].plannedAt);
    const pins = completed.entries.filter(
      (entry: { source: string }) => entry.source === f.taskPin,
    );
    assert.equal(pins.length, 1);
    assert.equal(pins[0].state, 'deleted');
    assert.equal(existsSync(detached(f.taskPin)), false);
    await runRetentionPass(f.options, privateDeps);
    assert.deepEqual(await f.manifest(), completed);
  },
);
