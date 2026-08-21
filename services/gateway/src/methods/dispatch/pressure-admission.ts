// pressure-admission.ts — one sustained-pressure dispatch admission policy
// (MANUAL-000109), consumed by dispatch.candidates, dispatch.preview, queue
// selection, FIND_SLOT bindings, and dispatch execution.
//
// The policy (`evaluatePressureAdmission`) is PURE over one captured
// ResourcePressureMachine. Every admission read evaluates in-memory
// health/history and the last attribution already produced by an explicit
// resource snapshot. It never resolves slot resources or queries tmux. Nothing
// here samples processes, builds a second history ring, or mutates existing
// work; a rejection only withholds a NEW dispatch. All thresholds live here;
// clients render the resulting decision verbatim.

import {
  DEFAULT_PRESSURE_STALE_AFTER_MS,
  type NodePressureHistorySample,
  type PressureAdmissionCause,
  type PressureAdmissionDecision,
  type PressureAdmissionEvidence,
  type PressureAdmissionRejected,
  type PressureAdmissionSample,
  type PressureDispatchOverride,
  type ResourcePressureMachine,
} from '@farmslot/protocol';

import {
  getMachineHealth,
  getMachinePressureHistory,
  getMachinePressureHistoryFreshness,
} from '../../fleet/node-health.js';
import { getCachedMachinePressureAttribution } from '../../fleet/pressure-attribution-cache.js';

import { isPressureAdmissionEnabled } from './pressure-admission-control.js';

export interface PressureAdmissionConfig {
  /** Normalized (0..1) per-dimension critical thresholds for one sample. */
  cpuCritical: number;
  memoryCritical: number;
  diskCritical: number;
  /** Load average over cores; >1 means more runnable work than cores. */
  load1Critical: number;
  /** Consecutive critical samples in the bounded ring before rejection. */
  minConsecutiveCriticalSamples: number;
  /** Newest sample older than this fails closed as stale evidence. */
  staleAfterMs: number;
  /** Ring tail carried on decision evidence for operators. */
  evidenceSampleWindow: number;
  /** Attributed causes carried on a rejection. */
  maxCauses: number;
  /**
   * Validation-only fixture machine. Consumed by the CAPTURE ADAPTER (never
   * the pure policy): the adapter substitutes a synthetic online capture with
   * a sustained-critical ring for this exact machine, and stamps the
   * resulting evidence `validationFixture: true`. Enabled only via
   * FARMSLOT_PRESSURE_VALIDATION_FIXTURE_MACHINE on the gateway process; it
   * cannot be reached from any RPC input.
   */
  validationFixtureMachine: string | null;
}

const DEFAULT_CONFIG: PressureAdmissionConfig = {
  cpuCritical: 0.9,
  memoryCritical: 0.9,
  diskCritical: 0.95,
  load1Critical: 1.5,
  minConsecutiveCriticalSamples: 3,
  // Node metrics beat every 30s; five missed beats means the evidence no
  // longer describes the machine that would host the new worker. Shared with
  // the history-freshness metadata on resource.pressure.snapshot.
  staleAfterMs: DEFAULT_PRESSURE_STALE_AFTER_MS,
  evidenceSampleWindow: 8,
  maxCauses: 5,
  validationFixtureMachine: null,
};

/** Node clocks can drift; a sample this far in the future is malformed data,
 * not skew, and is excluded from evaluation. */
const FUTURE_SAMPLE_SKEW_MS = 30_000;

function envNumber(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  options?: { integer?: boolean; max?: number },
): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (
    !Number.isFinite(parsed) ||
    parsed <= 0 ||
    (options?.integer && !Number.isInteger(parsed)) ||
    (options?.max !== undefined && parsed > options.max)
  ) {
    const bound = options?.max !== undefined ? ` no greater than ${options.max}` : '';
    throw new Error(
      `${key} must be a positive ${options?.integer ? 'integer' : 'number'}${bound}, got '${raw}'`,
    );
  }
  return parsed;
}

