import type {
  EvalExperimentManifest,
  EvalPackageAxes,
  EvalTaskProfile,
  ResultPackageManifest,
} from '../contracts/evals.js';
import type { Run, SafetyTier } from '../contracts/index.js';

import { Methods } from './registry.js';

export const EvalMethods = {
  experimentCreate: Methods.EVAL_EXPERIMENT_CREATE,
  trialStart: Methods.EVAL_TRIAL_START,
  trialResultGet: Methods.EVAL_TRIAL_RESULT_GET,
  suiteCapGet: Methods.EVAL_SUITE_CAP_GET,
  suiteCapUpdate: Methods.EVAL_SUITE_CAP_UPDATE,
} as const;

export type EvalExperimentSource =
  | { kind: 'merged-pr'; ref: string }
  | { kind: 'prior-run'; runId: string }
  | { kind: 'package'; packagePath: string }
  | {
      kind: 'git-ref';
      ref: string;
      repository?: string;
      baseRef?: string;
      baseSha?: string;
      headRef?: string;
      headSha?: string;
    };

export interface EvalExperimentCreateParams {
  project: string;
  source: EvalExperimentSource;
  taskProfile: EvalTaskProfile;
  rubricId?: string;
  rubricVersion?: string;
  familyId?: string;
  objective?: string;
  objectiveHash?: string;
  datasetId?: string;
  datasetItemId?: string;
}

export interface EvalExperimentCreateResult {
  experimentId: string;
  experimentKey: string;
  familyId: string;
  experimentManifestPath: string;
  experimentManifest: EvalExperimentManifest;
  referencePackage: ResultPackageManifest;
  referencePackagePath: string;
}

export interface EvalTrialStartParams {
  project: string;
  experimentManifestPath: string;
  /** Candidate axes identify the package variant being tested: template, prompt, harness, base recipe, runner, and model. */
  axes: EvalPackageAxes;
  source?: EvalExperimentSource;
  /** Human-readable package label shown in eval tables. */
  label?: string;
  /** Optional replay checkout base for artifact-only candidate trials. */
  startRef?: string;
  runner?: string;
  model?: string;
  effort?: string;
  app?: string;
  slotId?: string;
  allowedSlots?: string[];
  safetyTier?: SafetyTier;
  /** Comparison-lane sibling label. Omitted = derived from label/axes fingerprint; never a mode or flow type. */
  variant?: string;
  /** Start a distinct trial for the same axes instead of idempotently reusing the existing candidate. */
  repeat?: boolean;
  /** Explicit idempotency key for repeated trials. */
  trialId?: string;
  /** Matrix/suite-wide cap group used by the shared dispatch scheduler. */
  capGroupId?: string;
  suiteId?: string;
}

export interface EvalTrialStartResult {
  experimentId: string;
  experimentKey: string;
  deduped: boolean;
  strategyId: string;
  trialId: string;
  candidateStrategyFingerprint: string;
  experimentManifestPath: string;
  experimentManifest: EvalExperimentManifest;
  candidatePackage: ResultPackageManifest;
  candidatePackagePath: string;
  run?: Run;
  taskPath?: string;
  artifactDir?: string;
}

export interface EvalTrialResultGetParams {
  runId: string;
}

export interface EvalTrialResultGetResult {
  run: Run;
  candidatePackage: ResultPackageManifest;
  candidatePackagePath: string;
  experimentManifest?: EvalExperimentManifest;
}

export interface EvalSuiteCapGetParams {
  capGroupId: string;
}

export interface EvalSuiteCapSummary {
  capGroupId: string;
  suiteId?: string;
  cap: number;
  active: number;
  dispatching: number;
  queued: number;
  total: number;
}

export interface EvalSuiteCapUpdateParams {
  capGroupId: string;
  cap: number;
  suiteId?: string;
}

export type EvalSuiteCapGetResult = EvalSuiteCapSummary;
export type EvalSuiteCapUpdateResult = EvalSuiteCapSummary;
