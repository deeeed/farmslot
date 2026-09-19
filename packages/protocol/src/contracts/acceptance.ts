// Acceptance-criteria ledger (ADR-060): one verdict per criterion, with the
// evidence that proves it.
//
// Task init assigns the ids (`AC-<N>`, N the 1-based position of the criterion in
// `inputs/handoff.json` `task.acceptanceCriteria`) and `farmslot-agent ac` is the
// only writer of `artifacts/acceptance-status.json`. The markdown coverage table
// workers hand-write today is a rendering of this file, so the terminal contract
// check, the PR body, and the run-detail panel all read one structured source.

/** Task-dir relative path of the ledger. Written only by `farmslot-agent ac`. */
export const ACCEPTANCE_STATUS_ARTIFACT = 'artifacts/acceptance-status.json';

export const ACCEPTANCE_VERDICTS = ['proven', 'weak', 'missing', 'untestable'] as const;
export type AcceptanceVerdict = (typeof ACCEPTANCE_VERDICTS)[number];

export const ACCEPTANCE_PROOF_MODES = ['state', 'visual', 'mixed'] as const;
export type AcceptanceProofMode = (typeof ACCEPTANCE_PROOF_MODES)[number];

/** Ids are positional, so a criterion keeps its id for the life of the task dir. */
export const ACCEPTANCE_CRITERION_ID_PATTERN = /^AC-[1-9][0-9]*$/;

/**
 * `AC-<N>` for a criterion's position in the handoff array.
 *
 * @param index 0-based position in `inputs/handoff.json` `task.acceptanceCriteria`.
 */
export function acceptanceCriterionId(index: number): string {
  return `AC-${index + 1}`;
}

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
  updatedAt: string;
}