/** Centralized, env-overridable thresholds. Resolved per evaluation batch. */
export function resolvePressureAdmissionConfig(
  env: NodeJS.ProcessEnv = process.env,
): PressureAdmissionConfig {
  return {
    cpuCritical: envNumber(env, 'FARMSLOT_PRESSURE_CPU_CRITICAL', DEFAULT_CONFIG.cpuCritical, {
      max: 1,
    }),
    memoryCritical: envNumber(
      env,
      'FARMSLOT_PRESSURE_MEMORY_CRITICAL',
      DEFAULT_CONFIG.memoryCritical,
      {
        max: 1,
      },
    ),
    diskCritical: envNumber(env, 'FARMSLOT_PRESSURE_DISK_CRITICAL', DEFAULT_CONFIG.diskCritical, {
      max: 1,
    }),
    load1Critical: envNumber(env, 'FARMSLOT_PRESSURE_LOAD1_CRITICAL', DEFAULT_CONFIG.load1Critical),
    minConsecutiveCriticalSamples: envNumber(
      env,
      'FARMSLOT_PRESSURE_MIN_CONSECUTIVE_CRITICAL',
      DEFAULT_CONFIG.minConsecutiveCriticalSamples,
      { integer: true },
    ),
    staleAfterMs: envNumber(env, 'FARMSLOT_PRESSURE_STALE_AFTER_MS', DEFAULT_CONFIG.staleAfterMs),
    evidenceSampleWindow: DEFAULT_CONFIG.evidenceSampleWindow,
    maxCauses: DEFAULT_CONFIG.maxCauses,
    validationFixtureMachine: env.FARMSLOT_PRESSURE_VALIDATION_FIXTURE_MACHINE?.trim() || null,
  };
}

export function isPressureSampleCritical(
  sample: Pick<NodePressureHistorySample, 'pressure'>,
  config: PressureAdmissionConfig,
): boolean {
  const p = sample.pressure;
  return (
    p.cpu >= config.cpuCritical ||
    p.memory >= config.memoryCritical ||
    p.disk >= config.diskCritical ||
    (p.load1 !== undefined && p.load1 >= config.load1Critical)
  );
}

function ratioInRange(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * A sample the policy may trust: ratios in [0,1], nonnegative load values,
 * parseable timestamp that is not future-dated beyond clock-skew tolerance.
 * Malformed samples are excluded from evaluation and evidence so garbage in
 * the ring can neither fake criticality nor mask it.
 */
export function isValidPressureSample(sample: NodePressureHistorySample, now: number): boolean {
  const collectedAtMs = Date.parse(sample.collectedAt);
  if (!Number.isFinite(collectedAtMs) || collectedAtMs > now + FUTURE_SAMPLE_SKEW_MS) return false;
  const p = sample.pressure;
  if (!ratioInRange(p.cpu) || !ratioInRange(p.memory) || !ratioInRange(p.disk)) return false;
  if (p.load1 !== undefined && (!Number.isFinite(p.load1) || p.load1 < 0)) return false;
  if (p.load5 !== undefined && (!Number.isFinite(p.load5) || p.load5 < 0)) return false;
  return true;
}

/** Preview identity: opaque digest of the newest sample in the ring. */
export function pressureGenerationForSample(
  machine: string,
  sample: NodePressureHistorySample | undefined,
): string | null {
  if (!sample) return null;
  return `${machine}|${sample.generation ?? 'gauge'}|${sample.sampleId ?? '-'}|${sample.collectedAt}`;
}

function toEvidenceSample(
  sample: NodePressureHistorySample,
  config: PressureAdmissionConfig,
): PressureAdmissionSample {
  return {
    collectedAt: sample.collectedAt,
    ...(sample.generation !== undefined ? { generation: sample.generation } : {}),
    ...(sample.sampleId !== undefined ? { sampleId: sample.sampleId } : {}),
    cpu: sample.pressure.cpu,
    memory: sample.pressure.memory,
    disk: sample.pressure.disk,
    ...(sample.pressure.load1 !== undefined ? { load1: sample.pressure.load1 } : {}),
    critical: isPressureSampleCritical(sample, config),
  };
}

function cleanupEligibleClassification(classification: string): boolean {
  // Unknown/manual ownership explains pressure but is never a cleanup target;
  // active is someone's live work. Only retained/stale managed trees qualify.
  return classification === 'retained' || classification === 'stale';
}

function buildCauses(
  capture: ResourcePressureMachine | undefined,
  config: PressureAdmissionConfig,
): PressureAdmissionCause[] {
  if (!capture) return [];
  return capture.processAttribution.groups.slice(0, config.maxCauses).map((group) => ({
    process: group.topExecutable.split('/').at(-1) || group.topExecutable,
    processCount: group.processCount,
    cpuPercent: group.cpuPercent,
    rssBytes: group.rssBytes,
    classification: group.classification,
    confidence: group.confidence,
    ...(group.slotId ? { slotId: group.slotId } : {}),
    ...(group.runId ? { runId: group.runId } : {}),
    cleanupEligible: cleanupEligibleClassification(group.classification),
  }));
}

function buildEvidence(
  machine: string,
  history: NodePressureHistorySample[],
  config: PressureAdmissionConfig,
  now: number,
): PressureAdmissionEvidence {
  const tail = history.slice(-config.evidenceSampleWindow);
  const latest = history.at(-1);
  let consecutive = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (!isPressureSampleCritical(history[index], config)) break;
    consecutive += 1;
  }
  return {
    machine,
    generation: pressureGenerationForSample(machine, latest),
    evaluatedAt: new Date(now).toISOString(),
    samples: tail.map((sample) => toEvidenceSample(sample, config)),
    consecutiveCriticalSamples: consecutive,
    requiredConsecutiveCriticalSamples: config.minConsecutiveCriticalSamples,
    staleAfterMs: config.staleAfterMs,
    latestSampleAt: latest?.collectedAt ?? null,
  };
}

