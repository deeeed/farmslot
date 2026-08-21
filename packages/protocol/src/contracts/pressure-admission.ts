// Sustained-pressure dispatch admission contract (MANUAL-000109).
//
// One backend-owned decision shared by dispatch preview, automatic slot
// selection, and dispatch execution. Clients render these decisions and never
// re-derive thresholds. The evidence is the Goal 1 node-pressure history and
// process attribution — no dispatch-side sampler exists.

import type { ProcessAttributionConfidence, ProcessOwnershipClass } from '../rpc/resources.js';

/** Machine-level admission state derived from the bounded pressure sample
 * ring. `disabled` means the gateway-owned kill switch is off: dispatch is
 * admitted without pressure evaluation while sampling/history/charts continue. */
export type PressureAdmissionState =
  | 'green'
  | 'transient'
  | 'sustained-critical'
  | 'unavailable'
  | 'stale'
  | 'override'
  | 'disabled';

/** Stable machine-readable rejection codes. Never rename — clients and
 * operators key automation off these. */
export const PRESSURE_ADMISSION_REJECTION_CODES = [
  'PRESSURE_SUSTAINED_CRITICAL',
  'PRESSURE_EVIDENCE_UNAVAILABLE',
  'PRESSURE_EVIDENCE_STALE',
  'PRESSURE_PREVIEW_STALE',
  'PRESSURE_OVERRIDE_STALE',
  'PRESSURE_OVERRIDE_MISMATCH',
  'PRESSURE_OVERRIDE_REASON_REQUIRED',
  'PRESSURE_OVERRIDE_CONSUMED',
] as const;

export type PressureAdmissionRejectionCode = (typeof PRESSURE_ADMISSION_REJECTION_CODES)[number];

/** One normalized sample from the bounded machine pressure ring. Ratios are
 * 0..1 (load1 is load average over cores, so it can exceed 1). */
export interface PressureAdmissionSample {
  collectedAt: string;
  /** Process-inventory generation the sample was collected under, when known. */
  generation?: string;
  sampleId?: number;
  cpu: number;
  memory: number;
  disk: number;
  load1?: number;
  /** True when this sample crossed the policy's critical thresholds. */
  critical: boolean;
}

/** Attributed cause behind the pressure, from Goal 1 process attribution.
 * Unknown/manual ownership can explain pressure but is never a cleanup target. */
export interface PressureAdmissionCause {
  process: string;
  processCount: number;
  cpuPercent: number;
  rssBytes: number;
  classification: ProcessOwnershipClass;
  confidence: ProcessAttributionConfidence;
  slotId?: string;
  runId?: string;
  /** False for unknown/manual ownership — those rows must never be rendered as
   * cleanup targets, only as explanation. */
  cleanupEligible: boolean;
}

/** Evidence backing an admission decision. `generation` is the preview
 * identity: execution rejects decisions bound to a generation that no longer
 * matches the current ring. */
export interface PressureAdmissionEvidence {
  machine: string;
  /** Opaque identity of the latest sample (generation/sampleId/collectedAt
   * digest). Null when no sample exists — nothing to bind an override to. */
  generation: string | null;
  evaluatedAt: string;
  /** Tail of the bounded ring the policy evaluated, oldest first. */
  samples: PressureAdmissionSample[];
  consecutiveCriticalSamples: number;
  requiredConsecutiveCriticalSamples: number;
  /** Milliseconds after which the newest sample counts as stale. */
  staleAfterMs: number;
  latestSampleAt: string | null;
  /** Present when a validation-only fixture forced this machine's state.
   * Real fleet evidence never carries this flag. */
  validationFixture?: true;
}

/** Preview identity carried from an admitted preview into execution. FIND_SLOT
 * validates it against fresh evidence BEFORE claiming a slot and, on success,
 * consumes it by stamping `consumedAt` — so a long PREPARE cannot turn a
 * green-to-green generation move into a failure at launch time. Execution
 * still recomputes fresh evidence and rejects if pressure became unsafe; an
 * UNconsumed ref reaching execution (a path that skipped FIND_SLOT
 * validation) is rejected with PRESSURE_PREVIEW_STALE as defense in depth.
 * `consumedAt` is gateway-stamped only; client-supplied values are stripped. */
export interface PressureAdmissionReference {
  machine: string;
  pressureGeneration: string;
  consumedAt?: string;
}

/** One-dispatch operator override request. Bound to an exact machine and the
 * pressure generation the operator saw; execution recomputes and rejects the
 * override when the generation moved. */
export interface PressureDispatchOverride {
  machine: string;
  pressureGeneration: string;
  reason: string;
}

/** Audit record stamped by the gateway when an override is accepted. */
export interface PressureOverrideAudit extends PressureDispatchOverride {
  /** Authenticated principal that requested the override ('system' for
   * in-process maintenance callers, which cannot originate from an ingress). */
  principalId: string;
  requestedAt: string;
  /** An override never outlives the single dispatch it was issued for. */
  scope: 'single-dispatch';
  /**
   * Durable consumption record, persisted at the launch gate BEFORE the
   * runner starts (intent before effect). Bound to one exact DISPATCH engine
   * attempt: a same-attempt provider retry sees its own attempt key and stays
   * idempotent; a replay or new attempt rejects with
   * PRESSURE_OVERRIDE_CONSUMED and needs a fresh override.
   */
  consumed?: {
    attemptKey: string;
    consumedAt: string;
  };
}

export interface PressureAdmissionAdmitted {
  outcome: 'admitted';
  machine: string;
  state: Extract<PressureAdmissionState, 'green' | 'transient' | 'override' | 'disabled'>;
  evidence: PressureAdmissionEvidence;
  /** Present only when state='override': the accepted one-shot override. */
  override?: PressureOverrideAudit;
}

export interface PressureAdmissionRejected {
  outcome: 'rejected';
  machine: string;
  state: Extract<PressureAdmissionState, 'sustained-critical' | 'unavailable' | 'stale'>;
  code: PressureAdmissionRejectionCode;
  /** Operator-facing reason. Backend-owned; clients render it verbatim. */
  reason: string;
  causes: PressureAdmissionCause[];
  evidence: PressureAdmissionEvidence;
  /** True when a fresh explicit override against `evidence.generation` can
   * admit one dispatch. False for unavailable/stale evidence — fail closed. */
  overridable: boolean;
}

export type PressureAdmissionDecision = PressureAdmissionAdmitted | PressureAdmissionRejected;

/** Gateway-owned durable kill switch for pressure-based dispatch prevention.
 * Default enabled. Disabling stops only pressure rejection/override prompts;
 * sampling, history, and charts continue. Never affects slot ownership,
 * capability, runner, branch, or other safety checks. */
export interface PressureAdmissionControlState {
  enabled: boolean;
  /** ISO timestamp of the last change; null when still at the default. */
  updatedAt: string | null;
  /** Authenticated principal that made the last change; null at the default. */
  updatedBy: string | null;
}

export interface PressureAdmissionSetEnabledParams {
  enabled: boolean;
}

export type PressureAdmissionGetResult = PressureAdmissionControlState;
export type PressureAdmissionSetEnabledResult = PressureAdmissionControlState;

export function isPressureAdmissionRejected(
  decision: PressureAdmissionDecision | undefined,
): decision is PressureAdmissionRejected {
  return decision?.outcome === 'rejected';
}
