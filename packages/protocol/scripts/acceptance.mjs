// Portable acceptance contract. Operator scripts and clients consume the same implementation.
const ACCEPTANCE_STATUS_ARTIFACT = 'artifacts/acceptance-status.json';
const INHERITED_ACCEPTANCE_INPUT = 'inputs/inherited-acceptance.json';
const ACCEPTANCE_REGISTRATION_INPUT = 'inputs/acceptance-registration.json';
const ACCEPTANCE_CONTRACT_INPUT = 'inputs/acceptance-contract.json';
const ACCEPTANCE_VERDICTS = [
  'proven',
  'weak',
  'missing',
  'untestable',
  'failed',
  'awaiting-review',
];
const ACCEPTANCE_PROOF_MODES = ['state', 'visual', 'mixed', 'review'];
const ACCEPTANCE_CRITERION_ID_PATTERN = /^AC-[1-9][0-9]*$/;

function acceptanceCriterionId(index) {
  return `AC-${index + 1}`;
}

function registeredAcceptanceCriteria(criteria, registration) {
  const original = criteria
    .filter((text) => String(text).trim().length > 0)
    .map((text, index) => ({ id: acceptanceCriterionId(index), text: String(text) }));
  if (registration === undefined) return original;
  if (
    !isRecord(registration) ||
    registration.schemaVersion !== 1 ||
    !Number.isSafeInteger(registration.revision) ||
    registration.revision < 1 ||
    !acceptanceCriteriaMatch(original, registration.original) ||
    !Array.isArray(registration.derived) ||
    !Array.isArray(registration.units)
  )
    throw new Error('acceptance registration: invalid revision or changed original criteria');
  const ids = new Set(original.map(({ id }) => id));
  let next = original.length;
  for (const row of registration.derived) {
    if (
      !isRecord(row) ||
      row.id !== `AC-${++next}` ||
      ids.has(row.id) ||
      !isNonEmptyString(row.text) ||
      !ACCEPTANCE_PROOF_MODES.includes(row.proofMode) ||
      !isRecord(row.source) ||
      !['review-comment', 'instruction'].includes(row.source.kind) ||
      !isNonEmptyString(row.source.sourceId) ||
      !isNonEmptyString(row.source.sourceVersion) ||
      !Number.isSafeInteger(row.source.obligationIndex) ||
      row.source.obligationIndex < 0
    )
      throw new Error('acceptance registration: invalid derived criterion or source');
    ids.add(row.id);
  }
  return [...registration.original, ...registration.derived];
}

/** The execution whose retained package a task-ledger row binds to: a QA case row names its own. */
function acceptanceRowExecution(ledger, row) {
  return row?.recipeRunId ?? ledger?.recipeRunId;
}

