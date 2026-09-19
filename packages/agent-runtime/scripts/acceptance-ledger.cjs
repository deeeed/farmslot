const fs = require('node:fs');
const path = require('node:path');

const { atomicWrite, readJson } = require('./mark-io.cjs');

// Acceptance-criteria ledger (ADR-060 / plans/sub-task-observability-v1.md).
//
// `farmslot-agent ac` is the only writer of artifacts/acceptance-status.json, the
// way `mark` is the only writer of SIGNAL.json. The ids come from task init, which
// records the criteria in inputs/handoff.json; this module never invents one.
//
// The constants and the validate/summarize/render helpers are a behavioral mirror
// of @farmslot/protocol/contracts/acceptance (see test/acceptance-ledger-sync.test.mjs).
// The mirror exists because the mark engine and this CLI are CJS and must run on a
// slot without a built protocol package.

const HANDOFF_INPUT = path.join('inputs', 'handoff.json');
const ACCEPTANCE_STATUS_ARTIFACT = 'artifacts/acceptance-status.json';
const ACCEPTANCE_VERDICTS = ['proven', 'weak', 'missing', 'untestable'];
const ACCEPTANCE_PROOF_MODES = ['state', 'visual', 'mixed'];
const ACCEPTANCE_CRITERION_ID_PATTERN = /^AC-[1-9][0-9]*$/;

/** A refused command: the message is worker-facing, the code is the exit code. */
class AcceptanceRefusal extends Error {
  constructor(message, code = 1) {
    super(message);
    this.name = 'AcceptanceRefusal';
    this.code = code;
  }
}

/**
 * `AC-<N>` for a criterion's position in the handoff array.
 * @param {number} index 0-based position in inputs/handoff.json task.acceptanceCriteria.
 */