export interface EvaluatePressureAdmissionInput {
  machine: string;
  /** One captured snapshot; every slot on the machine shares this evidence. */
  capture: ResourcePressureMachine | undefined;
  config?: PressureAdmissionConfig;
  /** Explicit one-dispatch override to validate against the current generation. */
  override?: PressureDispatchOverride;
  /**
   * Authenticated origin recorded on an accepted override. Required whenever
   * `override` is set — the policy is pure and never resolves ambient auth
   * context itself. Trusted in-process callers pass 'system' explicitly.
   */
  principalId?: string;
  now?: number;
}

/**
 * The single admission policy — pure over the given capture, with no fixture
 * or environment awareness. Fails closed when authoritative health data is
 * unavailable, the machine is not positively online, or evidence is stale;
 * distinguishes transient from sustained critical pressure by consecutive
 * valid samples in the bounded ring; and admits a rejected machine only
 * through a fresh, generation-bound, principal-audited override.
 */
export function evaluatePressureAdmission(
  input: EvaluatePressureAdmissionInput,
): PressureAdmissionDecision {
  const config = input.config ?? resolvePressureAdmissionConfig();
  const now = input.now ?? Date.now();
  const { machine, capture } = input;
  if (input.override && !input.principalId) {
    throw new Error(
      'evaluatePressureAdmission: principalId is required when validating an override — resolve the authenticated origin at the call site',
    );
  }

  const reject = (
    state: PressureAdmissionRejected['state'],
    code: PressureAdmissionRejected['code'],
    reason: string,
    overridable: boolean,
    evidence: PressureAdmissionEvidence,
  ): PressureAdmissionRejected => ({
    outcome: 'rejected',
    machine,
    state,
    code,
    reason,
    causes: buildCauses(capture, config),
    evidence,
    overridable,
  });

  const base = decideWithoutOverride();
  if (base.outcome === 'admitted' || !input.override) return base;
  return applyOverride(base, input.override);

  function decideWithoutOverride(): PressureAdmissionDecision {
    const rawHistory = capture?.history ?? [];
    const history = rawHistory.filter((sample) => isValidPressureSample(sample, now));
    const droppedInvalid = rawHistory.length - history.length;
    const evidence = buildEvidence(machine, history, config, now);
    if (!capture) {
      return reject(
        'unavailable',
        'PRESSURE_EVIDENCE_UNAVAILABLE',
        `No pressure evidence is available for machine ${machine}; dispatch admission fails closed.`,
        false,
        evidence,
      );
    }
    // Admission requires a POSITIVELY online machine. `online: null` means the
    // node has not (re)connected this boot — restored history is charts-only
    // then, even if its ring looks green or critical.
    if (capture.online !== true) {
      return reject(
        'unavailable',
        'PRESSURE_EVIDENCE_UNAVAILABLE',
        capture.online === false
          ? `Machine ${machine} is offline; dispatch admission fails closed.`
          : `Machine ${machine} has not reconnected since the gateway started; restored history is charts-only and dispatch admission fails closed.`,
        false,
        evidence,
      );
    }
    // Online alone is not enough: a node flips online at reconnect BEFORE its
    // first new sample, so a restored ring could otherwise authorize.
    // Admission requires the ring itself to be live this boot.
    if (capture.historyFreshness?.source !== 'live') {
      return reject(
        'unavailable',
        'PRESSURE_EVIDENCE_UNAVAILABLE',
        `Machine ${machine} has no live pressure sample this gateway session (history source: ${capture.historyFreshness?.source ?? 'unknown'}); restored history is charts-only and dispatch admission fails closed.`,
        false,
        evidence,
      );
    }
    const latest = history.at(-1);
    if (!latest) {
      return reject(
        'unavailable',
        'PRESSURE_EVIDENCE_UNAVAILABLE',
        droppedInvalid > 0
          ? `Machine ${machine} has no valid pressure samples (${droppedInvalid} malformed sample(s) excluded); dispatch admission fails closed.`
          : `Machine ${machine} has no pressure samples yet; dispatch admission fails closed.`,
        false,
        evidence,
      );
    }
    const ageMs = now - Date.parse(latest.collectedAt);
    if (!Number.isFinite(ageMs) || ageMs > config.staleAfterMs) {
      return reject(
        'stale',
        'PRESSURE_EVIDENCE_STALE',
        `Newest pressure sample for machine ${machine} is ${Number.isFinite(ageMs) ? `${Math.round(ageMs / 1000)}s old` : 'unreadable'} (limit ${Math.round(config.staleAfterMs / 1000)}s); dispatch admission fails closed until fresh samples arrive.`,
        false,
        evidence,
      );
    }
    if (evidence.consecutiveCriticalSamples >= config.minConsecutiveCriticalSamples) {
      return reject(
        'sustained-critical',
        'PRESSURE_SUSTAINED_CRITICAL',
        `Machine ${machine} has been critical for ${evidence.consecutiveCriticalSamples} consecutive samples (threshold ${config.minConsecutiveCriticalSamples}); new dispatches are rejected until pressure recedes or an operator overrides this one dispatch.`,
        true,
        evidence,
      );
    }
    if (isPressureSampleCritical(latest, config)) {
      return { outcome: 'admitted', machine, state: 'transient', evidence };
    }
    return { outcome: 'admitted', machine, state: 'green', evidence };
  }

  function applyOverride(
    rejection: PressureAdmissionRejected,
    override: PressureDispatchOverride,
  ): PressureAdmissionDecision {
    const evidence = rejection.evidence;
    if (!rejection.overridable) {
      return {
        ...rejection,
        reason: `${rejection.reason} The submitted override was ignored: this rejection fails closed and cannot be overridden.`,
      };
    }
    if (override.machine !== machine) {
      return {
        ...rejection,
        code: 'PRESSURE_OVERRIDE_MISMATCH',
        reason: `Override is bound to machine ${override.machine} but the dispatch targets ${machine}; submit a fresh override for this machine.`,
      };
    }
    if (!override.reason.trim()) {
      return {
        ...rejection,
        code: 'PRESSURE_OVERRIDE_REASON_REQUIRED',
        reason: 'Override requires a non-empty operator reason.',
      };
    }
    if (!evidence.generation || override.pressureGeneration !== evidence.generation) {
      return {
        ...rejection,
        code: 'PRESSURE_OVERRIDE_STALE',
        reason: `Override was issued against pressure generation ${override.pressureGeneration} but the machine is now at ${evidence.generation ?? 'none'}; review the fresh decision and re-submit the override deliberately.`,
      };
    }
    return {
      outcome: 'admitted',
      machine,
      state: 'override',
      evidence,
      override: {
        machine,
        pressureGeneration: override.pressureGeneration,
        reason: override.reason.trim(),
        // Guarded non-null at the top of evaluatePressureAdmission.
        principalId: input.principalId!,
        requestedAt: new Date(now).toISOString(),
        scope: 'single-dispatch',
      },
    };
  }
}