export interface AcceptanceStatusLedger {
  schemaVersion: 1;
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
export function acceptanceCriteriaView(
  criteria: ReadonlyArray<AcceptanceCriterionRef>,
  ledger: AcceptanceStatusLedger | null,
): AcceptanceCriterionView[] {
  const byId = new Map((ledger?.criteria ?? []).map((entry) => [entry.id, entry]));
  const rows = criteria.map((criterion) => ({
    ...criterion,
    status: byId.get(criterion.id) ?? null,
  }));
  // A ledger entry for an id the handoff does not list is still shown: hiding it
  // would hide a contract violation the terminal check refuses on.
  for (const entry of ledger?.criteria ?? []) {
    if (!criteria.some((criterion) => criterion.id === entry.id)) {
      rows.push({ id: entry.id, text: entry.text, status: entry });
    }
  }
  return rows;
}

export interface AcceptanceStatusSummary {
  proven: number;
  weak: number;
  missing: number;
  untestable: number;
  /** Registered criteria with no verdict recorded yet; 0 unless `criteria` was given. */
  unrecorded: number;
  total: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Contract issues for a parsed ledger; an empty array means the value is a valid
 * {@link AcceptanceStatusLedger}. Issue strings are caller-printable and name the
 * offending field, the way the task artifact contract check reports its own.
 */
export function validateAcceptanceStatusLedger(value: unknown): string[] {
  const issues: string[] = [];
  if (!isRecord(value)) return ['acceptance ledger: expected object'];
  if (value.schemaVersion !== 1) issues.push('acceptance ledger schemaVersion: expected 1');
  if (!Array.isArray(value.criteria)) {
    issues.push('acceptance ledger criteria: expected array');
    return issues;
  }
  const seen = new Set<string>();
  value.criteria.forEach((entry, index) => {
    const prefix = `acceptance ledger criteria[${index}]`;
    if (!isRecord(entry)) {
      issues.push(`${prefix}: expected object`);
      return;
    }
    if (!isNonEmptyString(entry.id) || !ACCEPTANCE_CRITERION_ID_PATTERN.test(entry.id)) {
      issues.push(`${prefix}.id: expected AC-<N>`);
    } else if (seen.has(entry.id)) {
      issues.push(`${prefix}.id: duplicate ${entry.id}`);
    } else {
      seen.add(entry.id);
    }
    if (typeof entry.text !== 'string') issues.push(`${prefix}.text: expected string`);
    if (!ACCEPTANCE_VERDICTS.includes(entry.verdict as AcceptanceVerdict)) {
      issues.push(`${prefix}.verdict: expected one of ${ACCEPTANCE_VERDICTS.join(', ')}`);
    }
    if (
      entry.proofMode !== undefined &&
      !ACCEPTANCE_PROOF_MODES.includes(entry.proofMode as AcceptanceProofMode)
    ) {
      issues.push(`${prefix}.proofMode: expected one of ${ACCEPTANCE_PROOF_MODES.join(', ')}`);
    }
    for (const key of ['evidence', 'recipeNodes'] as const) {
      const list = entry[key];
      if (!Array.isArray(list) || list.some((item) => !isNonEmptyString(item))) {
        issues.push(`${prefix}.${key}: expected an array of non-empty strings`);
      }
    }
    if (entry.note !== undefined && typeof entry.note !== 'string') {
      issues.push(`${prefix}.note: expected string`);
    }
    if (!isNonEmptyString(entry.updatedAt)) {
      issues.push(`${prefix}.updatedAt: expected non-empty string`);
    }
  });
  return issues;
}

/**
 * Verdict tally over the ledger.
 *
 * Omitting `criteria` counts only the rows already recorded, which understates a
 * partial ledger: `total` is then "verdicts written", not "criteria the task has".
 * Pass the registered criteria whenever the caller can read them — every caller
 * with the task directory can — to get a `total` of registered criteria and an
 * `unrecorded` count of those still waiting for a verdict.
 */
export function summarizeAcceptanceStatus(
  ledger: AcceptanceStatusLedger,
  criteria?: ReadonlyArray<AcceptanceCriterionRef>,
): AcceptanceStatusSummary {
  const total = criteria
    ? Math.max(criteria.length, ledger.criteria.length)
    : ledger.criteria.length;
  const summary: AcceptanceStatusSummary = {
    proven: 0,
    weak: 0,
    missing: 0,
    untestable: 0,
    unrecorded: 0,
    total,
  };
  for (const criterion of ledger.criteria) summary[criterion.verdict] += 1;
  summary.unrecorded =
    total - (summary.proven + summary.weak + summary.missing + summary.untestable);
  return summary;
}

function cell(value: string): string {
  return (
    value
      .replace(/\|/g, '\\|')
      .replace(/\s*\n\s*/g, ' ')
      .trim() || '-'
  );
}

function list(values: string[]): string {
  return values.length > 0 ? cell(values.join(', ')) : '-';
}

/**
 * The coverage table `artifacts/recipe-coverage.md` holds today, rendered from the
 * ledger. The proof-mode column keeps the lowercase `state` / `visual` / `mixed`
 * vocabulary the evidence rules key off, and the last line is the `Overall recipe
 * coverage:` summary every consumer of the coverage file already looks for.
 *
 * Pass `criteria` so the overall line counts registered criteria: without them a
 * partial ledger reads `1/1 PROVEN` when the task has three criteria. A criterion
 * with no verdict yet is counted in the total and listed as awaiting one; it is
 * never given a verdict it does not have.
 */
export function renderAcceptanceCoverage(
  ledger: AcceptanceStatusLedger,
  criteria: ReadonlyArray<AcceptanceCriterionRef> = ledger.criteria,
): string {
  const summary = summarizeAcceptanceStatus(ledger, criteria);
  const rows = acceptanceCriteriaView(criteria, ledger);
  const untestable = ledger.criteria
    .filter((criterion) => criterion.verdict === 'untestable')
    .map((criterion) => criterion.id);
  const lines = [
    '## Recipe coverage',
    '',
    '| AC | Criterion | Verdict | Proof mode | Recipe nodes | Evidence | Note |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const row of rows) {
    const status = row.status;
    lines.push(
      `| ${row.id} | ${cell(row.text)} | ${status ? status.verdict.toUpperCase() : 'NO VERDICT'} | ` +
        `${status?.proofMode ?? '-'} | ${list(status?.recipeNodes ?? [])} | ` +
        `${list(status?.evidence ?? [])} | ${cell(status?.note ?? '')} |`,
    );
  }
  lines.push(
    '',
    `Overall recipe coverage: ${summary.proven}/${summary.total} ACs PROVEN ` +
      `(untestable: ${untestable.length > 0 ? untestable.join(', ') : 'none'}, ` +
      `weak: ${summary.weak}, missing: ${summary.missing}` +
      // Only when some criterion has no verdict: a finished run renders the exact
      // line the spec pins, and a partial one says why the counts fall short.
      `${summary.unrecorded > 0 ? `, no verdict: ${summary.unrecorded}` : ''})`,
    '',
  );
  return lines.join('\n');
}
