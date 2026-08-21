import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import type {
  NodePressureHistorySample,
  PressureAdmissionDecision,
  ProcessAttributionGroup,
  ResourcePressureMachine,
} from '@farmslot/protocol';

import { runWithSessionOriginator } from '../../security/work-originator.js';

import { resolveExecutePressureOutcome } from './execute.js';
import {
  capturePressureAdmissionDecisionsLightweight,
  evaluatePressureAdmission,
  isPressureSampleCritical,
  type PressureAdmissionConfig,
  pressureGenerationForSample,
  resolvePressureAdmissionConfig,
} from './pressure-admission.js';
import {
  resetPressureAdmissionControlCacheForTest,
  setPressureAdmissionEnabled,
} from './pressure-admission-control.js';

/** Lightweight capture reads the kill switch from FARMSLOT_HOME — isolate it. */
function withTempControlHome<T>(run: () => T): T {
  const previous = process.env.FARMSLOT_HOME;
  process.env.FARMSLOT_HOME = mkdtempSync(path.join(tmpdir(), 'farmslot-pressure-policy-'));
  resetPressureAdmissionControlCacheForTest();
  try {
    return run();
  } finally {
    resetPressureAdmissionControlCacheForTest();
    if (previous === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = previous;
  }
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const ARTIFACT_DIR = path.join(REPO_ROOT, 'artifacts');

const NOW = Date.parse('2026-08-21T10:00:00.000Z');

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

function sample(
  secondsBeforeNow: number,
  cpu: number,
  overrides: Partial<NodePressureHistorySample> = {},
): NodePressureHistorySample {
  const collectedAt = new Date(NOW - secondsBeforeNow * 1_000).toISOString();
  return {
    generation: 'gen-a',
    sampleId: 100 - secondsBeforeNow,
    collectedAt,
    pressure: { cpu, memory: 0.4, disk: 0.5, load1: 0.5 },
    cpuPercent: cpu * 100,
    memoryPercent: 40,
    diskPercent: 50,
    loadAvg1: 4,
    loadAvg5: 4,
    ...overrides,
  };
}

function group(overrides: Partial<ProcessAttributionGroup> = {}): ProcessAttributionGroup {
  return {
    rootPid: 100,
    processCount: 4,
    executable: '/usr/bin/node',
    topPid: 101,
    topExecutable: '/usr/bin/node',
    topCpuPercent: 180,
    topRssBytes: 2 * 1073741824,
    cpuPercent: 240,
    rssBytes: 4 * 1073741824,
    classification: 'retained',
    confidence: 'high',
    evidence: ['tmux target matched'],
    slotId: 'macwork-ff-1',
    runId: 'run-1',
    ...overrides,
  };
}

function capture(
  machine: string,
  history: NodePressureHistorySample[],
  overrides: Partial<ResourcePressureMachine> = {},
): ResourcePressureMachine {
  return {
    machine,
    online: true,
    headroom: 'green',
    severity: 'ok',
    concerns: [],
    history,
    historyFreshness: {
      source: 'live',
      latestSampleAt: history.at(-1)?.collectedAt ?? null,
      ageMs: history.length > 0 ? Math.max(0, NOW - Date.parse(history.at(-1)!.collectedAt)) : null,
      stale: false,
    },
    processAttribution: {
      truncated: false,
      ancestryTruncated: false,
      sampledProcesses: 10,
      totalProcesses: 10,
      maxEntries: 64,
      omittedGroups: 0,
      classCounts: { active: 0, retained: 1, stale: 0, manual: 0, unknown: 0 },
      managedGroupCount: 1,
      managedClassCounts: { active: 0, retained: 1, stale: 0, manual: 0, unknown: 0 },
      groups: [group()],
    },
    slots: { total: 2, ready: 2, busy: 0, working: 0, manual: 0, disabled: 0 },
    resources: {
      total: 0,
      byStatus: { unknown: 0, running: 0, stopped: 0, error: 0, stale: 0 },
      cleanupCandidates: 0,
    },
    ...overrides,
  };
}

const matrixRows: Array<{ case: string; input: string; decision: PressureAdmissionDecision }> = [];
const contractVariants: Record<string, unknown> = {};

function record(caseName: string, input: string, decision: PressureAdmissionDecision): void {
  matrixRows.push({ case: caseName, input, decision });
}

test('green: no critical samples admits with full evidence', () => {
  const decision = evaluatePressureAdmission({
    machine: 'macwork',
    capture: capture('macwork', [sample(90, 0.3), sample(60, 0.4), sample(30, 0.35)]),
    config: CONFIG,
    now: NOW,
  });
  assert.equal(decision.outcome, 'admitted');
  assert.equal(decision.state, 'green');
  assert.equal(decision.evidence.consecutiveCriticalSamples, 0);
  assert.equal(
    decision.evidence.generation,
    pressureGenerationForSample('macwork', sample(30, 0.35)),
  );
  record('green', '3 samples below thresholds', decision);
  contractVariants['admitted-green'] = decision;
});

test('transient: latest critical below the consecutive threshold admits', () => {
  const decision = evaluatePressureAdmission({
    machine: 'macwork',
    capture: capture('macwork', [sample(90, 0.3), sample(60, 0.95), sample(30, 0.97)]),
    config: CONFIG,
    now: NOW,
  });
  assert.equal(decision.outcome, 'admitted');
  assert.equal(decision.state, 'transient');
  assert.equal(decision.evidence.consecutiveCriticalSamples, 2);
  record('transient', '2 consecutive critical of required 3', decision);
  contractVariants['admitted-transient'] = decision;
});

test('sustained: consecutive critical samples reject with causes and evidence', () => {
  const decision = evaluatePressureAdmission({
    machine: 'macwork',
    capture: capture('macwork', [
      sample(120, 0.4),
      sample(90, 0.95),
      sample(60, 0.96),
      sample(30, 0.99),
    ]),
    config: CONFIG,
    now: NOW,
  });
  assert.equal(decision.outcome, 'rejected');
  assert.equal(decision.state, 'sustained-critical');
  assert.equal(decision.code, 'PRESSURE_SUSTAINED_CRITICAL');
  assert.equal(decision.overridable, true);
  assert.equal(decision.evidence.consecutiveCriticalSamples, 3);
  assert.equal(decision.causes.length, 1);
  assert.equal(decision.causes[0].cleanupEligible, true);
  assert.ok(decision.evidence.samples.every((s) => typeof s.critical === 'boolean'));
  record('sustained', '3 consecutive critical of required 3', decision);
  contractVariants['rejected-sustained-critical'] = decision;
});

test('unknown/manual ownership explains pressure but is never cleanup-eligible', () => {
  const decision = evaluatePressureAdmission({
    machine: 'macwork',
    capture: capture('macwork', [sample(90, 0.95), sample(60, 0.96), sample(30, 0.99)], {
      processAttribution: {
        ...capture('macwork', []).processAttribution,
        groups: [
          group({ classification: 'unknown', slotId: undefined, runId: undefined }),
          group({ classification: 'manual', rootPid: 200 }),
          group({ classification: 'active', rootPid: 300 }),
          group({ classification: 'stale', rootPid: 400 }),
        ],
      },
    }),
    config: CONFIG,
    now: NOW,
  });
  assert.equal(decision.outcome, 'rejected');
  const byClass = Object.fromEntries(decision.causes.map((c) => [c.classification, c]));
  assert.equal(byClass.unknown.cleanupEligible, false);
  assert.equal(byClass.manual.cleanupEligible, false);
  assert.equal(byClass.active.cleanupEligible, false);
  assert.equal(byClass.stale.cleanupEligible, true);
  record('unknown-ownership', 'sustained with unknown/manual/active/stale causes', decision);
});

test('stale: newest sample older than the freshness window fails closed', () => {
  const decision = evaluatePressureAdmission({
    machine: 'macwork',
    capture: capture('macwork', [sample(400, 0.3), sample(300, 0.3)]),
    config: CONFIG,
    now: NOW,
  });
  assert.equal(decision.outcome, 'rejected');
  assert.equal(decision.state, 'stale');
  assert.equal(decision.code, 'PRESSURE_EVIDENCE_STALE');
  assert.equal(decision.overridable, false);
  record('stale', 'newest sample 300s old with 150s limit', decision);
  contractVariants['rejected-stale'] = decision;
});

test('unavailable: missing capture, offline machine, and empty history fail closed', () => {
  const missing = evaluatePressureAdmission({
    machine: 'ghost',
    capture: undefined,
    config: CONFIG,
    now: NOW,
  });
  assert.equal(missing.outcome, 'rejected');
  assert.equal(missing.state, 'unavailable');
  assert.equal(missing.code, 'PRESSURE_EVIDENCE_UNAVAILABLE');
  assert.equal(missing.overridable, false);

  const offline = evaluatePressureAdmission({
    machine: 'macwork',
    capture: capture('macwork', [sample(30, 0.3)], { online: false }),
    config: CONFIG,
    now: NOW,
  });
  assert.equal(offline.outcome, 'rejected');
  assert.equal(offline.code, 'PRESSURE_EVIDENCE_UNAVAILABLE');

  const empty = evaluatePressureAdmission({
    machine: 'macwork',
    capture: capture('macwork', []),
    config: CONFIG,
    now: NOW,
  });
  assert.equal(empty.outcome, 'rejected');
  assert.equal(empty.code, 'PRESSURE_EVIDENCE_UNAVAILABLE');
  record('unavailable', 'no capture / offline / empty history', missing);
  contractVariants['rejected-unavailable'] = missing;
});

const SUSTAINED_HISTORY = [sample(90, 0.95), sample(60, 0.96), sample(30, 0.99)];

test('override: valid current generation + reason + principal admits one dispatch', () => {
  const generation = pressureGenerationForSample('macwork', SUSTAINED_HISTORY.at(-1));
  assert.ok(generation);
  const decision = evaluatePressureAdmission({
    machine: 'macwork',
    capture: capture('macwork', SUSTAINED_HISTORY),
    config: CONFIG,
    override: { machine: 'macwork', pressureGeneration: generation, reason: 'urgent hotfix' },
    principalId: 'principal-arthur',
    now: NOW,
  });
  assert.equal(decision.outcome, 'admitted');
  assert.equal(decision.state, 'override');
  assert.equal(decision.override?.principalId, 'principal-arthur');
  assert.equal(decision.override?.scope, 'single-dispatch');
  assert.equal(decision.override?.pressureGeneration, generation);
  record('override-accepted', 'sustained + matching-generation override', decision);
  contractVariants['admitted-override'] = decision;
});

test('override race: a new sample between preview and execute stales the override', () => {
  const previewGeneration = pressureGenerationForSample('macwork', SUSTAINED_HISTORY.at(-1));
  assert.ok(previewGeneration);
  const advancedHistory = [...SUSTAINED_HISTORY, sample(5, 0.99, { sampleId: 101 })];
  const decision = evaluatePressureAdmission({
    machine: 'macwork',
    capture: capture('macwork', advancedHistory),
    config: CONFIG,
    override: {
      machine: 'macwork',
      pressureGeneration: previewGeneration,
      reason: 'urgent hotfix',
    },
    principalId: 'principal-arthur',
    now: NOW,
  });
  assert.equal(decision.outcome, 'rejected');
  assert.equal(decision.code, 'PRESSURE_OVERRIDE_STALE');
  assert.notEqual(decision.evidence.generation, previewGeneration);
  record('override-stale-race', 'generation advanced after preview', decision);
  contractVariants['rejected-override-stale'] = decision;
});

test('override: wrong machine and empty reason are rejected with stable codes', () => {
  const generation = pressureGenerationForSample('macwork', SUSTAINED_HISTORY.at(-1))!;
  const mismatch = evaluatePressureAdmission({
    machine: 'macwork',
    capture: capture('macwork', SUSTAINED_HISTORY),
    config: CONFIG,
    override: { machine: 'mini', pressureGeneration: generation, reason: 'urgent' },
    principalId: 'principal-arthur',
    now: NOW,
  });
  assert.equal(mismatch.outcome, 'rejected');
  assert.equal(mismatch.code, 'PRESSURE_OVERRIDE_MISMATCH');
  contractVariants['rejected-override-mismatch'] = mismatch;

  const emptyReason = evaluatePressureAdmission({
    machine: 'macwork',
    capture: capture('macwork', SUSTAINED_HISTORY),
    config: CONFIG,
    override: { machine: 'macwork', pressureGeneration: generation, reason: '   ' },
    principalId: 'principal-arthur',
    now: NOW,
  });
  assert.equal(emptyReason.outcome, 'rejected');
  assert.equal(emptyReason.code, 'PRESSURE_OVERRIDE_REASON_REQUIRED');
  contractVariants['rejected-override-reason-required'] = emptyReason;
  record('override-mismatch', 'override bound to a different machine', mismatch);
});

test('override on a fail-closed rejection is ignored, not honored', () => {
  const decision = evaluatePressureAdmission({
    machine: 'ghost',
    capture: undefined,
    config: CONFIG,
    override: { machine: 'ghost', pressureGeneration: 'anything', reason: 'urgent' },
    principalId: 'principal-arthur',
    now: NOW,
  });
  assert.equal(decision.outcome, 'rejected');
  assert.equal(decision.code, 'PRESSURE_EVIDENCE_UNAVAILABLE');
  assert.match(decision.reason, /override was ignored/i);
});

test('override without a resolved principal throws — never silently unaudited', () => {
  assert.throws(
    () =>
      evaluatePressureAdmission({
        machine: 'macwork',
        capture: capture('macwork', SUSTAINED_HISTORY),
        config: CONFIG,
        override: { machine: 'macwork', pressureGeneration: 'g', reason: 'urgent' },
        now: NOW,
      }),
    /principalId is required/,
  );
});

test('restart: online=null or a restored-only ring is charts-only, never authorizes', () => {
  // Node has not reconnected this boot: online null, even with a critical ring.
  const offlineRestored = evaluatePressureAdmission({
    machine: 'macwork',
    capture: capture('macwork', SUSTAINED_HISTORY, {
      online: null,
      historyFreshness: {
        source: 'restored',
        latestSampleAt: SUSTAINED_HISTORY.at(-1)!.collectedAt,
        ageMs: 30_000,
        stale: false,
      },
    }),
    config: CONFIG,
    now: NOW,
  });
  assert.equal(offlineRestored.outcome, 'rejected');
  assert.equal(offlineRestored.code, 'PRESSURE_EVIDENCE_UNAVAILABLE');

  // Node reconnected (online true) but no LIVE sample yet: the ring is still
  // the restored one and must not authorize, green or critical.
  const onlineRestored = evaluatePressureAdmission({
    machine: 'macwork',
    capture: capture('macwork', [sample(30, 0.2)], {
      historyFreshness: {
        source: 'restored',
        latestSampleAt: sample(30, 0.2).collectedAt,
        ageMs: 30_000,
        stale: false,
      },
    }),
    config: CONFIG,
    now: NOW,
  });
  assert.equal(onlineRestored.outcome, 'rejected');
  assert.equal(onlineRestored.code, 'PRESSURE_EVIDENCE_UNAVAILABLE');
  assert.match(onlineRestored.reason, /no live pressure sample/);
  record('restart-restored-ring', 'restored ring before first live sample', onlineRestored);
});

test('malformed samples are excluded: future-dated and out-of-range never decide', () => {
  // A future-dated critical sample cannot fake sustained pressure.
  const futureCritical = sample(-300, 0.99, { sampleId: 999 });
  const decision = evaluatePressureAdmission({
    machine: 'macwork',
    capture: capture('macwork', [sample(90, 0.3), sample(60, 0.3), futureCritical]),
    config: CONFIG,
    now: NOW,
  });
  assert.equal(decision.outcome, 'admitted');
  assert.equal(decision.state, 'green');
  assert.ok(decision.evidence.samples.every((s) => s.collectedAt !== futureCritical.collectedAt));

  // Out-of-range ratios (>1) are dropped; an all-invalid ring fails closed.
  const bogus = sample(30, 0.5, { pressure: { cpu: 3, memory: 0.4, disk: 0.5 } });
  const allInvalid = evaluatePressureAdmission({
    machine: 'macwork',
    capture: capture('macwork', [bogus]),
    config: CONFIG,
    now: NOW,
  });
  assert.equal(allInvalid.outcome, 'rejected');
  assert.equal(allInvalid.code, 'PRESSURE_EVIDENCE_UNAVAILABLE');
  assert.match(allInvalid.reason, /malformed/);
});

test('validation fixture adapter forces a self-consistent sustained rejection', () => {
  withTempControlHome(() => {
    const config: PressureAdmissionConfig = { ...CONFIG, validationFixtureMachine: 'macwork' };
    const decisions = capturePressureAdmissionDecisionsLightweight(['macwork', 'mini'], {
      config,
    });
    const decision = decisions.get('macwork');
    assert.equal(decision?.outcome, 'rejected');
    if (decision?.outcome !== 'rejected') return;
    assert.equal(decision.code, 'PRESSURE_SUSTAINED_CRITICAL');
    assert.equal(decision.overridable, true);
    assert.equal(decision.evidence.validationFixture, true);
    assert.equal(
      decision.evidence.consecutiveCriticalSamples,
      config.minConsecutiveCriticalSamples,
    );
    assert.equal(decision.evidence.samples.length, config.minConsecutiveCriticalSamples);
    assert.ok(decision.evidence.samples.every((s) => s.critical));
    assert.ok(decision.evidence.generation?.includes('validation-fixture'));
    // Synthetic anchor stays inside the freshness window.
    assert.ok(
      Date.now() - Date.parse(decision.evidence.latestSampleAt ?? '') <= CONFIG.staleAfterMs,
    );
    // Other machines keep their real decisions (empty test rings: unavailable).
    const other = decisions.get('mini');
    assert.equal(other?.outcome, 'rejected');
    assert.equal(other?.outcome === 'rejected' && other.code, 'PRESSURE_EVIDENCE_UNAVAILABLE');
    record('validation-fixture', 'adapter-forced sustained rejection', decision);
  });
});

test('warm start: rehydrated ring + one live sample sustains without waiting three live beats', () => {
  // Two critical samples persisted before a gateway restart, one fresh live
  // sample after it. The policy evaluates the ring as a whole — admission
  // does not need three NEW 30s samples to see sustained pressure.
  const restored = [sample(90, 0.95), sample(60, 0.96)];
  const live = sample(20, 0.99, { generation: 'gen-after-restart', sampleId: 1 });
  const decision = evaluatePressureAdmission({
    machine: 'macwork',
    capture: capture('macwork', [...restored, live]),
    config: CONFIG,
    now: NOW,
  });
  assert.equal(decision.outcome, 'rejected');
  assert.equal(decision.code, 'PRESSURE_SUSTAINED_CRITICAL');
  assert.equal(decision.evidence.consecutiveCriticalSamples, 3);
  record('warm-start-restored-ring', 'restored 2-critical ring + 1 live critical sample', decision);
});

test('sample criticality covers each dimension threshold', () => {
  const base = sample(30, 0.3);
  assert.equal(isPressureSampleCritical(base, CONFIG), false);
  assert.equal(isPressureSampleCritical(sample(30, 0.9), CONFIG), true);
  assert.equal(
    isPressureSampleCritical(
      { pressure: { cpu: 0.1, memory: 0.9, disk: 0.1, load1: 0.1 } },
      CONFIG,
    ),
    true,
  );
  assert.equal(
    isPressureSampleCritical({ pressure: { cpu: 0.1, memory: 0.1, disk: 0.95 } }, CONFIG),
    true,
  );
  assert.equal(
    isPressureSampleCritical(
      { pressure: { cpu: 0.1, memory: 0.1, disk: 0.1, load1: 1.6 } },
      CONFIG,
    ),
    true,
  );
});

test('contract completeness: disabled, preview-stale, and override-consumed variants', () => {
  withTempControlHome(() => {
    runWithSessionOriginator(
      {
        id: 'principal-arthur',
        subject: { type: 'person', displayName: 'Arthur' },
        roles: [{ role: 'admin', scope: { kind: 'global' } }],
      },
      () => setPressureAdmissionEnabled({ enabled: false }),
    );
    const disabled = capturePressureAdmissionDecisionsLightweight(['macwork']).get('macwork');
    assert.equal(disabled?.outcome, 'admitted');
    assert.equal(disabled?.outcome === 'admitted' && disabled.state, 'disabled');
    contractVariants['admitted-disabled'] = disabled;
  });

  const greenDecision = evaluatePressureAdmission({
    machine: 'macwork',
    capture: capture('macwork', [sample(90, 0.3), sample(60, 0.3), sample(30, 0.3)]),
    config: CONFIG,
    now: NOW,
  });
  const previewStale = resolveExecutePressureOutcome({
    machine: 'macwork',
    decision: greenDecision,
    admissionRef: { machine: 'macwork', pressureGeneration: 'older-generation' },
  }).rejection;
  assert.equal(previewStale?.code, 'PRESSURE_PREVIEW_STALE');
  contractVariants['rejected-preview-stale'] = previewStale;

  const generation = pressureGenerationForSample('macwork', SUSTAINED_HISTORY.at(-1))!;
  const overrideDecision = evaluatePressureAdmission({
    machine: 'macwork',
    capture: capture('macwork', SUSTAINED_HISTORY),
    config: CONFIG,
    override: { machine: 'macwork', pressureGeneration: generation, reason: 'urgent' },
    principalId: 'principal-arthur',
    now: NOW,
  });
  const consumed = resolveExecutePressureOutcome({
    machine: 'macwork',
    decision: overrideDecision,
    storedOverride: {
      machine: 'macwork',
      pressureGeneration: generation,
      reason: 'urgent',
      principalId: 'principal-arthur',
      requestedAt: new Date(NOW).toISOString(),
      scope: 'single-dispatch',
      consumed: { attemptKey: 'run:attempt-1', consumedAt: new Date(NOW).toISOString() },
    },
    attemptKey: 'run:attempt-2',
  }).rejection;
  assert.equal(consumed?.code, 'PRESSURE_OVERRIDE_CONSUMED');
  contractVariants['rejected-override-consumed'] = consumed;
});

test('config resolution rejects malformed env overrides and applies valid ones', () => {
  const resolved = resolvePressureAdmissionConfig({
    FARMSLOT_PRESSURE_MIN_CONSECUTIVE_CRITICAL: '5',
    FARMSLOT_PRESSURE_CPU_CRITICAL: '0.8',
  } as NodeJS.ProcessEnv);
  assert.equal(resolved.minConsecutiveCriticalSamples, 5);
  assert.equal(resolved.cpuCritical, 0.8);
  assert.equal(resolved.validationFixtureMachine, null);
  assert.throws(
    () =>
      resolvePressureAdmissionConfig({
        FARMSLOT_PRESSURE_STALE_AFTER_MS: 'not-a-number',
      } as NodeJS.ProcessEnv),
    /FARMSLOT_PRESSURE_STALE_AFTER_MS/,
  );
});

after(() => {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  writeFileSync(
    path.join(ARTIFACT_DIR, 'pressure-admission-matrix.json'),
    JSON.stringify(
      {
        spec: 'MANUAL-000109',
        config: CONFIG,
        evaluatedAt: new Date(NOW).toISOString(),
        cases: matrixRows,
      },
      null,
      2,
    ),
  );
  writeFileSync(
    path.join(ARTIFACT_DIR, 'pressure-admission-contract.json'),
    JSON.stringify(
      {
        spec: 'MANUAL-000109',
        description:
          'Every wire variant of the shared pressure-admission contract, produced by the gateway policy over deterministic fixtures.',
        wireTypes: {
          reference: { machine: 'macwork', pressureGeneration: 'machine|gen|id|iso' },
          override: {
            machine: 'macwork',
            pressureGeneration: 'machine|gen|id|iso',
            reason: 'operator reason',
          },
        },
        variants: contractVariants,
      },
      null,
      2,
    ),
  );
});

test('config validation: ratio thresholds are capped at 1 and counts must be whole', () => {
  assert.throws(
    () =>
      resolvePressureAdmissionConfig({
        FARMSLOT_PRESSURE_CPU_CRITICAL: '1.2',
      } as NodeJS.ProcessEnv),
    /FARMSLOT_PRESSURE_CPU_CRITICAL.*no greater than 1/,
  );
  assert.throws(
    () =>
      resolvePressureAdmissionConfig({
        FARMSLOT_PRESSURE_MEMORY_CRITICAL: '2',
      } as NodeJS.ProcessEnv),
    /FARMSLOT_PRESSURE_MEMORY_CRITICAL.*no greater than 1/,
  );
  assert.throws(
    () =>
      resolvePressureAdmissionConfig({
        FARMSLOT_PRESSURE_DISK_CRITICAL: '1.01',
      } as NodeJS.ProcessEnv),
    /FARMSLOT_PRESSURE_DISK_CRITICAL.*no greater than 1/,
  );
  assert.throws(
    () =>
      resolvePressureAdmissionConfig({
        FARMSLOT_PRESSURE_MIN_CONSECUTIVE_CRITICAL: '2.5',
      } as NodeJS.ProcessEnv),
    /FARMSLOT_PRESSURE_MIN_CONSECUTIVE_CRITICAL.*positive integer/,
  );
  // load1 stays unbounded positive (>1 is a meaningful over-subscription).
  assert.equal(
    resolvePressureAdmissionConfig({
      FARMSLOT_PRESSURE_LOAD1_CRITICAL: '3.5',
    } as NodeJS.ProcessEnv).load1Critical,
    3.5,
  );
});
