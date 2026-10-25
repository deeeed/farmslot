import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { PressureAdmissionDecision, SlotStatus } from '@farmslot/protocol';

import '../../runtime/mock-pty.test-support.js';

import { queueItemHeldByPressure, selectQueueDispatchSlot } from '../../backlog/dispatch-queue.js';
import { runWithSessionOriginator } from '../../security/work-originator.js';

import {
  automaticSlotLoads,
  evaluatePressureAdmission,
  type PressureAdmissionConfig,
} from './pressure-admission.js';
import {
  resetPressureAdmissionControlCacheForTest,
  setPressureAdmissionEnabled,
} from './pressure-admission-control.js';
import { resolveDispatchPreviewFromFleet } from './preview.js';
import { findBestSlot, type SlotSelectionPlans } from './slot-scoring.js';

/** The lightweight capture reads the kill switch from FARMSLOT_HOME. */
async function withTempControlHome<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.FARMSLOT_HOME;
  process.env.FARMSLOT_HOME = mkdtempSync(path.join(tmpdir(), 'farmslot-preview-test-'));
  resetPressureAdmissionControlCacheForTest();
  try {
    return await run();
  } finally {
    resetPressureAdmissionControlCacheForTest();
    if (previous === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = previous;
  }
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const ARTIFACT_DIR = path.join(REPO_ROOT, 'artifacts');

const NOW = Date.parse('2026-08-21T10:00:00.000Z');

test('scoped preview uses candidate profile and execution choices instead of a farm default', () => {
  const a = slot({ slot: 'a', machine: 'node-a' });
  const b = slot({ slot: 'b', machine: 'node-b' });
  const params = {
    project: 'demo-farm',
    flowType: 'dev' as const,
    ticketOrPr: 'TASK-1',
    prepareProfile: 'sandbox-companion',
  };
  const plans: SlotSelectionPlans = new Map([
    ['a', { params }],
    [
      'b',
      { params: { ...params, prepareProfile: 'plain', runner: 'codex', model: 'selected-model' } },
    ],
  ]);
  const result = resolveDispatchPreviewFromFleet(params, [a, b], undefined, { plans });
  assert.equal(result.preview.slotId, 'b');
  assert.equal(result.preview.runner, 'codex');
  assert.equal(result.preview.model, 'selected-model');
});

test('scoped scoring uses each pack idle branch while retaining existing host penalties', () => {
  const a = slot({ slot: 'a', machine: 'node-a', branch: 'experiment-base' });
  const b = slot({
    slot: 'b',
    machine: 'node-b',
    hostLoad: { cpuPercent: 40, memoryPercent: 30, diskPercent: 30, headroom: 'yellow' },
  });
  const params = { project: 'demo-farm', flowType: 'dev' as const, ticketOrPr: 'TASK-1' };
  assert.equal(resolveDispatchPreviewFromFleet(params, [a, b]).preview.slotId, 'b');
  const plans: SlotSelectionPlans = new Map([
    ['a', { params, projectConfigs: { 'demo-farm': { defaultBranch: 'experiment-base' } } }],
    ['b', { params, projectConfigs: { 'demo-farm': { defaultBranch: 'main' } } }],
  ]);
  assert.equal(
    resolveDispatchPreviewFromFleet(params, [a, b], undefined, { plans }).preview.slotId,
    'a',
  );
});

test('scoped affinity skips an incompatible node and still prefers a valid held slot', () => {
  const a = slot({ slot: 'a', machine: 'node-a', lifecycle: 'held', branch: 'owner-repo-42' });
  const b = slot({ slot: 'b', machine: 'node-b', lifecycle: 'held', branch: 'owner-repo-42' });
  const params = {
    project: 'demo-farm',
    flowType: 'pr-complete' as const,
    ticketOrPr: 'owner/repo#42',
  };
  const plans: SlotSelectionPlans = new Map([
    ['a', { params: { ...params, prepareProfile: 'sandbox-companion' } }],
    ['b', { params }],
  ]);
  assert.equal(
    resolveDispatchPreviewFromFleet(params, [a, b], undefined, { plans }).preview.slotId,
    'b',
  );
});

test('missing or refused scoped candidates cannot use a floating fallback, including explicit picks', () => {
  const a = slot({ slot: 'a', machine: 'node-a' });
  const b = slot({ slot: 'b', machine: 'node-b' });
  const params = { project: 'demo-farm', flowType: 'dev' as const, ticketOrPr: 'TASK-1' };
  const plans: SlotSelectionPlans = new Map([
    ['a', { refusal: 'source ref unavailable' }],
    ['b', { params }],
  ]);
  assert.equal(
    resolveDispatchPreviewFromFleet(params, [a, b], undefined, { plans }).preview.slotId,
    'b',
  );
  assert.throws(
    () => resolveDispatchPreviewFromFleet({ ...params, slotId: 'a' }, [a, b], undefined, { plans }),
    /source ref unavailable/,
  );
  assert.throws(
    () => resolveDispatchPreviewFromFleet(params, [a, b], undefined, { plans: new Map() }),
    /source plan unavailable/,
  );
});

const CONFIG: PressureAdmissionConfig = {
  cpuCritical: 0.9,
  memoryCritical: 0.9,
  diskCritical: 0.95,
  load1Critical: 1.5,
  minConsecutiveCriticalSamples: 3,
  staleAfterMs: 150_000,
  evidenceSampleWindow: 8,
  maxCauses: 5,
  validationFixtureMachine: null,
};

function slot(overrides: Partial<SlotStatus> & { slot: string; machine: string }): SlotStatus {
  return {
    platform: 'ios',
    project: 'demo-farm',
    health: { ssh: 'LOCAL', device: 'sim:OK', devserver: 'OK', cdp: 'Wallet', fixtures: 'OK' },
    branch: 'main',
    agent: 'idle',
    enabled: true,
    dispatchable: true,
    lifecycle: 'ready',
    phase: null,
    warm: true,
    taskId: null,
    taskFile: null,
    dispatchedAt: null,
    completedAt: null,
    runner: null,
    model: null,
    deviceName: null,
    taskPhase: null,
    taskStepProgress: null,
    ...overrides,
  } as SlotStatus;
}

/** Deterministic decisions from the same policy the gateway runs. */
function decisionFor(machine: string, kind: 'green' | 'sustained'): PressureAdmissionDecision {
  const cpu = kind === 'sustained' ? 0.97 : 0.3;
  const history = [90, 60, 30].map((secondsAgo, index) => ({
    generation: 'gen-a',
    sampleId: index,
    collectedAt: new Date(NOW - secondsAgo * 1_000).toISOString(),
    pressure: { cpu, memory: 0.4, disk: 0.5, load1: 0.5 },
    cpuPercent: cpu * 100,
    memoryPercent: 40,
    diskPercent: 50,
    loadAvg1: 4,
    loadAvg5: 4,
  }));
  return evaluatePressureAdmission({
    machine,
    capture: {
      machine,
      online: true,
      headroom: 'green',
      severity: 'ok',
      concerns: [],
      history,
      historyFreshness: {
        source: 'live',
        latestSampleAt: history.at(-1)?.collectedAt ?? null,
        ageMs: 30_000,
        stale: false,
      },
      processAttribution: {
        truncated: false,
        ancestryTruncated: false,
        sampledProcesses: 4,
        totalProcesses: 4,
        maxEntries: 64,
        omittedGroups: 0,
        classCounts: { active: 0, retained: 1, stale: 0, manual: 0, unknown: 0 },
        managedGroupCount: 1,
        managedClassCounts: { active: 0, retained: 1, stale: 0, manual: 0, unknown: 0 },
        groups: [
          {
            rootPid: 1,
            processCount: 3,
            executable: '/usr/bin/node',
            topPid: 2,
            topExecutable: '/usr/bin/node',
            topCpuPercent: 120,
            topRssBytes: 1073741824,
            cpuPercent: 200,
            rssBytes: 2 * 1073741824,
            classification: 'retained',
            confidence: 'high',
            evidence: [],
            slotId: `${machine}-ff-1`,
          },
        ],
      },
      slots: { total: 1, ready: 1, busy: 0, working: 0, manual: 0, disabled: 0 },
      resources: {
        total: 0,
        byStatus: { unknown: 0, running: 0, stopped: 0, error: 0, stale: 0 },
        cleanupCandidates: 0,
      },
    },
    config: CONFIG,
    now: NOW,
  });
}

const fleet = [
  slot({ slot: 'macwork-ff-1', machine: 'macwork' }),
  slot({ slot: 'mini-ff-1', machine: 'mini' }),
];
const decisions = new Map<string, PressureAdmissionDecision>([
  ['macwork', decisionFor('macwork', 'sustained')],
  ['mini', decisionFor('mini', 'green')],
]);

const selectionArtifact: Record<string, unknown> = {};

function loadDecision(machine: string, load1: number): PressureAdmissionDecision {
  const original = decisionFor(machine, 'green');
  return {
    outcome: 'admitted',
    machine,
    state: 'disabled',
    enforced: false,
    evidence: {
      ...original.evidence,
      samples: original.evidence.samples.map((sample) => ({ ...sample, load1 })),
    },
  };
}

test('automatic placement skips load 83/16 with refusal disabled and ranks allowed nodes by load/core', () => {
  const slots = [
    slot({ slot: 'hot', machine: 'hot', branch: 'fix/TASK-1' }),
    slot({ slot: 'medium', machine: 'medium' }),
    slot({
      slot: 'light',
      machine: 'light',
      health: { ssh: 'LOCAL', device: 'sim:OK', devserver: 'OK', cdp: 'OFF', fixtures: 'OK' },
    }),
  ];
  const decisions = new Map([
    ['hot', loadDecision('hot', 83 / 16)],
    ['medium', loadDecision('medium', 6 / 16)],
    ['light', loadDecision('light', 1.4 / 8)],
  ]);
  const params = {
    project: 'demo-farm',
    flowType: 'fix-bug' as const,
    ticketOrPr: 'TASK-1',
    targetBranch: 'fix/TASK-1',
  };
  const resolve = (allowedSlots?: string[]) =>
    resolveDispatchPreviewFromFleet({ ...params, allowedSlots }, slots, undefined, {
      pressureDecisions: decisions,
    });
  assert.equal(resolve().preview.slotId, 'light', 'lower load wins over branch and CDP preference');
  assert.equal(
    resolve(['hot', 'medium']).preview.slotId,
    'medium',
    'allowlist excludes lighter node',
  );
  assert.throws(() => resolve(['hot']), /load\/core 5.19 >= 1.50.*skipped/);
  assert.equal(queueItemHeldByPressure(slots, 'demo-farm', decisions, ['hot']), true);
  assert.equal(queueItemHeldByPressure(slots, 'demo-farm', decisions), false);
  assert.equal(
    resolveDispatchPreviewFromFleet({ ...params, slotId: 'hot' }, slots, undefined, {
      pressureDecisions: decisions,
    }).preview.slotId,
    'hot',
    'explicit picks retain the opt-in admission policy',
  );
  const held = [{ ...slots[0], lifecycle: 'held' as const, branch: 'owner-repo-42' }, slots[1]];
  assert.equal(
    resolveDispatchPreviewFromFleet(
      { ...params, flowType: 'pr-complete', ticketOrPr: 'owner/repo#42' },
      held,
      undefined,
      { pressureDecisions: decisions },
    ).preview.slotId,
    'medium',
    'held affinity cannot bypass overload exclusion',
  );
  decisions.set('hot', loadDecision('hot', 1));
  assert.equal(
    resolveDispatchPreviewFromFleet(
      { ...params, flowType: 'pr-complete', ticketOrPr: 'owner/repo#42' },
      held,
      undefined,
      { pressureDecisions: decisions },
    ).preview.slotId,
    'medium',
    'lighter free node wins over an eligible held branch',
  );
});

test('automatic load policy uses its existing threshold override and ignores stale evidence', () => {
  const decision = loadDecision('node', 2);
  const decisions = new Map([['node', decision]]);
  assert.equal(automaticSlotLoads(decisions).get('node')?.skipped, true);
  assert.equal(automaticSlotLoads(decisions, { load1Critical: 3 }).get('node')?.skipped, false);
  for (const code of ['PRESSURE_EVIDENCE_STALE', 'PRESSURE_EVIDENCE_UNAVAILABLE'] as const) {
    const stale = { ...decision, advisory: { code, reason: 'No live evidence', causes: [] } };
    assert.equal(automaticSlotLoads(new Map([['node', stale]])).get('node')?.load1, null);
  }
  assert.equal(
    resolveDispatchPreviewFromFleet(
      { project: 'demo-farm', flowType: 'dev', ticketOrPr: 'TASK-1' },
      [slot({ slot: 'unknown', machine: 'unknown' })],
      undefined,
      { pressureDecisions: new Map() },
    ).preview.slotId,
    'unknown',
  );
});

test('automatic selection excludes pressure-rejected machines', () => {
  const result = resolveDispatchPreviewFromFleet(
    { project: 'demo-farm', flowType: 'fix-bug', ticketOrPr: 'PROJ-1' },
    fleet,
    undefined,
    { pressureDecisions: decisions },
  );
  assert.equal(result.preview.slotId, 'mini-ff-1');
  assert.equal(result.pressureAdmission?.outcome, 'admitted');
  assert.equal(result.pressureAdmission?.machine, 'mini');
  selectionArtifact.automaticSelection = {
    fleet: fleet.map((s) => ({ slot: s.slot, machine: s.machine })),
    rejectedMachines: ['macwork'],
    selectedSlot: result.preview.slotId,
    decision: result.pressureAdmission,
  };
});

test('findBestSlot never lands on a pressure-rejected machine', () => {
  const best = findBestSlot(fleet, 'demo-farm', {
    pressureRejectedMachines: new Set(['macwork']),
  });
  assert.equal(best?.slot, 'mini-ff-1');
  const none = findBestSlot(fleet, 'demo-farm', {
    pressureRejectedMachines: new Set(['macwork', 'mini']),
  });
  assert.equal(none, null);
});

test('automatic selection with every machine rejected fails with the pressure reason', () => {
  const allRejected = new Map<string, PressureAdmissionDecision>([
    ['macwork', decisionFor('macwork', 'sustained')],
    ['mini', decisionFor('mini', 'sustained')],
  ]);
  assert.throws(
    () =>
      resolveDispatchPreviewFromFleet(
        { project: 'demo-farm', flowType: 'fix-bug', ticketOrPr: 'PROJ-1' },
        fleet,
        undefined,
        { pressureDecisions: allRejected },
      ),
    /PRESSURE_SUSTAINED_CRITICAL/,
  );
});

test('explicit slot returns the exact backend rejection and attributed causes', () => {
  const mapDecision = decisions.get('macwork');
  assert.equal(mapDecision?.outcome, 'rejected');
  const result = resolveDispatchPreviewFromFleet(
    { project: 'demo-farm', flowType: 'fix-bug', ticketOrPr: 'PROJ-1', slotId: 'macwork-ff-1' },
    fleet,
    undefined,
    { pressureDecisions: decisions },
  );
  assert.equal(result.preview.slotId, 'macwork-ff-1');
  // Same decision object contents as automatic selection saw for the machine.
  assert.deepEqual(result.pressureAdmission, mapDecision);
  assert.equal(result.pressureAdmission?.outcome, 'rejected');
  if (result.pressureAdmission?.outcome === 'rejected') {
    assert.ok(result.pressureAdmission.causes.length > 0);
  }
  selectionArtifact.explicitSelection = {
    requestedSlot: 'macwork-ff-1',
    decision: result.pressureAdmission,
    identicalToAutomaticPathDecision: true,
  };
  // Existing slot lifecycle checks are untouched: a busy explicit slot still
  // fails with the lifecycle error, not a pressure decision.
  assert.throws(
    () =>
      resolveDispatchPreviewFromFleet(
        {
          project: 'demo-farm',
          flowType: 'fix-bug',
          ticketOrPr: 'PROJ-1',
          slotId: 'mini-ff-1',
        },
        [
          fleet[0],
          slot({ slot: 'mini-ff-1', machine: 'mini', lifecycle: 'busy', phase: 'preparing' }),
        ],
        undefined,
        { pressureDecisions: decisions },
      ),
    /busy/,
  );
});

test('selected-machine override mismatch is reported at the preview boundary only', () => {
  const result = resolveDispatchPreviewFromFleet(
    { project: 'demo-farm', flowType: 'fix-bug', ticketOrPr: 'PROJ-1', slotId: 'macwork-ff-1' },
    fleet,
    undefined,
    { pressureDecisions: decisions, pressureOverrideMachine: 'mini' },
  );
  assert.equal(result.pressureAdmission?.outcome, 'rejected');
  if (result.pressureAdmission?.outcome === 'rejected') {
    assert.equal(result.pressureAdmission.code, 'PRESSURE_OVERRIDE_MISMATCH');
  }
  // The stored per-machine decision is untouched — no cross-machine bleed.
  const stored = decisions.get('macwork');
  assert.equal(stored?.outcome === 'rejected' && stored.code, 'PRESSURE_SUSTAINED_CRITICAL');
});

test('green selected machine still rejects an override bound to another machine', () => {
  const result = resolveDispatchPreviewFromFleet(
    { project: 'demo-farm', flowType: 'fix-bug', ticketOrPr: 'PROJ-1', slotId: 'mini-ff-1' },
    fleet,
    undefined,
    { pressureDecisions: decisions, pressureOverrideMachine: 'macwork' },
  );
  assert.equal(result.pressureAdmission?.outcome, 'rejected');
  if (result.pressureAdmission?.outcome === 'rejected') {
    assert.equal(result.pressureAdmission.code, 'PRESSURE_OVERRIDE_MISMATCH');
    assert.equal(result.pressureAdmission.overridable, false);
  }
});

test('queue: no eligible allowed slot returns null before any pressure work', async () => {
  const busyFleet = fleet.map((s) => slot({ ...s, lifecycle: 'busy' as const }));
  const item = {
    id: 'q1',
    flowType: 'fix-bug',
    project: 'demo-farm',
    ticketOrPr: 'PROJ-1',
    priority: 1,
    createdAt: '2026-08-21T00:00:00.000Z',
    status: 'queued',
  } as Parameters<typeof selectQueueDispatchSlot>[1];
  const throwingCapture = () => {
    throw new Error('pressure capture must not run when nothing is dispatchable');
  };
  assert.equal(
    await selectQueueDispatchSlot(busyFleet, item, { capturePressure: throwingCapture }),
    null,
  );
  // Allowlist that matches nothing dispatchable behaves the same.
  assert.equal(
    await selectQueueDispatchSlot(fleet, { ...item, allowedSlots: ['not-a-slot'] } as typeof item, {
      capturePressure: throwingCapture,
    }),
    null,
  );
});

test('queue: default capture is the lightweight in-memory path, never the heavy snapshot', async () => {
  // Structural: the queue module references only the lightweight capture.
  const queueSource = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../backlog/dispatch-queue.ts'),
    'utf-8',
  );
  assert.ok(queueSource.includes('capturePressureAdmissionDecisionsLightweight'));
  assert.ok(
    !/capturePressureAdmissionDecisions[^L]/.test(
      queueSource.replace('capturePressureAdmissionDecisionsLightweight', ''),
    ),
    'dispatch-queue.ts must not reference the heavy capture',
  );
  // Behavioral: with no stub installed, selection over an empty in-memory
  // pressure state resolves fast, without touching snapshot infrastructure
  // that does not exist in tests. With dispatch prevention opted IN, every
  // machine is unavailable → held → null; at the default (off) the same empty
  // state admits and a slot is selected.
  const item = {
    id: 'q2',
    flowType: 'fix-bug',
    project: 'demo-farm',
    ticketOrPr: 'PROJ-2',
    priority: 1,
    createdAt: '2026-08-21T00:00:00.000Z',
    status: 'queued',
  } as Parameters<typeof selectQueueDispatchSlot>[1];
  await withTempControlHome(async () => {
    runWithSessionOriginator(
      {
        id: 'principal-arthur',
        subject: { type: 'person', displayName: 'Arthur' },
        roles: [{ role: 'admin', scope: { kind: 'global' } }],
      },
      () => setPressureAdmissionEnabled({ enabled: true }),
    );
    assert.equal(await selectQueueDispatchSlot(fleet, item), null);
  });
  await withTempControlHome(async () => {
    assert.equal(await selectQueueDispatchSlot(fleet, item), 'macwork-ff-1');
  });
});

