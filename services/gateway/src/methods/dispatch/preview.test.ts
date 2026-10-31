import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { PressureAdmissionDecision, QueueItem, SlotStatus } from '@farmslot/protocol';

import '../../runtime/mock-pty.test-support.js';

import {
  buildQueuePreviewParams,
  queueItemHeldByPressure,
  selectQueueDispatchSlot,
} from '../../backlog/dispatch-queue.js';
import { runWithSessionOriginator } from '../../security/work-originator.js';

import {
  assertPressureAdmissionConfigValid,
  automaticSlotLoads,
  evaluatePressureAdmission,
  isPinnedSlotSelection,
  type PressureAdmissionConfig,
  resolveAutomaticSlotIdleMinimums,
} from './pressure-admission.js';
import {
  resetPressureAdmissionControlCacheForTest,
  setPressureAdmissionEnabled,
} from './pressure-admission-control.js';
import { resolveDispatchPreviewFromFleet } from './preview.js';
import {
  AutomaticSlotLoadWaitError,
  findBestSlot,
  projectConfigsFromProjects,
  type SlotSelectionPlans,
} from './slot-scoring.js';

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

function loadDecision(
  machine: string,
  cpuIdlePercent: number,
  load1 = 2.11,
): PressureAdmissionDecision {
  const original = decisionFor(machine, 'green');
  return {
    outcome: 'admitted',
    machine,
    state: 'disabled',
    enforced: false,
    evidence: {
      ...original.evidence,
      samples: original.evidence.samples.map((sample) => ({
        ...sample,
        cpu: 1 - cpuIdlePercent / 100,
        load1,
      })),
    },
  };
}

test('only load-only automatic preview refusals carry an engine wait', () => {
  const hot = slot({ slot: 'hot', machine: 'hot' });
  const params = { project: 'demo-farm', flowType: 'dev' as const, ticketOrPr: 'TASK-1' };
  const overload = new Map([['hot', loadDecision('hot', 10)]]);
  const resolve = (candidate: SlotStatus, pressureDecisions = overload) =>
    resolveDispatchPreviewFromFleet(params, [candidate], undefined, { pressureDecisions });
  assert.throws(
    () => resolve(hot),
    (error: unknown) => {
      assert.ok(error instanceof AutomaticSlotLoadWaitError);
      assert.equal(error.wait.slotId, 'hot');
      assert.match(error.wait.reason, /Waiting for node load.*CPU idle 10\.00% < 15\.00%/);
      return true;
    },
  );
  for (const blocked of [
    { ...hot, repoBlocker: 'unresolved repository ownership' },
    { ...hot, lifecycle: 'busy' as const, agent: 'working' as const },
  ])
    assert.throws(
      () => resolve(blocked),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error instanceof AutomaticSlotLoadWaitError, false);
        return true;
      },
    );
  const rejected = decisionFor('hot', 'sustained');
  assert.equal(rejected.outcome, 'rejected');
  const pressureDecisions = new Map<string, PressureAdmissionDecision>([
    [
      'hot',
      {
        ...rejected,
        evidence: {
          ...rejected.evidence,
          samples: rejected.evidence.samples.map((sample) => ({ ...sample, load1: 1.72 })),
        },
      },
    ],
  ]);
  assert.throws(
    () => resolve(hot, pressureDecisions),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error instanceof AutomaticSlotLoadWaitError, false);
      return true;
    },
  );
});