// ─── Capture adapters ───

function disabledDecisions(
  machines: string[],
  now: number,
): Map<string, PressureAdmissionDecision> {
  const disabledAt = new Date(now).toISOString();
  return new Map(
    machines.map((machine) => [
      machine,
      {
        outcome: 'admitted' as const,
        machine,
        state: 'disabled' as const,
        evidence: {
          machine,
          generation: null,
          evaluatedAt: disabledAt,
          samples: [],
          consecutiveCriticalSamples: 0,
          requiredConsecutiveCriticalSamples: 0,
          staleAfterMs: 0,
          latestSampleAt: null,
        },
      },
    ]),
  );
}

/** In-memory capture: pure reads of the ring, machine health, and freshness. */
function historyOnlyCapture(machine: string): ResourcePressureMachine {
  const health = getMachineHealth(machine);
  const cachedAttribution = getCachedMachinePressureAttribution(machine);
  return {
    machine,
    online: health?.online ?? null,
    headroom: health?.headroom ?? 'unknown',
    severity: 'ok',
    concerns: [],
    history: getMachinePressureHistory(machine),
    historyFreshness: getMachinePressureHistoryFreshness(machine),
    processAttribution: cachedAttribution ?? {
      unavailableReason:
        'No cached process attribution is available; open resource details for an explicit snapshot.',
      truncated: false,
      ancestryTruncated: false,
      sampledProcesses: 0,
      totalProcesses: 0,
      maxEntries: 0,
      omittedGroups: 0,
      classCounts: { active: 0, retained: 0, stale: 0, manual: 0, unknown: 0 },
      managedGroupCount: 0,
      managedClassCounts: { active: 0, retained: 0, stale: 0, manual: 0, unknown: 0 },
      groups: [],
    },
    slots: { total: 0, ready: 0, busy: 0, working: 0, manual: 0, disabled: 0 },
    resources: {
      total: 0,
      byStatus: { unknown: 0, running: 0, stopped: 0, error: 0, stale: 0 },
      cleanupCandidates: 0,
    },
  };
}

