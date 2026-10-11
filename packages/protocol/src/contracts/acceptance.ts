import contract from '../../scripts/acceptance.cjs';
import type { EvidenceMomentRef, RecipeClaimKind } from '../recipe/evidence.js';

// Acceptance-criteria ledger (ADR-060): one verdict per criterion, with the
// evidence that proves it.
//
// Task init assigns the ids (`AC-<N>`, N the 1-based position of the criterion in
// `inputs/handoff.json` `task.acceptanceCriteria`). One module writes
// `artifacts/acceptance-status.json` (agent-runtime's acceptance-ledger.cjs), for
// `farmslot-agent ac` and for recipe runs with a task dir. The markdown coverage
// table workers hand-write today is a rendering of this file, so the terminal
// contract check, the PR body, and the run-detail panel all read one source.

/** Task-dir relative path of the ledger. Written by `farmslot-agent ac` and recipe runs. */
export const ACCEPTANCE_STATUS_ARTIFACT: string = contract.ACCEPTANCE_STATUS_ARTIFACT;

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

export interface AcceptanceCriterionStatus {
  /** `AC-<N>`, N the 1-based position in the handoff criteria array. */
  id: string;
  /** Criterion text as task init recorded it. */
  text: string;
  verdict: AcceptanceVerdict;
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
 * visible as awaiting a verdict rather than missing from the panel — the ledger
 * holds only what `ac set` recorded, and nothing may invent a verdict for the rest.
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
 * `evidence-manifest` is the display fallback for a run that wrote no ledger.
 */
export type AcceptanceStatusSource = 'ledger' | 'evidence-manifest';

/**
 * A criterion that one or more `artifacts/evidence-manifest.json` entries list in
 * `covers`, with the task-dir relative files those entries link. Shown only when
 * the run has no ledger. It says evidence exists, never that the criterion is
 * proven, so nothing may count it as a verdict.
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
