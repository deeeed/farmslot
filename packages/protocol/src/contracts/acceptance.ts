import * as contract from '../../scripts/acceptance.mjs';
import type { EvidenceMomentRef, RecipeClaimKind } from '../recipe/evidence.js';

// ADR-062 engine claims are the normal verdict authority. Task init assigns
// positional AC ids; selected recipe execution transfers a schema-2 projection
// into the task namespace. Schema 1 survives only as retained display input.

/** Task-relative path of the selected engine-ledger projection. */
export const ACCEPTANCE_STATUS_ARTIFACT: string = contract.ACCEPTANCE_STATUS_ARTIFACT;
export const INHERITED_ACCEPTANCE_INPUT: string = contract.INHERITED_ACCEPTANCE_INPUT;

export interface InheritedAcceptanceProvenance {
  source: 'parent-run';
  parentRunId: string;
  headSha: string;
  ledgerHash: string;
}

/** Provisional task transport; the gateway independently revalidates its parent. */
export interface TaskInheritedAcceptanceReference extends InheritedAcceptanceProvenance {
  schemaVersion: 1;
  childRunId: string;
  project: string;
  criteria: AcceptanceCriterionRef[];
}

export const ACCEPTANCE_VERDICTS = contract.ACCEPTANCE_VERDICTS;
export type AcceptanceVerdict = (typeof ACCEPTANCE_VERDICTS)[number];

export const ACCEPTANCE_PROOF_MODES = contract.ACCEPTANCE_PROOF_MODES;
export type AcceptanceProofMode = (typeof ACCEPTANCE_PROOF_MODES)[number];

/** Ids are positional, so a criterion keeps its id for the life of the task dir. */
export const ACCEPTANCE_CRITERION_ID_PATTERN = contract.ACCEPTANCE_CRITERION_ID_PATTERN;

/**
 * `AC-<N>` for a criterion's position in the handoff array.
 *
 * @param index 0-based position in `inputs/handoff.json` `task.acceptanceCriteria`.
 */
export const acceptanceCriterionId = contract.acceptanceCriterionId;
export const acceptanceCriteriaMatch = contract.acceptanceCriteriaMatch;

export interface AcceptanceCriterionStatus {
  /** `AC-<N>`, N the 1-based position in the handoff criteria array. */
  id: string;
  /** Criterion text as task init recorded it. */
  text: string;
  verdict: AcceptanceVerdict;
  /** Gateway review projection; absent on immutable engine/task bytes. */
  engineVerdict?: AcceptanceVerdict;
  overrides?: Array<{ receiptId: string }>;
  proofMode?: AcceptanceProofMode;
  /** Task-dir relative evidence paths. */
  evidence: string[];
  /** Recipe node ids that prove this criterion. */
  recipeNodes: string[];
  note?: string;
  updatedAt?: string;
  kind?: RecipeClaimKind;
  parentId?: string;
  assertionIndices?: number[];
  moments?: EvidenceMomentRef[];
}

export interface AcceptanceStatusLedger {
  schemaVersion: 1 | 2;
  recipeRunId?: string;
  criteria: AcceptanceCriterionStatus[];
}

/**
 * One criterion as task init registered it: the id and the text, with no verdict.
 * Clients pair this with the ledger so a criterion the worker has not judged yet is
 * visible as awaiting a verdict rather than missing from the panel. The ledger
 * carries assessed engine claims; nothing invents a verdict for unassessed rows.
 */
export interface AcceptanceCriterionRef {
  id: string;
  text: string;
}

/** A criterion paired with its verdict, or null when none is recorded yet. */
export interface AcceptanceCriterionView extends AcceptanceCriterionRef {
  status: AcceptanceCriterionStatus | null;
}

/**
 * Every registered criterion in id order, each with its recorded verdict or null.
 * `criteria` is the authority for how many criteria the run has; `ledger` only ever
 * holds the ones already judged.
 */
export const acceptanceCriteriaView: (
  criteria: ReadonlyArray<AcceptanceCriterionRef>,
  ledger: AcceptanceStatusLedger | null,
) => AcceptanceCriterionView[] = contract.acceptanceCriteriaView as typeof acceptanceCriteriaView;

/**
 * Where a run's acceptance panel data came from. Only `ledger` carries verdicts;
 * `evidence-manifest` identifies retained historical data, never current fallback derivation.
 */
export type AcceptanceStatusSource = 'ledger' | 'evidence-manifest';

/**
 * Explicitly retained historical criterion links in the task namespace. Current
 * readers do not derive them from manifest covers. Links establish neither
 * verdicts nor a recording timeline and remain display only.
 */
export interface AcceptanceEvidenceLink {
  /** `AC-<N>`, a criterion the handoff registered. */
  id: string;
  evidence: string[];
}

export interface AcceptanceStatusSummary {
  proven: number;
  weak: number;
  failed: number;
  'awaiting-review': number;
  missing: number;
  untestable: number;
  /** Registered criteria with no verdict recorded yet; 0 unless `criteria` was given. */
  unrecorded: number;
  total: number;
}

/** Shared validation/rendering also runs in unbuilt operator CJS scripts. */
export const validateAcceptanceStatusLedger = contract.validateAcceptanceStatusLedger;
export const summarizeAcceptanceStatus: (
  ledger: AcceptanceStatusLedger,
  criteria?: ReadonlyArray<AcceptanceCriterionRef>,
) => AcceptanceStatusSummary =
  contract.summarizeAcceptanceStatus as typeof summarizeAcceptanceStatus;
export const renderAcceptanceCoverage: (
  ledger: AcceptanceStatusLedger,
  criteria?: ReadonlyArray<AcceptanceCriterionRef>,
) => string = contract.renderAcceptanceCoverage;
