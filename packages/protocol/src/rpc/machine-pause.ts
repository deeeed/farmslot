import type {
  MachineParkCurrentStep,
  MachineParkRecord,
  MachineParkResourceManifest,
  MachineParkSlotDisposition,
  MachinePauseMode,
  RunStatus,
} from '../contracts/index.js';

import { Methods } from './registry.js';
import type { ResourcePressureMachine } from './resources.js';

export const MachinePauseMethods = {
  preview: Methods.MACHINE_PAUSE_PREVIEW,
  execute: Methods.MACHINE_PAUSE_EXECUTE,
  status: Methods.MACHINE_PAUSE_STATUS,
  restore: Methods.MACHINE_PAUSE_RESTORE,
} as const;

export type MachinePauseSelector =
  | { kind: 'all' }
  | { kind: 'include'; runIds: string[] }
  | { kind: 'exclude'; runIds: string[] };

/** Exact generation reviewed by the operator; mutation must reject stale refs. */
export interface MachinePauseReviewedTarget {
  runId: string;
  generation: number;
}

export type MachinePauseRecoveryPolicy =
  | { kind: 'orchestration-only'; supported: true }
  | {
      kind: 'runner-session-reload';
      supported: boolean;
      runnerId: string;
      reason?: string;
    };

export type MachinePauseEligibility =
  | { eligible: true; code: string; reason: string }
  | { eligible: false; code: string; reason: string };

export interface MachinePausePreviewRun {
  runId: string;
  generation: number;
  /** Backend-resolved selector result; clients must not reapply include/exclude policy. */
  selected: boolean;
  slotId: string | null;
  status: RunStatus;
  currentStep: MachineParkCurrentStep | null;
  /** Backend-owned verdict; clients must not reimplement eligibility policy. */
  eligibility: MachinePauseEligibility;
  /** Whether executing this park would free the run's slot for dispatch. */
  slotDisposition: MachineParkSlotDisposition;
  recoveryPolicy: MachinePauseRecoveryPolicy;
  resourceManifest: MachineParkResourceManifest;
}

export interface MachinePausePreviewParams {
  machine: string;
  mode: MachinePauseMode;
  selector: MachinePauseSelector;
}

export interface MachinePausePreviewResult {
  previewId: string;
  machine: string;
  mode: MachinePauseMode;
  selector: MachinePauseSelector;
  createdAt: string;
  runs: MachinePausePreviewRun[];
  eligibleCount: number;
  rejectedCount: number;
  pressure?: ResourcePressureMachine;
}

export interface MachinePauseExecuteParams {
  machine: string;
  mode: MachinePauseMode;
  previewId: string;
  reviewedTargets: MachinePauseReviewedTarget[];
  operationId?: string;
}

export interface MachinePauseExecuteResult {
  ok: boolean;
  outcome: 'complete' | 'partial' | 'failed';
  operationId: string;
  machine: string;
  mode: MachinePauseMode;
  records: MachineParkRecord[];
  pressure?: ResourcePressureMachine;
}

export interface MachinePauseStatusParams {
  machine: string;
}

export interface MachinePauseStatusResult {
  machine: string;
  records: MachineParkRecord[];
  pressure?: ResourcePressureMachine;
}

export type MachinePauseRestoreParams =
  | {
      machine: string;
      selector: MachinePauseSelector;
      execute?: false;
    }
  | {
      machine: string;
      selector: MachinePauseSelector;
      execute: true;
      previewId: string;
      reviewedTargets: MachinePauseReviewedTarget[];
      operationId?: string;
    };

/**
 * Where a restore would put the run back. ADR-054 restores a freed slot into
 * the ORIGINAL slot only: `available` is false when another run holds it, and
 * the verdict is then `RESTORE_SLOT_TAKEN`. Cross-slot re-dispatch is a
 * separate decision, so there is deliberately no alternative target here.
 */
export interface MachinePauseRestoreTarget {
  slotId: string;
  /** `freed` means the slot must be re-bound first; `retained` means it never left. */
  disposition: MachineParkSlotDisposition;
  /** Whether that exact slot can take the run back right now. */
  available: boolean;
}

export interface MachinePauseRestorePreviewRun {
  runId: string;
  generation: number;
  /** Backend-resolved selector result; clients must not reapply include/exclude policy. */
  selected: boolean;
  /** Backend-owned verdict; clients must not reimplement restore eligibility policy. */
  eligibility: MachinePauseEligibility;
  /** Backend-resolved restore target; clients must not pick a slot themselves. */
  restoreTarget: MachinePauseRestoreTarget;
  record: MachineParkRecord;
}

export interface MachinePauseRestoreResult {
  ok: boolean;
  outcome: 'preview' | 'complete' | 'partial' | 'failed';
  execute: boolean;
  previewId: string;
  operationId?: string;
  machine: string;
  selector: MachinePauseSelector;
  runs: MachinePauseRestorePreviewRun[];
  records: MachineParkRecord[];
  pressure?: ResourcePressureMachine;
}
