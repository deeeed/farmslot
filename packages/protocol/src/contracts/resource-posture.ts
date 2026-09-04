/**
 * Run resource posture (ADR-054).
 *
 * The Gateway owns one semantic posture per run describing which runtime
 * capabilities should be live at the current lifecycle boundary. Clients render
 * the Gateway's decision — desired disposition, observed provider state, the
 * winning policy source — and never resolve policy themselves.
 */
import type {
  RuntimeCapabilityAcquireConflict,
  RuntimeCapabilityLeaseOwner,
} from './runtime-capabilities.js';

/** Semantic lifecycle intent. Never derived from run status, step names, or slot phases. */
export const RESOURCE_POSTURES = ['active', 'operator-wait', 'parked', 'terminal'] as const;
export type ResourcePosture = (typeof RESOURCE_POSTURES)[number];

/** Operator vocabulary at a human gate; each resolves to a posture plus proof plan. */
export const RESOURCE_POSTURE_GATE_CHOICES = [
  'keep-for-validation',
  'minimize',
  'free-slot',
  'project-default',
] as const;
export type ResourcePostureGateChoice = (typeof RESOURCE_POSTURE_GATE_CHOICES)[number];

/**
 * Dispatch-time preset for every durable wait of a run. `project-default` is
 * excluded: a preset that defers to the lower precedence levels is a no-op, and
 * omitting the field already expresses it.
 */
export const RESOURCE_POSTURE_WAIT_POLICIES = [
  'keep-for-validation',
  'minimize',
  'free-slot',
] as const;
export type ResourcePostureWaitPolicy = (typeof RESOURCE_POSTURE_WAIT_POLICIES)[number];

/** Which precedence level produced the effective policy. */
export const RESOURCE_POSTURE_POLICY_SOURCES = [
  'gate-choice',
  'run-dispatch',
  'project-default',
  'framework-default',
] as const;
export type ResourcePosturePolicySource = (typeof RESOURCE_POSTURE_POLICY_SOURCES)[number];

/** What the Gateway intends for a capability. Distinct from what is observed. */
export const RESOURCE_POSTURE_DISPOSITIONS = ['acquired', 'warm', 'stopped'] as const;
export type ResourcePostureDesiredDisposition = (typeof RESOURCE_POSTURE_DISPOSITIONS)[number];

/**
 * What the provider is actually doing. A released lease with a live keep-warm
 * provider is `running`, not `stopped`.
 */
export const RESOURCE_POSTURE_OBSERVED_STATES = [
  'running',
  'stopped',
  'unhealthy',
  'transitioning',
  'unknown',
] as const;
export type ResourcePostureObservedState = (typeof RESOURCE_POSTURE_OBSERVED_STATES)[number];

/** Per-provider project retention policy for a posture. */
export const RESOURCE_POSTURE_RETENTIONS = ['retain', 'warm', 'stop'] as const;
export type ResourcePostureRetention = (typeof RESOURCE_POSTURE_RETENTIONS)[number];

/**
 * Postures a project may configure retention for. `active` is derived from the
 * current proof plan and `parked` delegates to machine parking, so neither
 * accepts a retention override.
 */
export const RESOURCE_POSTURE_RETENTION_BOUNDARIES = ['operator-wait', 'terminal'] as const;
export type ResourcePostureRetentionBoundary =
  (typeof RESOURCE_POSTURE_RETENTION_BOUNDARIES)[number];

/** Project-level posture defaults; per-provider `retention` overrides these. */
export interface ProjectResourcePostureConfig {
  defaults?: Partial<Record<ResourcePostureRetentionBoundary, ResourcePostureRetention>>;
}

export interface ResourcePostureCapabilityState {
  capabilityId: string;
  desiredDisposition: ResourcePostureDesiredDisposition;
  observedState: ResourcePostureObservedState;
  policySource: ResourcePosturePolicySource;
  reason: string;
  leaseId?: string;
  owner?: RuntimeCapabilityLeaseOwner;
  /** Deadline until which a released provider stays live. */
  warmUntil?: string;
  lastTransitionAt?: string;
  releaseEffects: string[];
  cleanupFailure?: string;
}

export type ResourcePostureRejection =
  | {
      kind: 'park-ineligible';
      /** Machine-parking eligibility code, passed through unchanged. */
      code: string;
      reason: string;
    }
  | {
      kind: 'capability-unavailable';
      capabilityId: string;
      reason: string;
      conflict: RuntimeCapabilityAcquireConflict;
    }
  | { kind: 'invalid-request'; reason: string };

export const RESOURCE_POSTURE_TRANSITION_OUTCOMES = [
  'in-progress',
  'applied',
  'idempotent',
  'partial',
  'rejected',
] as const;
export type ResourcePostureTransitionOutcome =
  (typeof RESOURCE_POSTURE_TRANSITION_OUTCOMES)[number];

export interface ResourcePostureTransitionFailure {
  capabilityId: string;
  leaseId?: string;
  reason: string;
}

export interface ResourcePostureTransition {
  /** Caller-supplied `operationId` when present, so a replay returns this record. */
  id: string;
  posture: ResourcePosture;
  policySource: ResourcePosturePolicySource;
  gateChoice?: ResourcePostureGateChoice;
  requestedAt: string;
  completedAt?: string;
  outcome: ResourcePostureTransitionOutcome;
  effects: string[];
  progress: { total: number; completed: number };
  failures: ResourcePostureTransitionFailure[];
  rejection?: ResourcePostureRejection;
}

/** Exact effect of applying a posture, returned before an operator commits. */
export interface ResourcePosturePlan {
  runId: string;
  slotId: string | null;
  posture: ResourcePosture;
  policySource: ResourcePosturePolicySource;
  reason: string;
  acquire: ResourcePostureCapabilityState[];
  retain: ResourcePostureCapabilityState[];
  warm: ResourcePostureCapabilityState[];
  stop: ResourcePostureCapabilityState[];
  /** Declared release effects of everything this plan would stop. */
  effects: string[];
  rejection?: ResourcePostureRejection;
}

/** Persisted on the run so a reconnecting client sees the same thing. */
export interface RunResourcePostureState {
  posture: ResourcePosture;
  policySource: ResourcePosturePolicySource;
  gateChoice?: ResourcePostureGateChoice;
  waitPolicy?: ResourcePostureWaitPolicy;
  capabilities: ResourcePostureCapabilityState[];
  /** ADR-038: no posture resolved here stops a gate-held worker. */
  workerRetained: boolean;
  lastTransition?: ResourcePostureTransition;
  updatedAt: string;
}

/** Gate choice -> posture. The only place this mapping exists. */
export function postureForGateChoice(
  choice: Exclude<ResourcePostureGateChoice, 'project-default'>,
): ResourcePosture {
  if (choice === 'keep-for-validation') return 'active';
  if (choice === 'free-slot') return 'parked';
  return 'operator-wait';
}

export function isResourcePosture(value: unknown): value is ResourcePosture {
  return RESOURCE_POSTURES.includes(value as ResourcePosture);
}

export function isResourcePostureGateChoice(value: unknown): value is ResourcePostureGateChoice {
  return RESOURCE_POSTURE_GATE_CHOICES.includes(value as ResourcePostureGateChoice);
}

export function isResourcePostureWaitPolicy(value: unknown): value is ResourcePostureWaitPolicy {
  return RESOURCE_POSTURE_WAIT_POLICIES.includes(value as ResourcePostureWaitPolicy);
}