test('operator candidates and preview never trigger heavy pressure attribution', () => {
  const previewSource = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), './preview.ts'),
    'utf-8',
  );
  assert.doesNotMatch(previewSource, /enrichSustainedCauses/u);
  assert.match(previewSource, /capturePressureAdmissionDecisions\(/u);
});

test('queue: item is held (null-selection) when every allowed free machine is rejected', () => {
  const allRejected = new Map<string, PressureAdmissionDecision>([
    ['macwork', decisionFor('macwork', 'sustained')],
    ['mini', decisionFor('mini', 'sustained')],
  ]);
  assert.equal(queueItemHeldByPressure(fleet, 'demo-farm', allRejected), true);
  // Mixed fleet: an admitted machine defeats the hold.
  assert.equal(queueItemHeldByPressure(fleet, 'demo-farm', decisions), false);
  // Allowlist scoping: an admitted machine OUTSIDE the allowlist must not
  // defeat the hold when every allowed slot is on a rejected machine.
  assert.equal(queueItemHeldByPressure(fleet, 'demo-farm', decisions, ['macwork-ff-1']), true);
  assert.equal(queueItemHeldByPressure(fleet, 'demo-farm', decisions, ['mini-ff-1']), false);
  // No free slots at all: not a pressure hold (other queue handling applies).
  const busyFleet = fleet.map((s) => slot({ ...s, lifecycle: 'busy' as const }));
  assert.equal(queueItemHeldByPressure(busyFleet, 'demo-farm', allRejected), false);
  selectionArtifact.queueHold = {
    allRejectedHold: true,
    allowlistScopedHold: true,
    admittedMachineDefeatsHold: true,
  };
});

after(() => {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  writeFileSync(
    path.join(ARTIFACT_DIR, 'dispatch-selection-pressure.json'),
    JSON.stringify(
      {
        spec: 'MANUAL-000109',
        evaluatedAt: new Date(NOW).toISOString(),
        ...selectionArtifact,
      },
      null,
      2,
    ),
  );
});
