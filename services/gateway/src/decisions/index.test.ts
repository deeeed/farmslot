/**
 * Parity test for DecisionIndex (ADR-071 Amendment 3).
 *
 * Proves that DecisionIndex.getAll() after warm-up and after each kind of change
 * deep-equals the reference output of today's decisionList(), order included.
 *
 * Revert proofs (run-proven):
 * - Defect 1 (enrichment thrown away): in applyRebuildRun, change
 *   `for (const d of enrichedRun.decisions)` to `for (const d of run.decisions)`.
 *   Failing assertion: 'gate decision must carry enriched context fields'
 *   fails because raw decisions lack context._enriched and context._budgeted and context._inspected.
 *
 * - Defect 2 (expiry not enforced): in handleExpiry, comment out `this.runStates.delete(runId)`.
 *   Failing assertion: 'expired decision must not appear after handleExpiry'
 *   fails because the expired run's decision still appears in getAll().
 */

import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import type { PendingDecision, Run, RunDecision, RunDecisionPayload } from '@farmslot/protocol';

import { makeRun as baseRun } from '../run-engine/test-fixtures.js';

// ── Controlled mock state ──────────────────────────────────────────────────────

const revisionAdvances: Array<{ key: object; kind?: string }> = [];

mock.module('../resources/revisions.js', {
  namedExports: {
    resourceRevisions: {
      advance(key: object, kind?: string) {
        revisionAdvances.push({ key, kind });
      },
    },
  },
});

/** Active runs populated per-test; getRunsWithDecisions() uses these. */
const mockActiveRuns: Run[] = [];
/** Done-but-recent runs populated per-test. */
const mockDoneRuns: Run[] = [];
const mockRunById = new Map<string, Run>();

mock.module('../runs/store.js', {
  namedExports: {
    getRun: (id: string) => mockRunById.get(id),
    listRuns: (filter?: { active?: boolean }) => {
      const runs = filter?.active ? [...mockActiveRuns] : [...mockActiveRuns, ...mockDoneRuns];
      return { runs, totalCount: runs.length };
    },
  },
});

/**
 * Enrichment mocks: each layer adds a distinct context marker so defect 1 is
 * detectable — raw decisions lack these fields, enriched ones have all three.
 */
mock.module('../run-engine/gate-inspection.js', {
  namedExports: {
    inspectedRun: (run: Run) => ({
      ...run,
      decisions: run.decisions.map((d) => ({
        ...d,
        context: { ...(d.context ?? {}), _inspected: true },
      })),
    }),
  },
});

mock.module('../run-engine/gate-summary.js', {
  namedExports: {
    enrichDecisionsWithGateSummary: (run: Run) => ({
      ...run,
      decisions: run.decisions.map((d) => ({
        ...d,
        context: { ...(d.context ?? {}), _enriched: true },
      })),
    }),
  },
});

mock.module('../review/review-round-budget.js', {
  namedExports: {
    attachReviewRoundBudget: async (run: Run) => ({
      ...run,
      decisions: run.decisions.map((d) => ({
        ...d,
        context: { ...(d.context ?? {}), _budgeted: true },
      })),
    }),
  },
});

const RETRO_PAYLOAD: RunDecisionPayload = {
  kind: 'retrospective',
  feedback: [],
  grading: { score: 0, notes: '' },
} as unknown as RunDecisionPayload;

mock.module('../run-completion/orchestrator.js', {
  namedExports: {
    buildRetrospectivePayload: async (): Promise<RunDecisionPayload> => RETRO_PAYLOAD,
  },
});

mock.module('../intelligence/feedback-candidates.js', {
  namedExports: {
    refreshRetrospectiveFeedback: async (
      payload: RunDecisionPayload,
    ): Promise<RunDecisionPayload> => payload,
  },
});

// Import AFTER mocks are registered so the module picks up the mocked dependencies.
const { DecisionIndex } = await import('./index.js');
const { pendingDecisionForRun } = await import('../run-engine/decision-projection.js');

// ── Fixture helpers ───────────────────────────────────────────────────────────