test('automatic placement uses sampled CPU idle rather than load average', () => {
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
    ['hot', loadDecision('hot', 5)],
    ['medium', loadDecision('medium', 40)],
    ['light', loadDecision('light', 80)],
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
  assert.equal(
    resolve().preview.slotId,
    'light',
    'higher CPU idle wins over branch and CDP preference',
  );
  assert.equal(
    resolve(['hot', 'medium']).preview.slotId,
    'medium',
    'allowlist excludes lighter node',
  );
  assert.equal(resolve(['hot']).preview.slotId, 'hot', 'single-slot pin bypasses idle gate');
  assert.equal(queueItemHeldByPressure(slots, 'demo-farm', decisions, ['hot']), false);
  assert.equal(queueItemHeldByPressure(slots, 'demo-farm', decisions, ['hot', 'light']), false);
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
  decisions.set('hot', loadDecision('hot', 20));
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

test('CPU idle minimum is per machine, defaults to 15, and excludes stale evidence', () => {
  const decision = loadDecision('node', 12);
  const decisions = new Map([['node', decision]]);
  assert.equal(automaticSlotLoads(decisions).get('node')?.skipped, true);
  assert.equal(automaticSlotLoads(decisions, { node: 10 }).get('node')?.skipped, false);
  assert.equal(automaticSlotLoads(decisions, { other: 10 }).get('node')?.skipped, true);
  const boundary = new Map([['node', loadDecision('node', 15)]]);
  assert.equal(automaticSlotLoads(boundary).get('node')?.skipped, false);
  for (const code of ['PRESSURE_EVIDENCE_STALE', 'PRESSURE_EVIDENCE_UNAVAILABLE'] as const) {
    const stale = { ...decision, advisory: { code, reason: 'No live evidence', causes: [] } };
    assert.equal(automaticSlotLoads(new Map([['node', stale]])).get('node')?.cpuIdlePercent, null);
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

test('single-slot and explicit-slot pins warn without skipping a busy host', () => {
  const decisions = new Map([['hot', loadDecision('hot', 5)]]);
  for (const pin of [{ allowedSlots: ['hot'] }, { slotId: 'hot' }]) {
    const load = automaticSlotLoads(decisions, undefined, isPinnedSlotSelection(pin)).get('hot')!;
    assert.equal(load.skipped, false);
    assert.match(
      load.reason,
      /Warning:.*CPU idle 5\.00% < 15\.00%.*explicitly pinned slot, dispatch continues/,
    );
  }
  assert.equal(
    automaticSlotLoads(
      decisions,
      undefined,
      isPinnedSlotSelection({ allowedSlots: ['hot', 'other'] }),
    ).get('hot')?.skipped,
    true,
  );
  const busySlots = [
    slot({ slot: 'hot', machine: 'hot' }),
    slot({ slot: 'other', machine: 'hot' }),
  ];
  assert.equal(queueItemHeldByPressure(busySlots, 'demo-farm', decisions, ['hot', 'other']), true);
});

test('the physical device policy uses the same pin intent as the CPU-idle gate', () => {
  const phone = slot({
    slot: 'phone',
    machine: 'node',
    platform: 'android',
    health: { ssh: 'LOCAL', device: 'emu:OK', devserver: 'OK', cdp: 'Wallet', fixtures: 'OK' },
    resources: { 'android-device': { adb_serial: '29071JEGR20638' } },
  });
  const sim = slot({ slot: 'sim', machine: 'node' });
  const projectConfigs = projectConfigsFromProjects([
    { name: 'demo-farm', slotSelection: { physicalDevices: 'on-request' } },
  ]);
  const params = { project: 'demo-farm', flowType: 'dev' as const, ticketOrPr: 'TASK-1' };
  const select = (
    extra: Partial<Parameters<typeof resolveDispatchPreviewFromFleet>[0]>,
    automaticLoadPinned?: boolean,
  ) =>
    resolveDispatchPreviewFromFleet({ ...params, ...extra }, [phone, sim], projectConfigs, {
      automaticLoadPinned,
    }).preview.slotId;
  assert.equal(select({}), 'sim');
  assert.equal(select({ allowedSlots: ['phone', 'sim'] }), 'sim');
  assert.equal(select({ slotId: 'phone' }), 'phone');
  assert.equal(select({ allowedSlots: ['phone'] }), 'phone');
  // Internal narrowing to one slot keeps the caller's automatic intent.
  assert.throws(
    () => select({ allowedSlots: ['phone'] }, false),
    /phone: Physical device slot is reserved for runs that request a device/,
  );
});

test('per-machine CPU-idle gateway config accepts percentages and rejects malformed values at startup', () => {
  const key = 'FARMSLOT_AUTOMATIC_CPU_IDLE_MIN_PERCENT_BY_MACHINE';
  assert.deepEqual(
    resolveAutomaticSlotIdleMinimums({ [key]: '{"one":0,"two":100,"three":12.5}' }),
    { one: 0, two: 100, three: 12.5 },
  );
  assert.deepEqual(resolveAutomaticSlotIdleMinimums({}), {});
  for (const value of ['[]', 'null', '{"one":-1}', '{"one":101}', '{"one":"15"}', 'invalid'])
    assert.throws(() => assertPressureAdmissionConfigValid({ [key]: value }));
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

test('automatic placement preserves red headroom ahead of lower load', () => {
  const light = slot({
    slot: 'light-red',
    machine: 'light',
    hostLoad: { cpuPercent: 20, memoryPercent: 40, diskPercent: 97, headroom: 'red' },
  });
  const healthy = slot({ slot: 'healthy', machine: 'healthy' });
  const pressureDecisions = new Map([
    ['light', loadDecision('light', 90)],
    ['healthy', loadDecision('healthy', 60)],
  ]);
  const params = { project: 'demo-farm', flowType: 'dev' as const, ticketOrPr: 'TASK-1' };
  assert.equal(
    resolveDispatchPreviewFromFleet(params, [light, healthy], undefined, { pressureDecisions })
      .preview.slotId,
    'healthy',
  );
  assert.equal(
    resolveDispatchPreviewFromFleet(
      { ...params, flowType: 'pr-complete', ticketOrPr: 'owner/repo#42' },
      [{ ...light, lifecycle: 'held', branch: 'owner-repo-42' }, healthy],
      undefined,
      { pressureDecisions },
    ).preview.slotId,
    'healthy',
  );
});

test('queue load hold includes held PR affinity, including a spread subset', async () => {
  const slots = [
    slot({ slot: 'hot', machine: 'hot' }),
    slot({ slot: 'held', machine: 'light', lifecycle: 'held', branch: 'owner-repo-42' }),
  ];
  const pressureDecisions = new Map([
    ['hot', loadDecision('hot', 5)],
    ['light', loadDecision('light', 80)],
  ]);
  const item: QueueItem = {
    id: 'load-held',
    project: 'demo-farm',
    flowType: 'pr-complete',
    ticketOrPr: 'owner/repo#42',
    priority: 1,
    status: 'queued',
    createdAt: new Date().toISOString(),
    allowedSlots: ['hot', 'held'],
  };
  const capturePressure = () => pressureDecisions;
  assert.equal(await selectQueueDispatchSlot(slots, item, { capturePressure }), 'held');
  const store = await import('../../runs/store.js');
  const sibling = store.createRun({ flowType: 'dev', project: item.project, ticketOrPr: 'TASK-2' });
  store.updateRun(sibling.id, {
    status: 'monitoring',
    slotId: 'sibling-slot',
    launchGroupId: 'load-group',
  });
  try {
    assert.equal(
      await selectQueueDispatchSlot(
        slots,
        {
          ...item,
          allowedSlots: [...item.allowedSlots!, 'sibling-slot'],
          launchSlotPolicy: 'spread',
          launchGroupId: 'load-group',
        },
        { capturePressure },
      ),
      'held',
    );
    store.updateRun(sibling.id, { slotId: 'held' });
    assert.equal(
      await selectQueueDispatchSlot(
        slots,
        { ...item, launchSlotPolicy: 'spread', launchGroupId: 'load-group' },
        { capturePressure },
      ),
      null,
      'spread narrowing a two-slot operator scope to one busy slot is not a pin',
    );
    assert.equal(
      await selectQueueDispatchSlot(
        slots,
        { ...item, allowedSlots: ['hot'], launchSlotPolicy: 'spread', launchGroupId: 'load-group' },
        { capturePressure },
      ),
      'hot',
      'an actual one-slot operator pin still bypasses the automatic CPU gate',
    );
  } finally {
    store.updateRun(sibling.id, { status: 'done' });
    await store.deleteRun(sibling.id);
  }
  assert.equal(
    queueItemHeldByPressure(
      slots,
      item.project,
      pressureDecisions,
      ['hot'],
      buildQueuePreviewParams(item),
    ),
    true,
  );
  pressureDecisions.set('light', loadDecision('light', 4));
  assert.equal(await selectQueueDispatchSlot(slots, item, { capturePressure }), null);
  assert.equal(
    await selectQueueDispatchSlot(slots, { ...item, allowedSlots: ['held'] }, { capturePressure }),
    'held',
    'a single-slot queue pin warns and proceeds even when the machine is busy',
  );
});
