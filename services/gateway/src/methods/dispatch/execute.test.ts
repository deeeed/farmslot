import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { NodePressureHistorySample, ResourcePressureMachine } from '@farmslot/protocol';

import { enforceDispatchPressureGate, resolveExecutePressureOutcome } from './execute.js';
import {
  evaluatePressureAdmission,
  type PressureAdmissionConfig,
  pressureGenerationForSample,
} from './pressure-admission.js';

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
  sampleId: number,
): NodePressureHistorySample {
  return {
    generation: 'gen-a',
    sampleId,
    collectedAt: new Date(NOW - secondsBeforeNow * 1_000).toISOString(),
    pressure: { cpu, memory: 0.4, disk: 0.5, load1: 0.5 },
    cpuPercent: cpu * 100,
    memoryPercent: 40,
    diskPercent: 50,
    loadAvg1: 4,
    loadAvg5: 4,
  };
}

function capture(machine: string, history: NodePressureHistorySample[]): ResourcePressureMachine {
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
      sampledProcesses: 0,
      totalProcesses: 0,
      maxEntries: 64,
      omittedGroups: 0,
      classCounts: { active: 0, retained: 0, stale: 0, manual: 0, unknown: 0 },
      managedGroupCount: 0,
      managedClassCounts: { active: 0, retained: 0, stale: 0, manual: 0, unknown: 0 },
      groups: [],
    },
    slots: { total: 1, ready: 1, busy: 0, working: 0, manual: 0, disabled: 0 },
    resources: {
      total: 0,
      byStatus: { unknown: 0, running: 0, stopped: 0, error: 0, stale: 0 },
      cleanupCandidates: 0,
    },
  };
}

const GREEN_PREVIEW_HISTORY = [sample(90, 0.3, 1), sample(60, 0.3, 2), sample(30, 0.3, 3)];
const GREEN_EXECUTE_HISTORY = [...GREEN_PREVIEW_HISTORY, sample(5, 0.3, 4)];
const SUSTAINED_HISTORY = [sample(90, 0.95, 1), sample(60, 0.96, 2), sample(30, 0.99, 3)];

const auditArtifact: Record<string, unknown> = {};

test('execute recomputes: stale preview generation rejects even green-to-green', () => {
  const previewGeneration = pressureGenerationForSample('macwork', GREEN_PREVIEW_HISTORY.at(-1))!;
  const freshDecision = evaluatePressureAdmission({
    machine: 'macwork',
    capture: capture('macwork', GREEN_EXECUTE_HISTORY),
    config: CONFIG,
    now: NOW,
  });
  assert.equal(freshDecision.outcome, 'admitted');
  const outcome = resolveExecutePressureOutcome({
    machine: 'macwork',
    decision: freshDecision,
    admissionRef: { machine: 'macwork', pressureGeneration: previewGeneration },
  });
  assert.ok(outcome.rejection);
  assert.equal(outcome.rejection?.code, 'PRESSURE_PREVIEW_STALE');
  assert.equal(outcome.rejection?.overridable, false);
  // The rejection embeds the FRESH evidence so the operator can refresh.
  assert.equal(
    outcome.rejection?.evidence.generation,
    pressureGenerationForSample('macwork', GREEN_EXECUTE_HISTORY.at(-1)),
  );
  auditArtifact.stalePreviewRejection = {
    previewGeneration,
    freshGeneration: outcome.rejection?.evidence.generation,
    rejection: outcome.rejection,
  };
});

test('execute recomputes: matching preview generation admits without an override', () => {
  const freshDecision = evaluatePressureAdmission({
    machine: 'macwork',
    capture: capture('macwork', GREEN_EXECUTE_HISTORY),
    config: CONFIG,
    now: NOW,
  });
  const currentGeneration = pressureGenerationForSample('macwork', GREEN_EXECUTE_HISTORY.at(-1))!;
  const outcome = resolveExecutePressureOutcome({
    machine: 'macwork',
    decision: freshDecision,
    admissionRef: { machine: 'macwork', pressureGeneration: currentGeneration },
  });
  assert.equal(outcome.rejection, null);
  assert.equal(outcome.acceptedOverride, null);
});