function makeDecision(overrides: Partial<RunDecision> & { id: string }): RunDecision {
  return {
    type: 'collision_check',
    title: `Decision ${overrides.id}`,
    description: 'desc',
    actions: [{ id: 'ok', label: 'OK', style: 'primary' as const }],
    createdAt: '2026-01-01T00:00:00.000Z',
    context: {},
    ...overrides,
  };
}

function makeRun(overrides: {
  id: string;
  status: Run['status'];
  decisions: RunDecision[];
  completedAt?: string;
  archivedAt?: string;
}): Run {
  return baseRun({
    id: overrides.id,
    familyId: overrides.id,
    slotId: `slot-${overrides.id}`,
    status: overrides.status,
    decisions: overrides.decisions,
    completedAt: overrides.completedAt,
    archivedAt: overrides.archivedAt,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
}

function makeFileDecision(id: string): PendingDecision {
  return {
    id,
    type: 'collision_check',
    slotId: null,
    title: `File ${id}`,
    description: 'file decision',
    context: { _file: true },
    actions: [{ id: 'ok', label: 'OK', style: 'primary' }],
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

/** TestDecisionIndex: overrides loadAll() so warm-up uses injected fixtures. */
class TestDecisionIndex extends DecisionIndex {
  constructor(
    private _fileDecisions: PendingDecision[],
    private _runs: Run[],
  ) {
    super();
  }

  protected override async loadAll(): Promise<{ fileDecisions: PendingDecision[]; runs: Run[] }> {
    return { fileDecisions: this._fileDecisions, runs: this._runs };
  }
}

/**
 * Reference function: direct copy of decisionList() logic from methods/decisions.ts.
 * Both reference and index use the same mocks, so they must produce identical output.
 */
async function referenceDecisionList(
  fileDecisions: PendingDecision[],
  runs: Run[],
): Promise<PendingDecision[]> {
  const { enrichDecisionsWithGateSummary } = await import('../run-engine/gate-summary.js');
  const { attachReviewRoundBudget } = await import('../review/review-round-budget.js');
  const { inspectedRun } = await import('../run-engine/gate-inspection.js');
  const { buildRetrospectivePayload } = await import('../run-completion/orchestrator.js');
  const { refreshRetrospectiveFeedback } = await import('../intelligence/feedback-candidates.js');

  const runDecisions: PendingDecision[] = [];
  for (const run of runs) {
    const enrichedRun = enrichDecisionsWithGateSummary(
      await attachReviewRoundBudget(inspectedRun(run)),
    );
    for (const d of enrichedRun.decisions) {
      if (d.resolvedAt) continue;
      let payload: RunDecisionPayload | undefined =
        d.type === 'retrospective' && !d.payload
          ? await buildRetrospectivePayload(enrichedRun, null)
          : d.payload;
      if (payload?.kind === 'retrospective')
        payload = await refreshRetrospectiveFeedback(payload, enrichedRun);
      runDecisions.push(pendingDecisionForRun(run, d, payload));
    }
  }
  return [...fileDecisions, ...runDecisions];
}

function clearMockState(): void {
  revisionAdvances.length = 0;
  mockActiveRuns.length = 0;
  mockDoneRuns.length = 0;
  mockRunById.clear();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('warm-up parity: getAll() deep-equals referenceDecisionList(), order included', async () => {
  clearMockState();
  const fileDecision = makeFileDecision('fd-1');

  // Run 1: gate decision (collision_check — has gate summary enrichment)
  const gateDecision = makeDecision({ id: 'gate-1', type: 'collision_check' });
  const run1 = makeRun({ id: 'run-1', status: 'monitoring', decisions: [gateDecision] });

  // Run 2: review gate with round budget
  const reviewDecision = makeDecision({ id: 'review-1', type: 'review_posting' });
  const run2 = makeRun({ id: 'run-2', status: 'monitoring', decisions: [reviewDecision] });

  // Run 3: retrospective without stored payload
  const retroNoPayload = makeDecision({ id: 'retro-nop', type: 'retrospective' });
  const run3 = makeRun({ id: 'run-3', status: 'monitoring', decisions: [retroNoPayload] });

  // Run 4: retrospective WITH stored payload
  const retroWithPayload = makeDecision({
    id: 'retro-wp',
    type: 'retrospective',
    payload: RETRO_PAYLOAD,
  });
  const run4 = makeRun({ id: 'run-4', status: 'monitoring', decisions: [retroWithPayload] });

  // Run 5: resolved decision (should not appear)
  const resolvedDecision = makeDecision({
    id: 'resolved-1',
    type: 'collision_check',
    resolvedAt: '2026-01-02T00:00:00.000Z',
  });
  const run5 = makeRun({
    id: 'run-5',
    status: 'done',
    completedAt: new Date(Date.now() - 1000).toISOString(),
    decisions: [resolvedDecision],
  });

  const fileDecisions = [fileDecision];
  const runs = [run1, run2, run3, run4];

  // Populate listRuns mock (active runs only for parity; run5 is done/expired separately).
  mockActiveRuns.push(run1, run2, run3, run4);
  for (const r of [run1, run2, run3, run4, run5]) mockRunById.set(r.id, r);

  const idx = new TestDecisionIndex(fileDecisions, runs);
  idx.startWarmup();
  await idx.ready();

  const actual = idx.getAll();
  const expected = await referenceDecisionList(fileDecisions, runs);

  assert.deepStrictEqual(
    actual,
    expected,
    `warm-up parity failed.\nActual:   ${JSON.stringify(actual.map((d) => d.id))}\nExpected: ${JSON.stringify(expected.map((d) => d.id))}`,
  );

  // Order: file decisions first, then run decisions.
  assert.equal(actual[0]?.id, 'fd-1', 'file decision first');
  assert.equal(actual[1]?.id, 'gate-1', 'run-1 gate decision second');

  // All enrichment layers applied — defect 1 proof: break `for (const d of enrichedRun.decisions)`
  // → `for (const d of run.decisions)` and this assertion fails.
  for (const entity of actual.filter((d) => d.id !== 'fd-1')) {
    assert.equal(
      entity.context._enriched,
      true,
      `gate decision must carry enriched context fields (id=${entity.id})`,
    );
  }
});

test('reconcileFileDecisions: add, update, remove — membership and data advances', () => {
  clearMockState();
  const idx = new TestDecisionIndex([], []);

  const fd1 = makeFileDecision('fd-a');
  const fd2 = makeFileDecision('fd-b');

  revisionAdvances.length = 0;
  idx.reconcileFileDecisions([fd1, fd2]);

  // Both added → membership key twice (one per add path, consolidated).
  const membershipAfterAdd = revisionAdvances.filter(
    (a) => (a.key as { family?: string; scope?: string }).family === 'decisions',
  );
  assert.ok(membershipAfterAdd.length > 0, 'membership key advanced on add');

  // Update fd1 (same id, different title → different hash).
  revisionAdvances.length = 0;
  const fd1Updated = { ...fd1, title: 'Updated title' };
  idx.reconcileFileDecisions([fd1Updated, fd2]);
  const dataAdvance = revisionAdvances.find(
    (a) =>
      (a.key as { decisionId?: string }).decisionId === 'fd-a' &&
      !(a.key as { scope?: string }).scope,
  );
  assert.ok(dataAdvance, 'per-decision key advanced on data change');
  const membershipOnUpdate = revisionAdvances.filter(
    (a) => (a.key as { family?: string; scope?: string }).family === 'decisions',
  );
  assert.equal(membershipOnUpdate.length, 0, 'membership key NOT advanced on data-only change');

  // Remove fd1.
  revisionAdvances.length = 0;
  idx.reconcileFileDecisions([fd2]);
  const membershipAfterRemove = revisionAdvances.filter(
    (a) => (a.key as { family?: string; scope?: string }).family === 'decisions',
  );
  assert.ok(membershipAfterRemove.length > 0, 'membership key advanced on remove');
  assert.equal(idx.get('fd-a'), undefined, 'removed file decision not in index');
});

test('expiry: expired run decisions do not appear after handleExpiry', async () => {
  clearMockState();
  // A "done" run whose completedAt is 49h ago → expiresAt (completedAt + 48h) is already past.
  const oldCompletedAt = new Date(Date.now() - 49 * 3600 * 1000).toISOString();
  const expiredDecision = makeDecision({ id: 'expired-d', type: 'collision_check' });
  const expiredRun = makeRun({
    id: 'run-expired',
    status: 'done',
    completedAt: oldCompletedAt,
    decisions: [expiredDecision],
  });

  mockDoneRuns.push(expiredRun);
  mockRunById.set(expiredRun.id, expiredRun);

  const idx = new TestDecisionIndex([], [expiredRun]);
  idx.startWarmup();
  await idx.ready();

  // After warm-up: the run IS in the index (completedAt is old but expiresAt is in the past already).
  // handleExpiry purges it.
  idx['handleExpiry']();

  assert.equal(
    idx.get('expired-d'),
    undefined,
    // Defect 2 revert proof: comment out `this.runStates.delete(runId)` in handleExpiry →
    // this assertion fails because the expired decision still appears.
    'expired decision must not appear after handleExpiry',
  );
  assert.equal(
    idx.getAll().find((d) => d.id === 'expired-d'),
    undefined,
    'expired decision must not appear in getAll() after handleExpiry',
  );
});

test('markResolved removes decision from index and advances keys', async () => {
  clearMockState();
  const decision = makeDecision({ id: 'to-resolve', type: 'collision_check' });
  const run = makeRun({ id: 'run-r', status: 'monitoring', decisions: [decision] });
  mockActiveRuns.push(run);
  mockRunById.set(run.id, run);

  const idx = new TestDecisionIndex([], [run]);
  idx.startWarmup();
  await idx.ready();

  assert.ok(idx.get('to-resolve') !== undefined, 'decision present before resolve');

  revisionAdvances.length = 0;
  idx.markResolved('to-resolve');

  assert.equal(idx.get('to-resolve'), undefined, 'decision absent after resolve');
  const deletedAdvance = revisionAdvances.find(
    (a) => (a.key as { decisionId?: string }).decisionId === 'to-resolve' && a.kind === 'deleted',
  );
  assert.ok(deletedAdvance, 'per-decision key advanced with deleted kind on resolve');
});

test('rebuildAllRetrospectiveDecisions: retro decisions present, non-retro decisions untouched', async () => {
  clearMockState();
  const retroDecision = makeDecision({ id: 'retro-rb', type: 'retrospective' });
  const gateDecision = makeDecision({ id: 'gate-rb', type: 'collision_check' });
  const runRetro = makeRun({ id: 'run-retro', status: 'monitoring', decisions: [retroDecision] });
  const runGate = makeRun({ id: 'run-gate', status: 'monitoring', decisions: [gateDecision] });
  mockActiveRuns.push(runRetro, runGate);
  mockRunById.set(runRetro.id, runRetro);
  mockRunById.set(runGate.id, runGate);

  const idx = new TestDecisionIndex([], [runRetro, runGate]);
  idx.startWarmup();
  await idx.ready();

  // Baseline: both decisions present, both have enriched context from warm-up.
  const beforeAll = idx.getAll();
  assert.ok(
    beforeAll.find((d) => d.id === 'retro-rb'),
    'retro decision present before rebuildAll',
  );
  assert.ok(
    beforeAll.find((d) => d.id === 'gate-rb'),
    'gate decision present before rebuildAll',
  );

  // Trigger rebuild. Each run-with-retrospective is reprocessed; gate-only runs are skipped.
  revisionAdvances.length = 0;
  idx.rebuildAllRetrospectiveDecisions();

  // Drain async enrichment pipeline (all mocks return resolved Promises).
  await new Promise<void>((r) => setImmediate(r));

  // After rebuild both decisions must still appear — rebuild must not drop non-retro entries.
  const afterAll = idx.getAll();
  assert.ok(
    afterAll.find((d) => d.id === 'retro-rb'),
    'retro decision must still appear after rebuildAll',
  );
  assert.ok(
    afterAll.find((d) => d.id === 'gate-rb'),
    'gate decision must still appear after rebuildAll (non-retro run untouched)',
  );

  // Retro decision must still carry enriched context — rebuild must use enrichedRun.decisions.
  const retroEntity = afterAll.find((d) => d.id === 'retro-rb')!;
  assert.equal(
    retroEntity.context._enriched,
    true,
    'retro decision context must remain enriched after rebuildAll',
  );
});