/**
 * Validation-only fixture capture: a synthetic ONLINE machine whose ring is
 * sustained-critical, fed to the unmodified production policy by the explicit
 * env-controlled adapter. The sample anchor is quantized so the resulting
 * generation stays stable long enough to bind and exercise an override.
 */
function validationFixtureCapture(
  machine: string,
  config: PressureAdmissionConfig,
  now: number,
): ResourcePressureMachine {
  // 60s-quantized anchor: at most 60s old (inside the 150s freshness window)
  // and stable long enough to bind and exercise an override. The whole
  // sequence is generated chronologically FROM the anchor so ordering can
  // never interleave with unrelated timestamps.
  const anchorMs = Math.floor(now / 60_000) * 60_000;
  const samples: NodePressureHistorySample[] = Array.from(
    { length: config.minConsecutiveCriticalSamples },
    (_, index) => ({
      generation: 'validation-fixture',
      sampleId: index,
      collectedAt: new Date(
        anchorMs - (config.minConsecutiveCriticalSamples - 1 - index) * 1_000,
      ).toISOString(),
      pressure: {
        cpu: config.cpuCritical,
        memory: config.memoryCritical,
        disk: config.diskCritical,
        load1: config.load1Critical,
      },
      cpuPercent: config.cpuCritical * 100,
      memoryPercent: config.memoryCritical * 100,
      diskPercent: config.diskCritical * 100,
      loadAvg1: config.load1Critical,
      loadAvg5: config.load1Critical,
    }),
  );
  return {
    machine,
    online: true,
    headroom: 'red',
    severity: 'critical',
    concerns: [],
    historyFreshness: {
      source: 'live',
      latestSampleAt: samples.at(-1)?.collectedAt ?? null,
      ageMs: Math.max(0, now - anchorMs),
      stale: false,
    },
    history: samples,
    processAttribution: {
      unavailableReason: 'Validation fixture has no process attribution.',
      truncated: false,
      ancestryTruncated: false,
      sampledProcesses: 0,
      totalProcesses: 0,
      maxEntries: 0,
      omittedGroups: 0,
      classCounts: { active: 0, retained: 0, stale: 0, manual: 0, unknown: 0 },
      managedGroupCount: 0,
      managedClassCounts: { active: 0, retained: 0, stale: 0, manual: 0, unknown: 0 },
      groups: [],
    },
    slots: { total: 0, ready: 0, busy: 0, working: 0, manual: 0, disabled: 0 },
    resources: {
      total: 0,
      byStatus: { unknown: 0, running: 0, stopped: 0, error: 0, stale: 0 },
      cleanupCandidates: 0,
    },
  };
}