test('execute accepts only a current explicit override, bound to machine/generation/reason', () => {
  const currentGeneration = pressureGenerationForSample('macwork', SUSTAINED_HISTORY.at(-1))!;
  const freshDecision = evaluatePressureAdmission({
    machine: 'macwork',
    capture: capture('macwork', SUSTAINED_HISTORY),
    config: CONFIG,
    override: {
      machine: 'macwork',
      pressureGeneration: currentGeneration,
      reason: 'single urgent hotfix approved by operator',
    },
    principalId: 'principal-arthur',
    now: NOW,
  });
  const outcome = resolveExecutePressureOutcome({
    machine: 'macwork',
    decision: freshDecision,
    storedOverride: {
      machine: 'macwork',
      pressureGeneration: currentGeneration,
      reason: 'single urgent hotfix approved by operator',
      principalId: 'principal-arthur',
      requestedAt: new Date(NOW).toISOString(),
      scope: 'single-dispatch',
    },
  });
  assert.equal(outcome.rejection, null);
  assert.ok(outcome.acceptedOverride);
  assert.equal(outcome.acceptedOverride?.principalId, 'principal-arthur');
  assert.equal(outcome.acceptedOverride?.scope, 'single-dispatch');
  auditArtifact.acceptedOverride = outcome.acceptedOverride;
});

test('execute rejects an override issued against an older generation', () => {
  const oldGeneration = pressureGenerationForSample('macwork', SUSTAINED_HISTORY[1])!;
  const freshDecision = evaluatePressureAdmission({
    machine: 'macwork',
    capture: capture('macwork', SUSTAINED_HISTORY),
    config: CONFIG,
    override: { machine: 'macwork', pressureGeneration: oldGeneration, reason: 'urgent' },
    principalId: 'principal-arthur',
    now: NOW,
  });
  const outcome = resolveExecutePressureOutcome({
    machine: 'macwork',
    decision: freshDecision,
    storedOverride: {
      machine: 'macwork',
      pressureGeneration: oldGeneration,
      reason: 'urgent',
      principalId: 'principal-arthur',
      requestedAt: new Date(NOW).toISOString(),
      scope: 'single-dispatch',
    },
  });
  assert.equal(outcome.rejection?.code, 'PRESSURE_OVERRIDE_STALE');
  auditArtifact.staleOverrideRejection = outcome.rejection;
});

test('execute rejects an override bound to a different machine', () => {
  const freshDecision = evaluatePressureAdmission({
    machine: 'macwork',
    capture: capture('macwork', SUSTAINED_HISTORY),
    config: CONFIG,
    now: NOW,
  });
  const outcome = resolveExecutePressureOutcome({
    machine: 'macwork',
    decision: freshDecision,
    storedOverride: {
      machine: 'mini',
      pressureGeneration: 'mini|gen-a|3|2026-08-21T09:59:30.000Z',
      reason: 'urgent',
      principalId: 'principal-arthur',
      requestedAt: new Date(NOW).toISOString(),
      scope: 'single-dispatch',
    },
  });
  assert.equal(outcome.rejection?.code, 'PRESSURE_OVERRIDE_MISMATCH');
});

test('an accepted override exempts only itself — no admission ref recheck', () => {
  const currentGeneration = pressureGenerationForSample('macwork', SUSTAINED_HISTORY.at(-1))!;
  const freshDecision = evaluatePressureAdmission({
    machine: 'macwork',
    capture: capture('macwork', SUSTAINED_HISTORY),
    config: CONFIG,
    override: { machine: 'macwork', pressureGeneration: currentGeneration, reason: 'urgent' },
    principalId: 'principal-arthur',
    now: NOW,
  });
  const outcome = resolveExecutePressureOutcome({
    machine: 'macwork',
    decision: freshDecision,
    admissionRef: { machine: 'macwork', pressureGeneration: 'older-generation' },
    storedOverride: {
      machine: 'macwork',
      pressureGeneration: currentGeneration,
      reason: 'urgent',
      principalId: 'principal-arthur',
      requestedAt: new Date(NOW).toISOString(),
      scope: 'single-dispatch',
    },
  });
  assert.equal(outcome.rejection, null);
  assert.ok(outcome.acceptedOverride);
});

function storedOverrideFor(generation: string, consumed?: { attemptKey: string }) {
  return {
    machine: 'macwork',
    pressureGeneration: generation,
    reason: 'urgent',
    principalId: 'principal-arthur',
    requestedAt: new Date(NOW).toISOString(),
    scope: 'single-dispatch' as const,
    ...(consumed
      ? { consumed: { attemptKey: consumed.attemptKey, consumedAt: new Date(NOW).toISOString() } }
      : {}),
  };
}