function acceptanceCriteriaMatch(expected, actual) {
  return (
    Array.isArray(expected) &&
    Array.isArray(actual) &&
    expected.length === actual.length &&
    expected.every(
      (criterion, index) =>
        isRecord(criterion) &&
        isRecord(actual[index]) &&
        criterion.id === actual[index].id &&
        typeof criterion.text === 'string' &&
        typeof actual[index].text === 'string' &&
        criterion.text.trim() === actual[index].text.trim(),
    )
  );
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateAcceptanceStatusLedger(value) {
  const issues = [];
  if (!isRecord(value)) return ['acceptance ledger: expected object'];
  if (value.schemaVersion !== 1 && value.schemaVersion !== 2)
    issues.push('acceptance ledger schemaVersion: expected 1 or 2');
  if (value.schemaVersion === 2 && !isNonEmptyString(value.recipeRunId))
    issues.push('acceptance ledger recipeRunId: expected execution identity');
  if (value.schemaVersion === 2) {
    const recording = value.recording;
    if (
      !isRecord(recording) ||
      ![
        'not-required',
        'explicit-off',
        'recording',
        'finalizing',
        'complete',
        'incomplete',
        'failed',
      ].includes(recording.status) ||
      !Array.isArray(recording.segments) ||
      recording.segments.some(
        (segment) =>
          !isRecord(segment) ||
          !isNonEmptyString(segment.videoPath) ||
          !/^sha256:[a-f0-9]{64}$/.test(segment.videoDigest),
      )
    )
      issues.push('acceptance ledger recording: invalid capture state or segments');
  }
  if (!Array.isArray(value.criteria)) {
    issues.push('acceptance ledger criteria: expected array');
    return issues;
  }
  if (
    value.schemaVersion === 2 &&
    value.judgments !== undefined &&
    (!Array.isArray(value.judgments) ||
      value.judgments.some(
        (judgment) =>
          !isRecord(judgment) ||
          judgment.recipeRunId !== value.recipeRunId ||
          !isNonEmptyString(judgment.claimId) ||
          !['confirmed', 'rejected'].includes(judgment.verdict) ||
          !isNonEmptyString(judgment.actor) ||
          !isNonEmptyString(judgment.reason) ||
          !Number.isFinite(Date.parse(judgment.judgedAt)) ||
          !Array.isArray(judgment.moments),
      ))
  )
    issues.push('acceptance ledger judgments: invalid visual review');
  const seen = new Set();
  value.criteria.forEach((entry, index) => {
    const prefix = `acceptance ledger criteria[${index}]`;
    if (!isRecord(entry)) {
      issues.push(`${prefix}: expected object`);
      return;
    }
    if (
      !isNonEmptyString(entry.id) ||
      (value.schemaVersion === 1 && !ACCEPTANCE_CRITERION_ID_PATTERN.test(entry.id))
    ) {
      issues.push(`${prefix}.id: expected AC-<N>`);
    } else if (seen.has(entry.id)) {
      issues.push(`${prefix}.id: duplicate ${entry.id}`);
    } else {
      seen.add(entry.id);
    }
    if (typeof entry.text !== 'string') issues.push(`${prefix}.text: expected string`);
    if (!ACCEPTANCE_VERDICTS.includes(entry.verdict)) {
      issues.push(`${prefix}.verdict: expected one of ${ACCEPTANCE_VERDICTS.join(', ')}`);
    }
    if (entry.proofMode !== undefined && !ACCEPTANCE_PROOF_MODES.includes(entry.proofMode)) {
      issues.push(`${prefix}.proofMode: expected one of ${ACCEPTANCE_PROOF_MODES.join(', ')}`);
    }
    for (const key of ['evidence', 'recipeNodes']) {
      const list = entry[key];
      if (!Array.isArray(list) || list.some((item) => !isNonEmptyString(item))) {
        issues.push(`${prefix}.${key}: expected an array of non-empty strings`);
      }
    }
    if (value.schemaVersion === 2) {
      if (!['acceptance', 'qa-case', 'qa-check'].includes(entry.kind))
        issues.push(`${prefix}.kind: invalid claim kind`);
      if (!ACCEPTANCE_PROOF_MODES.includes(entry.proofMode))
        issues.push(`${prefix}.proofMode: required`);
      if (
        !Array.isArray(entry.assertionIndices) ||
        entry.assertionIndices.some((index) => !Number.isInteger(index) || index < 0)
      )
        issues.push(`${prefix}.assertionIndices: invalid trace references`);
      if (entry.retainedFrom !== undefined && !isNonEmptyString(entry.retainedFrom))
        issues.push(`${prefix}.retainedFrom: expected the retained execution id`);
      if (entry.recipeRunId !== undefined && !isNonEmptyString(entry.recipeRunId))
        issues.push(`${prefix}.recipeRunId: expected the source execution id`);
      // A repair keeps older proof only with its own original execution's moments;
      // a QA case row only with the moments of the case execution it came from.
      if (
        !Array.isArray(entry.moments) ||
        entry.moments.some(
          (moment) =>
            !isRecord(moment) ||
            moment.recipeRunId !== (entry.retainedFrom ?? acceptanceRowExecution(value, entry)) ||
            !/^sha256:[a-f0-9]{64}$/.test(moment.videoDigest) ||
            !Number.isInteger(moment.traceIndex) ||
            moment.traceIndex < 0,
        )
      )
        issues.push(`${prefix}.moments: invalid moment references`);
    }
    if (entry.note !== undefined && typeof entry.note !== 'string') {
      issues.push(`${prefix}.note: expected string`);
    }
    if (value.schemaVersion === 1 && !isNonEmptyString(entry.updatedAt)) {
      issues.push(`${prefix}.updatedAt: expected non-empty string`);
    }
  });
  return issues;
}

function acceptanceCriteriaView(criteria, ledger) {
  const byId = new Map((ledger?.criteria ?? []).map((entry) => [entry.id, entry]));
  const rows = criteria.map((criterion) => ({
    ...criterion,
    status: byId.get(criterion.id) ?? null,
  }));
  for (const entry of ledger?.criteria ?? []) {
    if (!criteria.some((criterion) => criterion.id === entry.id)) {
      rows.push({ id: entry.id, text: entry.text, status: entry });
    }
  }
  return rows;
}

function summarizeAcceptanceStatus(ledger, criteria) {
  const total = criteria
    ? Math.max(criteria.length, ledger.criteria.length)
    : ledger.criteria.length;
  const summary = {
    proven: 0,
    weak: 0,
    failed: 0,
    'awaiting-review': 0,
    missing: 0,
    untestable: 0,
    unrecorded: 0,
    total,
  };
  for (const criterion of ledger.criteria) summary[criterion.verdict] += 1;
  summary.unrecorded =
    total - ACCEPTANCE_VERDICTS.reduce((count, verdict) => count + summary[verdict], 0);
  return summary;
}

function cell(value) {
  return (
    value
      .replace(/\|/g, '\\|')
      .replace(/\s*\n\s*/g, ' ')
      .trim() || '-'
  );
}

function list(values) {
  return values.length > 0 ? cell(values.join(', ')) : '-';
}

/**
 * Display text for a verdict. The code review checks a `review` claim, so it reads
 * "Checked in review" or "Awaiting code review", never `missing` (ADR-062 Amendment 18).
 * A failed or untestable verdict keeps its own text.
 */
function acceptanceVerdictLabel(status) {
  if (status.proofMode !== 'review' || ['failed', 'untestable'].includes(status.verdict))
    return status.verdict;
  return status.verdict === 'proven' ? 'Checked in review' : 'Awaiting code review';
}

function renderAcceptanceCoverage(ledger, criteria = ledger.criteria) {
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
      `| ${row.id} | ${cell(row.text)} | ${status ? acceptanceVerdictLabel(status).toUpperCase() : 'NO VERDICT'} | ` +
        `${status?.proofMode ?? '-'} | ${list(status?.recipeNodes ?? [])} | ` +
        `${list(status?.evidence ?? [])} | ${cell(status?.note ?? '')} |`,
    );
  }
  lines.push(
    '',
    `Overall recipe coverage: ${summary.proven}/${summary.total} ACs PROVEN ` +
      `(untestable: ${untestable.length > 0 ? untestable.join(', ') : 'none'}, ` +
      `weak: ${summary.weak}, missing: ${summary.missing}` +
      (summary.failed ? `, failed: ${summary.failed}` : '') +
      (summary['awaiting-review'] ? `, awaiting review: ${summary['awaiting-review']}` : '') +
      `${summary.unrecorded > 0 ? `, no verdict: ${summary.unrecorded}` : ''})`,
    '',
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// task-dir IO

export {
  ACCEPTANCE_CONTRACT_INPUT,
  ACCEPTANCE_CRITERION_ID_PATTERN,
  ACCEPTANCE_PROOF_MODES,
  ACCEPTANCE_REGISTRATION_INPUT,
  ACCEPTANCE_STATUS_ARTIFACT,
  ACCEPTANCE_VERDICTS,
  acceptanceCriteriaMatch,
  acceptanceCriteriaView,
  acceptanceCriterionId,
  acceptanceRowExecution,
  acceptanceVerdictLabel,
  INHERITED_ACCEPTANCE_INPUT,
  registeredAcceptanceCriteria,
  renderAcceptanceCoverage,
  summarizeAcceptanceStatus,
  validateAcceptanceStatusLedger,
};