function stampValidationFixture(decision: PressureAdmissionDecision): PressureAdmissionDecision {
  return { ...decision, evidence: { ...decision.evidence, validationFixture: true } };
}

function evaluateForMachine(
  machine: string,
  capture: ResourcePressureMachine | undefined,
  config: PressureAdmissionConfig,
  now: number,
  options?: { override?: PressureDispatchOverride; principalId?: string },
): PressureAdmissionDecision {
  const fixture = config.validationFixtureMachine === machine;
  const decision = evaluatePressureAdmission({
    machine,
    capture: fixture ? validationFixtureCapture(machine, config, now) : capture,
    config,
    now,
    // The override applies only to the machine it names — other machines keep
    // their own base decision. The preview/execute boundaries report a
    // mismatch when the SELECTED machine differs from the override's.
    ...(options?.override?.machine === machine ? { override: options.override } : {}),
    ...(options?.principalId ? { principalId: options.principalId } : {}),
  });
  return fixture ? stampValidationFixture(decision) : decision;
}

type PressureCaptureOptions = {
  override?: PressureDispatchOverride;
  principalId?: string;
  config?: PressureAdmissionConfig;
};

function captureInMemoryPressureAdmissionDecisions(
  machines: string[],
  options?: PressureCaptureOptions,
): Map<string, PressureAdmissionDecision> {
  const uniqueMachines = [...new Set(machines)];
  if (uniqueMachines.length === 0) return new Map();
  const now = Date.now();
  // Durable kill switch: when off, every machine is admitted with
  // state='disabled' and no pressure read happens. Sampling, history, and
  // charts continue elsewhere; only dispatch prevention pauses.
  if (!isPressureAdmissionEnabled()) return disabledDecisions(uniqueMachines, now);
  const config = options?.config ?? resolvePressureAdmissionConfig();
  return new Map(
    uniqueMachines.map((machine) => [
      machine,
      evaluateForMachine(machine, historyOnlyCapture(machine), config, now, options),
    ]),
  );
}

/** Standard admission capture over in-memory history and cached attribution. */
export function capturePressureAdmissionDecisions(
  machines: string[],
  options?: PressureCaptureOptions,
): Map<string, PressureAdmissionDecision> {
  return captureInMemoryPressureAdmissionDecisions(machines, options);
}

/**
 * Synchronous lightweight capture for high-frequency automatic paths (queue
 * ticks, engine binds, execution): identical policy and kill switch, pure
 * in-memory reads, never the heavy snapshot or fresh attribution work.
 */
export function capturePressureAdmissionDecisionsLightweight(
  machines: string[],
  options?: PressureCaptureOptions,
): Map<string, PressureAdmissionDecision> {
  return captureInMemoryPressureAdmissionDecisions(machines, options);
}

/** Error code carried by pressure-rejected dispatch attempts. */
export const PRESSURE_ADMISSION_REJECTED_CODE = 'PRESSURE_ADMISSION_REJECTED';

export class PressureAdmissionRejectedError extends Error {
  public readonly code = PRESSURE_ADMISSION_REJECTED_CODE;
  constructor(public readonly decision: PressureAdmissionRejected) {
    super(formatPressureRejection(decision));
    this.name = 'PressureAdmissionRejectedError';
  }
}

/** Compact operator-facing summary used in thrown errors and step details. */
export function formatPressureRejection(decision: PressureAdmissionRejected): string {
  const causes = decision.causes
    .slice(0, 3)
    .map(
      (cause) => `${cause.process} (${cause.classification}, ${cause.cpuPercent.toFixed(0)}% cpu)`,
    )
    .join(', ');
  return `[${decision.code}] ${decision.reason}${causes ? ` Top causes: ${causes}.` : ''}`;
}