test('one-shot override: same attempt is idempotent, another attempt rejects consumed', () => {
  const generation = pressureGenerationForSample('macwork', SUSTAINED_HISTORY.at(-1))!;
  const decision = evaluatePressureAdmission({
    machine: 'macwork',
    capture: capture('macwork', SUSTAINED_HISTORY),
    config: CONFIG,
    override: { machine: 'macwork', pressureGeneration: generation, reason: 'urgent' },
    principalId: 'principal-arthur',
    now: NOW,
  });
  const sameAttempt = resolveExecutePressureOutcome({
    machine: 'macwork',
    decision,
    storedOverride: storedOverrideFor(generation, { attemptKey: 'run:100' }),
    attemptKey: 'run:100',
  });
  assert.equal(sameAttempt.rejection, null);
  assert.ok(sameAttempt.acceptedOverride);

  const replay = resolveExecutePressureOutcome({
    machine: 'macwork',
    decision,
    storedOverride: storedOverrideFor(generation, { attemptKey: 'run:100' }),
    attemptKey: 'run:200',
  });
  assert.equal(replay.rejection?.code, 'PRESSURE_OVERRIDE_CONSUMED');
  assert.equal(replay.rejection?.overridable, true);
});

test('one-shot override: a later green replay still rejects after consumption', () => {
  const generation = pressureGenerationForSample('macwork', SUSTAINED_HISTORY.at(-1))!;
  const greenDecision = evaluatePressureAdmission({
    machine: 'macwork',
    capture: capture('macwork', GREEN_EXECUTE_HISTORY),
    config: CONFIG,
    now: NOW,
  });
  assert.equal(greenDecision.outcome, 'admitted');

  const replay = resolveExecutePressureOutcome({
    machine: 'macwork',
    decision: greenDecision,
    storedOverride: storedOverrideFor(generation, { attemptKey: 'run:100' }),
    attemptKey: 'run:200',
  });
  assert.equal(replay.rejection?.code, 'PRESSURE_OVERRIDE_CONSUMED');
  assert.equal(replay.rejection?.overridable, true);

  const sameAttempt = resolveExecutePressureOutcome({
    machine: 'macwork',
    decision: greenDecision,
    storedOverride: storedOverrideFor(generation, { attemptKey: 'run:100' }),
    attemptKey: 'run:100',
  });
  assert.equal(sameAttempt.rejection, null);

  const disabledReplay = resolveExecutePressureOutcome({
    machine: 'macwork',
    decision: {
      outcome: 'admitted',
      machine: 'macwork',
      state: 'disabled',
      evidence: {
        machine: 'macwork',
        generation: null,
        evaluatedAt: new Date(NOW).toISOString(),
        samples: [],
        consecutiveCriticalSamples: 0,
        requiredConsecutiveCriticalSamples: 0,
        staleAfterMs: 0,
        latestSampleAt: null,
      },
    },
    storedOverride: storedOverrideFor(generation, { attemptKey: 'run:100' }),
    attemptKey: 'run:200',
  });
  assert.equal(disabledReplay.rejection, null);
});

test('an override bound to another machine rejects even when the target is green', () => {
  const greenDecision = evaluatePressureAdmission({
    machine: 'macwork',
    capture: capture('macwork', GREEN_EXECUTE_HISTORY),
    config: CONFIG,
    now: NOW,
  });
  assert.equal(greenDecision.outcome, 'admitted');
  const outcome = resolveExecutePressureOutcome({
    machine: 'macwork',
    decision: greenDecision,
    storedOverride: { ...storedOverrideFor('gen-x'), machine: 'mini' },
    attemptKey: 'run:100',
  });
  assert.equal(outcome.rejection?.code, 'PRESSURE_OVERRIDE_MISMATCH');
});

test('a FIND_SLOT-consumed preview identity does not stale-reject at execute', () => {
  const freshDecision = evaluatePressureAdmission({
    machine: 'macwork',
    capture: capture('macwork', GREEN_EXECUTE_HISTORY),
    config: CONFIG,
    now: NOW,
  });
  const outcome = resolveExecutePressureOutcome({
    machine: 'macwork',
    decision: freshDecision,
    admissionRef: {
      machine: 'macwork',
      pressureGeneration: 'older-generation',
      consumedAt: new Date(NOW).toISOString(),
    },
  });
  assert.equal(outcome.rejection, null);
});