function acceptanceCriterionId(index) {
  return `AC-${index + 1}`;
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
  if (value.schemaVersion !== 1) issues.push('acceptance ledger schemaVersion: expected 1');
  if (!Array.isArray(value.criteria)) {
    issues.push('acceptance ledger criteria: expected array');
    return issues;
  }
  const seen = new Set();
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
    if (entry.note !== undefined && typeof entry.note !== 'string') {
      issues.push(`${prefix}.note: expected string`);
    }
    if (!isNonEmptyString(entry.updatedAt)) {
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
      `${summary.unrecorded > 0 ? `, no verdict: ${summary.unrecorded}` : ''})`,
    '',
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// task-dir IO

function ledgerPath(taskDir) {
  return path.join(taskDir, ACCEPTANCE_STATUS_ARTIFACT);
}

/**
 * The criteria task init recorded, as `{ id, text }` in handoff order. An empty
 * array means this run has no acceptance criteria, so the ledger does not apply.
 */
function handoffAcceptanceCriteria(taskDir) {
  const handoff = readJson(path.join(taskDir, HANDOFF_INPUT));
  const task = isRecord(handoff.task) ? handoff.task : {};
  const criteria = Array.isArray(task.acceptanceCriteria) ? task.acceptanceCriteria : [];
  return criteria
    .map((text, index) => ({ id: acceptanceCriterionId(index), text: String(text) }))
    .filter((criterion) => criterion.text.trim().length > 0);
}

/** The stored ledger, or null when the run has not written one yet. */
function readAcceptanceLedger(taskDir) {
  const file = ledgerPath(taskDir);
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8');
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new AcceptanceRefusal(`${ACCEPTANCE_STATUS_ARTIFACT}: invalid JSON (${err.message})`);
  }
}

function writeAcceptanceLedger(taskDir, ledger) {
  const issues = validateAcceptanceStatusLedger(ledger);
  if (issues.length > 0) {
    throw new AcceptanceRefusal(
      `refusing to write an invalid ${ACCEPTANCE_STATUS_ARTIFACT}:\n- ${issues.join('\n- ')}`,
    );
  }
  atomicWrite(ledgerPath(taskDir), `${JSON.stringify(ledger, null, 2)}\n`, 0o644);
}

/** Task-dir relative evidence path, refused when it escapes the dir or is missing. */
function assertEvidencePath(taskDir, rawPath) {
  const normalized = rawPath.replace(/\\/g, '/').replace(/^\.\/+/, '');
  if (!normalized || path.posix.isAbsolute(normalized) || path.isAbsolute(rawPath)) {
    throw new AcceptanceRefusal(`evidence path must be relative to the task dir: ${rawPath}`);
  }
  if (normalized.split('/').some((segment) => segment === '..')) {
    throw new AcceptanceRefusal(`evidence path must stay inside the task dir: ${rawPath}`);
  }
  if (!fs.existsSync(path.join(taskDir, normalized))) {
    throw new AcceptanceRefusal(`evidence path does not exist: ${normalized}`);
  }
  return normalized;
}

/**
 * Record one verdict. The criterion must be one task init registered: the ledger
 * carries exactly the handoff ids, never an id the worker made up.
 */
function setAcceptanceVerdict(taskDir, input) {
  const criteria = handoffAcceptanceCriteria(taskDir);
  if (criteria.length === 0) {
    throw new AcceptanceRefusal(
      `${HANDOFF_INPUT} lists no acceptance criteria; there is no ledger to write`,
    );
  }
  const criterion = criteria.find((entry) => entry.id === input.id);
  if (!criterion) {
    throw new AcceptanceRefusal(
      `unknown acceptance criterion ${input.id}; ${HANDOFF_INPUT} lists ${criteria
        .map((entry) => entry.id)
        .join(', ')}`,
    );
  }
  if (!ACCEPTANCE_VERDICTS.includes(input.verdict)) {
    throw new AcceptanceRefusal(
      `unknown verdict ${input.verdict}; expected one of ${ACCEPTANCE_VERDICTS.join(', ')}`,
    );
  }
  if (input.proofMode !== undefined && !ACCEPTANCE_PROOF_MODES.includes(input.proofMode)) {
    throw new AcceptanceRefusal(
      `unknown proof mode ${input.proofMode}; expected one of ${ACCEPTANCE_PROOF_MODES.join(', ')}`,
    );
  }
  const evidence = (input.evidence ?? []).map((entry) => assertEvidencePath(taskDir, entry));
  const stored = readAcceptanceLedger(taskDir);
  if (stored) {
    const issues = validateAcceptanceStatusLedger(stored);
    if (issues.length > 0) {
      throw new AcceptanceRefusal(
        `${ACCEPTANCE_STATUS_ARTIFACT} does not match the ledger contract:\n- ${issues.join('\n- ')}`,
      );
    }
  }
  const byId = new Map((stored?.criteria ?? []).map((entry) => [entry.id, entry]));
  byId.set(criterion.id, {
    id: criterion.id,
    text: criterion.text,
    verdict: input.verdict,
    ...(input.proofMode ? { proofMode: input.proofMode } : {}),
    evidence,
    recipeNodes: [...(input.recipeNodes ?? [])],
    ...(input.note ? { note: input.note } : {}),
    updatedAt: input.now ?? new Date().toISOString(),
  });
  // Handoff order, so the ledger and the rendered table always read like TASK.md.
  const ledger = {
    schemaVersion: 1,
    criteria: criteria.map((entry) => byId.get(entry.id)).filter(Boolean),
  };
  writeAcceptanceLedger(taskDir, ledger);
  return ledger;
}

/** Every handoff criterion with its current verdict, or null when unrecorded. */
function acceptanceStatusList(taskDir) {
  const stored = readAcceptanceLedger(taskDir);
  const byId = new Map((stored?.criteria ?? []).map((entry) => [entry.id, entry]));
  return handoffAcceptanceCriteria(taskDir).map((criterion) => {
    const entry = byId.get(criterion.id);
    return {
      id: criterion.id,
      text: criterion.text,
      verdict: entry ? entry.verdict : null,
      ...(entry?.proofMode ? { proofMode: entry.proofMode } : {}),
      evidence: entry?.evidence ?? [],
      recipeNodes: entry?.recipeNodes ?? [],
      ...(entry?.note ? { note: entry.note } : {}),
      updatedAt: entry?.updatedAt ?? null,
    };
  });
}

/**
 * Terminal-contract issues for the ledger: every registered criterion needs a
 * verdict, and `weak` or `missing` fails unless the flow's contract waives it
 * (`acceptance.allowWeak`). Returns an empty array when the run has no criteria.
 */
function acceptanceContractIssues(taskDir, options = {}) {
  const criteria = handoffAcceptanceCriteria(taskDir);
  if (criteria.length === 0) return [];
  let stored;
  try {
    stored = readAcceptanceLedger(taskDir);
  } catch (err) {
    if (!(err instanceof AcceptanceRefusal)) throw err;
    return [err.message];
  }
  if (!stored) {
    return [
      `${ACCEPTANCE_STATUS_ARTIFACT} is missing but ${HANDOFF_INPUT} lists ${criteria.length} ` +
        'acceptance criteria — record a verdict for each with `farmslot-agent ac set <id> <verdict>`',
    ];
  }
  const issues = validateAcceptanceStatusLedger(stored);
  if (issues.length > 0) return issues;
  const known = new Set(criteria.map((criterion) => criterion.id));
  for (const entry of stored.criteria) {
    if (!known.has(entry.id)) {
      issues.push(
        `${ACCEPTANCE_STATUS_ARTIFACT}: ${entry.id} is not an acceptance criterion of this task`,
      );
    }
  }
  const byId = new Map(stored.criteria.map((entry) => [entry.id, entry]));
  for (const criterion of criteria) {
    const entry = byId.get(criterion.id);
    if (!entry) {
      issues.push(
        `${criterion.id} has no verdict — run \`farmslot-agent ac set ${criterion.id} <verdict>\``,
      );
      continue;
    }
    if (!options.allowWeak && (entry.verdict === 'missing' || entry.verdict === 'weak')) {
      issues.push(
        `${criterion.id} is ${entry.verdict}: prove it, or record \`untestable\` with a note ` +
          '(a flow may waive this with worker_terminal.acceptance.allowWeak)',
      );
    }
  }
  return issues;
}

module.exports = {
  ACCEPTANCE_CRITERION_ID_PATTERN,
  acceptanceCriteriaView,
  ACCEPTANCE_PROOF_MODES,
  ACCEPTANCE_STATUS_ARTIFACT,
  ACCEPTANCE_VERDICTS,
  AcceptanceRefusal,
  acceptanceContractIssues,
  acceptanceCriterionId,
  acceptanceStatusList,
  handoffAcceptanceCriteria,
  readAcceptanceLedger,
  renderAcceptanceCoverage,
  setAcceptanceVerdict,
  summarizeAcceptanceStatus,
  validateAcceptanceStatusLedger,
  writeAcceptanceLedger,
};
