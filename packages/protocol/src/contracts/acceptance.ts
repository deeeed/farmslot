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

/** `AC-<N>` for a 0-based position in the handoff criteria array. */
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

export interface AcceptanceStatusSummary {
  proven: number;
  weak: number;
  missing: number;
  untestable: number;
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

export function summarizeAcceptanceStatus(ledger: AcceptanceStatusLedger): AcceptanceStatusSummary {
  const summary: AcceptanceStatusSummary = {
    proven: 0,
    weak: 0,
    missing: 0,
    untestable: 0,
    total: ledger.criteria.length,
  };
  for (const criterion of ledger.criteria) summary[criterion.verdict] += 1;
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
 */
export function renderAcceptanceCoverage(ledger: AcceptanceStatusLedger): string {
  const summary = summarizeAcceptanceStatus(ledger);
  const untestable = ledger.criteria
    .filter((criterion) => criterion.verdict === 'untestable')
    .map((criterion) => criterion.id);
  const lines = [
    '## Recipe coverage',
    '',
    '| AC | Criterion | Verdict | Proof mode | Recipe nodes | Evidence | Note |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const criterion of ledger.criteria) {
    lines.push(
      `| ${criterion.id} | ${cell(criterion.text)} | ${criterion.verdict.toUpperCase()} | ` +
        `${criterion.proofMode ?? '-'} | ${list(criterion.recipeNodes)} | ` +
        `${list(criterion.evidence)} | ${cell(criterion.note ?? '')} |`,
    );
  }
  lines.push(
    '',
    `Overall recipe coverage: ${summary.proven}/${summary.total} ACs PROVEN ` +
      `(untestable: ${untestable.length > 0 ? untestable.join(', ') : 'none'}, ` +
      `weak: ${summary.weak}, missing: ${summary.missing})`,
    '',
  );
  return lines.join('\n');
}
