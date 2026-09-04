import type {
  ResourcePosture,
  ResourcePostureGateChoice,
  ResourcePosturePlan,
  ResourcePostureTransition,
  RunResourcePostureState,
} from '../contracts/resource-posture.js';
import type { RuntimeCapabilityProofRequirement } from '../contracts/runtime-capabilities.js';

import { Methods } from './registry.js';

export const RuntimePostureMethods = {
  status: Methods.RUNTIME_POSTURE_STATUS,
  preview: Methods.RUNTIME_POSTURE_PREVIEW,
  apply: Methods.RUNTIME_POSTURE_APPLY,
} as const;

export interface RuntimePostureStatusParams {
  runId: string;
}

export interface RuntimePostureStatusResult {
  runId: string;
  slotId: string | null;
  /** Persisted desired policy re-merged with live lease and provider state. */
  state: RunResourcePostureState;
}

export interface RuntimePosturePreviewParams {
  runId: string;
  /** Omit to preview the run's currently persisted posture. */
  posture?: ResourcePosture;
  /** Operator vocabulary; wins over `posture` at an operator wait. */
  gateChoice?: ResourcePostureGateChoice;
  /** Overrides the registry's stored proof plan for an `active` preview. */
  proofRequirements?: RuntimeCapabilityProofRequirement[];
}

export type RuntimePosturePreviewResult = ResourcePosturePlan;

export interface RuntimePostureApplyParams extends RuntimePosturePreviewParams {
  /** Replaying the same id returns the stored transition without provider actions. */
  operationId?: string;
}

export interface RuntimePostureApplyResult {
  ok: boolean;
  status: RunResourcePostureState;
  transition: ResourcePostureTransition;
}