test('launch gate integration: consumption persists durably before the gate returns', async () => {
  const generation = pressureGenerationForSample('macwork', SUSTAINED_HISTORY.at(-1))!;
  const decision = evaluatePressureAdmission({
    machine: 'macwork',
    capture: capture('macwork', SUSTAINED_HISTORY),
    config: CONFIG,
    override: { machine: 'macwork', pressureGeneration: generation, reason: 'urgent' },
    principalId: 'principal-arthur',
    now: NOW,
  });
  let captureCalls = 0;
  let persistResolved = false;
  let persistedPatch: { pressureOverride: { consumed?: { attemptKey: string } } } | null = null;
  let releasePersist: () => void = () => {};
  const persistDone = new Promise<void>((resolve) => {
    releasePersist = () => {
      persistResolved = true;
      resolve();
    };
  });
  const gate = enforceDispatchPressureGate({
    machine: 'macwork',
    runId: 'run-1',
    run: { pressureOverride: storedOverrideFor(generation) },
    attemptKey: 'run:100',
    deps: {
      capture: (machines) => {
        captureCalls += 1;
        return new Map(machines.map((machine) => [machine, decision]));
      },
      persistRun: async (_runId, patch) => {
        persistedPatch = patch;
        await persistDone;
      },
    },
  });
  // The gate must NOT resolve until the injected persistence resolves —
  // intent lands durably before any launch effect.
  const settledEarly = await Promise.race([
    gate.then(() => 'resolved'),
    new Promise((resolve) => setTimeout(() => resolve('pending'), 50)),
  ]);
  assert.equal(settledEarly, 'pending');
  releasePersist();
  await gate;
  assert.equal(persistResolved, true);
  assert.equal(captureCalls, 1);
  assert.equal(persistedPatch!.pressureOverride.consumed?.attemptKey, 'run:100');
  auditArtifact.gateIntegration = {
    persistAwaitedBeforeReturn: true,
    consumedAttemptKey: 'run:100',
  };

  // And a failing persistence fails the gate — never launch on unpersisted intent.
  await assert.rejects(
    enforceDispatchPressureGate({
      machine: 'macwork',
      runId: 'run-1',
      run: { pressureOverride: storedOverrideFor(generation) },
      attemptKey: 'run:100',
      deps: {
        capture: (machines) => new Map(machines.map((machine) => [machine, decision])),
        persistRun: async () => {
          throw new Error('disk full');
        },
      },
    }),
    /disk full/,
  );
});

test('missing decision fails closed at the last guard before launch', () => {
  const outcome = resolveExecutePressureOutcome({
    machine: 'macwork',
    decision: undefined,
  });
  assert.equal(outcome.rejection?.code, 'PRESSURE_EVIDENCE_UNAVAILABLE');
  assert.equal(outcome.rejection?.overridable, false);
  assert.equal(outcome.acceptedOverride, null);
});

after(() => {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  writeFileSync(
    path.join(ARTIFACT_DIR, 'pressure-override-audit.json'),
    JSON.stringify(
      {
        spec: 'MANUAL-000109',
        evaluatedAt: new Date(NOW).toISOString(),
        ...auditArtifact,
      },
      null,
      2,
    ),
  );
});

test('a submitted override is consumed even when current pressure no longer needs it', async () => {
  const greenDecision = evaluatePressureAdmission({
    machine: 'macwork',
    capture: capture('macwork', GREEN_EXECUTE_HISTORY),
    config: CONFIG,
    now: NOW,
  });
  assert.equal(greenDecision.outcome, 'admitted');
  let persisted: { pressureOverride: { consumed?: { attemptKey: string } } } | null = null;
  let info = '';
  await enforceDispatchPressureGate({
    machine: 'macwork',
    runId: 'run-1',
    run: { pressureOverride: storedOverrideFor('gen-old') },
    attemptKey: 'run:300',
    onInfo: (detail) => {
      info = detail;
    },
    deps: {
      capture: (machines) => new Map(machines.map((machine) => [machine, greenDecision])),
      persistRun: async (_runId, patch) => {
        persisted = patch;
      },
    },
  });
  assert.equal(persisted!.pressureOverride.consumed?.attemptKey, 'run:300');
  assert.match(info, /not required by current pressure/);
  assert.match(info, /consumed for dispatch attempt run:300/);

  // Same while the global guard is off: the authorization must not survive to
  // revive after re-enable.
  const disabledDecision = {
    outcome: 'admitted' as const,
    machine: 'macwork',
    state: 'disabled' as const,
    evidence: {
      machine: 'macwork',
      generation: null,
      evaluatedAt: new Date(NOW).toISOString(),
      samples: [],
      consecutiveCriticalSamples: 0,
      requiredConsecutiveCriticalSamples: 0,
      staleAfterMs: 0,
      latestSampleAt: null,
    },
  };
  persisted = null;
  await enforceDispatchPressureGate({
    machine: 'macwork',
    runId: 'run-1',
    run: { pressureOverride: storedOverrideFor('gen-old') },
    attemptKey: 'run:400',
    deps: {
      capture: (machines) => new Map(machines.map((machine) => [machine, disabledDecision])),
      persistRun: async (_runId, patch) => {
        persisted = patch;
      },
    },
  });
  assert.equal(persisted!.pressureOverride.consumed?.attemptKey, 'run:400');
});
