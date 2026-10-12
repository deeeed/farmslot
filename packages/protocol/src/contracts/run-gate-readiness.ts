import type {
  NoChangeGatePayload,
  ReadyGatePayload,
  ReviewGatePayload,
  RunDecisionPayload,
} from './runs.js';

export type RunGatePrerequisite =
  | 'deterministic'
  | 'acceptance'
  | 'evidence'
  | 'review'
  | 'lifecycle';

export interface RunGatePrerequisiteReason {
  code: string;
  prerequisite: RunGatePrerequisite;
  message: string;
  /** Task-relative artifact, registered criterion or declared check reference. */
  reference?: string;
  /** Existing action that can resolve the prerequisite. */
  actionId?: string;
}

/** A projection of the current decision's checked inputs, never approval authority. */
export interface RunGateInputIdentity {
  runId: string;
  generation: number;
  headSha?: string | null;
  packageHash?: string | null;
}

export interface RunGateReadiness {
  state: 'collecting' | 'not-ready' | 'ready';
  identity: RunGateInputIdentity;
  reasons: RunGatePrerequisiteReason[];
}

/** Gate payloads whose advancing actions require the shared prerequisite evaluation. */
export function isPrerequisiteGatePayload(
  payload?: RunDecisionPayload,
): payload is ReadyGatePayload | ReviewGatePayload | NoChangeGatePayload {
  return payload?.kind === 'ready' || payload?.kind === 'review' || payload?.kind === 'no-change';
}
