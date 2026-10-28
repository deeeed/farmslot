const fs = require('node:fs');
const path = require('node:path');

const { atomicWrite, readJson } = require('./mark-io.cjs');

// Acceptance-criteria ledger (ADR-060; contract in docs/reference/agent-runtime.md
// and docs/reference/task-directory-contract.md).
//
// The engine derives schema-2 verdicts. This module transfers the selected engine
// ledger into the task namespace (a QA task merges its case executions by claim
// id); `farmslot-agent ac` only reads it. Retained
// schema-1 ledgers remain display input, never current completion proof. The ids
// come from task init in inputs/handoff.json; this module never invents one.
//
// Portable contract helpers are shared with protocol clients, including unbuilt slot scripts.

const HANDOFF_INPUT = path.join('inputs', 'handoff.json');
const {
  ACCEPTANCE_STATUS_ARTIFACT,
  ACCEPTANCE_REGISTRATION_INPUT,
  INHERITED_ACCEPTANCE_INPUT,
  ACCEPTANCE_VERDICTS,
  ACCEPTANCE_PROOF_MODES,
  ACCEPTANCE_CRITERION_ID_PATTERN,
  acceptanceCriterionId,
  acceptanceCriteriaMatch,
  acceptanceRowExecution,
  registeredAcceptanceCriteria,
  validateAcceptanceStatusLedger,
  acceptanceCriteriaView,
  summarizeAcceptanceStatus,
  renderAcceptanceCoverage,
} = require('@farmslot/protocol/scripts/acceptance.mjs');

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
function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function ledgerPath(taskDir) {
  return path.join(taskDir, ACCEPTANCE_STATUS_ARTIFACT);
}

/**
 * The criteria task init recorded, as `{ id, text }` in handoff order. An empty
 * array means this run has no acceptance criteria, so the ledger does not apply.
 */
function handoffAcceptanceCriteria(taskDir) {
  return criteriaFromHandoff(readJson(path.join(taskDir, HANDOFF_INPUT)), taskDir);
}

/** The `AC-<N>` list a parsed handoff carries; positions are the ids. */
function criteriaFromHandoff(handoff, taskDir) {
  const task = isRecord(handoff.task) ? handoff.task : {};
  const criteria = Array.isArray(task.acceptanceCriteria) ? task.acceptanceCriteria : [];
  const projection = taskDir ? readJson(path.join(taskDir, ACCEPTANCE_REGISTRATION_INPUT)) : {};
  if (Object.keys(projection).length) {
    if (projection.schemaVersion !== 1 || projection.registration?.runId !== handoff.attemptId)
      throw new AcceptanceRefusal(
        'acceptance registration belongs to another task or unsupported version',
      );
    return registeredAcceptanceCriteria(criteria, projection.registration);
  }
  if (handoff.executionTemplate?.firstSubtask === 'derive-acceptance')
    throw new AcceptanceRefusal(
      'acceptance registration transport is missing; restore it from the gateway',
    );
  return registeredAcceptanceCriteria(criteria);
}

function pendingInitialAcceptanceDerivation(taskDir) {
  const handoff = readJson(path.join(taskDir, HANDOFF_INPUT));
  if (handoff.executionTemplate?.firstSubtask !== 'derive-acceptance') return false;
  // Reading the registered list also checks task identity and projection version.
  handoffAcceptanceCriteria(taskDir);
  const projection = readJson(path.join(taskDir, ACCEPTANCE_REGISTRATION_INPUT));
  return !projection.registration?.units?.find(({ id }) => id === 'derive-acceptance')?.result;
}

/**
 * Same read, for the path that enforces the ledger. A missing handoff means no
 * criteria, as ENOENT does everywhere; anything else — unreadable file, invalid
 * JSON, a non-array `acceptanceCriteria` — refuses, because a task whose criteria
 * cannot be read has not proven them. The permissive reader above still serves
 * `ac list` / `ac render`, where a broken handoff is the CLI's own refusal.
 *
 * The gateway's terminal check applies the identical rule from the slot, so a
 * signal written around this engine cannot pass what `mark` refuses.
 */
function requireHandoffAcceptanceCriteria(taskDir) {
  let handoff;
  try {
    handoff = readJson(path.join(taskDir, HANDOFF_INPUT));
  } catch (err) {
    throw new AcceptanceRefusal(handoffReadRefusal(`invalid ${HANDOFF_INPUT}: ${err.message}`));
  }
  const task = isRecord(handoff.task) ? handoff.task : {};
  if (task.acceptanceCriteria !== undefined && !Array.isArray(task.acceptanceCriteria)) {
    throw new AcceptanceRefusal(
      handoffReadRefusal(`invalid ${HANDOFF_INPUT}: task.acceptanceCriteria must be an array`),
    );
  }
  // One parse: the handoff read above is the only one this path makes.
  return criteriaFromHandoff(handoff, taskDir);
}

/** PR completion checks worker-derived requirements; original ACs remain evidence. */
function workerAcceptanceCriteria(taskDir) {
  const criteria = requireHandoffAcceptanceCriteria(taskDir);
  if (readJson(path.join(taskDir, HANDOFF_INPUT)).flow !== 'pr-complete') return criteria;
  const { registration } = readJson(path.join(taskDir, ACCEPTANCE_REGISTRATION_INPUT));
  const derived = new Set((registration?.derived ?? []).map(({ id }) => id));
  return criteria.filter(({ id }) => derived.has(id));
}

/** One message shape for a handoff the acceptance rule cannot read. */
function handoffReadRefusal(detail) {
  return (
    `cannot complete: ${detail}. The acceptance criteria (ADR-060) come from that file, so ` +
    `nothing can tell whether every criterion has a verdict. Restore ${HANDOFF_INPUT} from the ` +
    `orchestrator copy, then run ./mark complete again.`
  );
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
  if (ledger?.schemaVersion !== 2) {
    throw new AcceptanceRefusal(
      'Only schema-2 engine claims may be written; schema-1 ledgers are retained display only.',
    );
  }
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
 * Transfer one engine-owned execution. Never aggregate sibling attempts of one
 * recipe. A QA task records one package per case, so its ledger merges instead:
 * see `mergeCaseClaims`.
 */
function setDerivedClaims(taskDir, claims) {
  if (claims.schemaVersion !== 2) throw new AcceptanceRefusal('Derived claims require schema 2.');
  const handoff = readJson(path.join(taskDir, HANDOFF_INPUT));
  const registered = criteriaFromHandoff(handoff, taskDir);
  const inherited = inheritedCriterionIdsForTask(taskDir, registered);
  for (const criterion of registered) {
    const claim = claims.criteria.find((entry) => entry.id === criterion.id);
    if (!claim && inherited.has(criterion.id)) continue;
    if (
      !claim ||
      claim.text !== criterion.text ||
      (criterion.proofMode && claim.proofMode !== criterion.proofMode)
    )
      throw new AcceptanceRefusal(
        `Engine claim ${criterion.id} does not match the registered task.`,
      );
  }
  for (const claim of claims.criteria) {
    if (
      ACCEPTANCE_CRITERION_ID_PATTERN.test(claim.id) &&
      !registered.some((entry) => entry.id === claim.id)
    )
      throw new AcceptanceRefusal(`Unknown task claim ${claim.id}.`);
    for (const file of claim.evidence) assertEvidencePath(taskDir, file);
  }
  const ledger = handoff.flow === 'qa' ? mergeCaseClaims(taskDir, registered, claims) : claims;
  writeAcceptanceLedger(taskDir, ledger);
  return ledger;
}

/**
 * The retained package a task row came from: the directory of its transported
 * trace whose engine claims still name the row's execution, or null.
 */
function rowPackageDir(taskDir, row, execution) {
  for (const file of row.evidence ?? []) {
    if (path.posix.basename(file) !== 'trace.json') continue;
    const dir = path.join(taskDir, path.posix.dirname(file));
    let claims;
    try {
      claims = JSON.parse(fs.readFileSync(path.join(dir, 'acceptance-status.json'), 'utf8'));
    } catch (err) {
      // A directory without readable engine claims is not a package of this row.
      if (err.code === 'ENOENT' || err instanceof SyntaxError) continue;
      throw err;
    }
    if (isRecord(claims) && claims.recipeRunId === execution) return dir;
  }
  return null;
}

/**
 * One QA ledger keyed by claim id. A row the new execution addresses (a selected
 * node proves it) replaces the stored row; every other stored row keeps the case
 * execution it came from. Each row names its execution, so the gate can bind it
 * to that case's package.
 */
function mergeCaseClaims(taskDir, registered, claims) {
  let stored;
  try {
    stored = readAcceptanceLedger(taskDir);
  } catch (err) {
    // An unreadable stored ledger holds no row to keep; this execution replaces it.
    if (!(err instanceof AcceptanceRefusal)) throw err;
    stored = null;
  }
  const kept = new Map();
  if (stored?.schemaVersion === 2 && validateAcceptanceStatusLedger(stored).length === 0) {
    for (const row of stored.criteria) {
      const registration = registered.find(({ id }) => id === row.id);
      if (ACCEPTANCE_CRITERION_ID_PATTERN.test(row.id) && registration?.text !== row.text) continue;
      const execution = acceptanceRowExecution(stored, row);
      // A row whose evidence is gone, or whose case directory now holds another
      // execution, has nothing left to bind; the new row stands.
      if (
        !row.evidence.every((file) => fs.existsSync(path.join(taskDir, file))) ||
        !rowPackageDir(taskDir, row, execution)
      )
        continue;
      kept.set(row.id, { ...row, recipeRunId: execution });
    }
  }
  const criteria = claims.criteria.map((row) =>
    row.recipeNodes.length === 0 && kept.has(row.id)
      ? kept.get(row.id)
      : { ...row, recipeRunId: claims.recipeRunId },
  );
  const ids = new Set(criteria.map(({ id }) => id));
  for (const row of kept.values()) if (!ids.has(row.id)) criteria.push(row);
  return { ...claims, criteria };
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
/** Validate the frozen version-1 reference against original rows only. */
function inheritedCriterionIdsForTask(taskDir, criteria, requireFresh = false) {
  const base = readJson(path.join(taskDir, 'inputs/worker-terminal-contract.json'));
  if (
    requireFresh ||
    base.acceptance?.requireFresh ||
    !fs.existsSync(path.join(taskDir, INHERITED_ACCEPTANCE_INPUT))
  )
    return new Set();
  const projection = readJson(path.join(taskDir, ACCEPTANCE_REGISTRATION_INPUT));
  const original = projection.registration?.original ?? criteria;
  let reference;
  let handoff;
  try {
    reference = readJson(path.join(taskDir, INHERITED_ACCEPTANCE_INPUT));
    handoff = readJson(path.join(taskDir, HANDOFF_INPUT));
  } catch (error) {
    throw new AcceptanceRefusal(`Inherited acceptance reference cannot be read: ${error.message}`);
  }
  if (
    !isRecord(reference) ||
    reference.schemaVersion !== 1 ||
    reference.source !== 'parent-run' ||
    typeof reference.childRunId !== 'string' ||
    !reference.childRunId ||
    typeof reference.project !== 'string' ||
    !reference.project ||
    handoff.flow !== 'pr-complete' ||
    reference.childRunId !== handoff.attemptId ||
    reference.project !== handoff.project ||
    typeof reference.parentRunId !== 'string' ||
    !reference.parentRunId ||
    reference.parentRunId === reference.childRunId ||
    typeof reference.headSha !== 'string' ||
    !/^[a-f0-9]{7,40}$/i.test(reference.headSha) ||
    typeof reference.ledgerHash !== 'string' ||
    !/^[a-f0-9]{64}$/i.test(reference.ledgerHash) ||
    !acceptanceCriteriaMatch(original, reference.criteria)
  )
    throw new AcceptanceRefusal(
      'Inherited acceptance reference does not match this follow-up task.',
    );
  return new Set(reference.criteria.map(({ id }) => id));
}

function acceptanceContractIssues(taskDir, options = {}) {
  let criteria;
  try {
    criteria = requireHandoffAcceptanceCriteria(taskDir);
  } catch (err) {
    if (!(err instanceof AcceptanceRefusal)) throw err;
    return [err.message];
  }
  const projection = readJson(path.join(taskDir, ACCEPTANCE_REGISTRATION_INPUT));
  const pending = projection.registration?.units?.filter((unit) => !unit.result) ?? [];
  if (pending.length)
    return pending.map(
      (unit) =>
        `Acceptance derivation ${unit.id} is pending${unit.error ? `: ${unit.error}` : '; complete the source classification subtask'}.`,
    );
  if (criteria.length === 0) return [];
  const completion = readJson(path.join(taskDir, HANDOFF_INPUT)).flow === 'pr-complete';
  const known = new Set(criteria.map(({ id }) => id));
  if (completion) {
    criteria = workerAcceptanceCriteria(taskDir);
    if (!criteria.length) return [];
  }
  try {
    const inherited = inheritedCriterionIdsForTask(taskDir, criteria, options.requireFresh);
    criteria = criteria.filter(({ id }) => !inherited.has(id));
  } catch (error) {
    if (!(error instanceof AcceptanceRefusal)) throw error;
    return [error.message];
  }
  if (!criteria.length) return [];
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
        'acceptance criteria. Run the task recipe with an eligible assertion for each criterion.',
    ];
  }
  if (stored.schemaVersion !== 2) {
    return [
      `${ACCEPTANCE_STATUS_ARTIFACT}: legacy schema-1 verdicts are display only. Run the task recipe to obtain schema-2 engine claims.`,
    ];
  }
  const issues = validateAcceptanceStatusLedger(stored);
  if (issues.length > 0) return issues;
  for (const entry of stored.criteria) {
    if (!known.has(entry.id) && ACCEPTANCE_CRITERION_ID_PATTERN.test(entry.id)) {
      issues.push(
        `${ACCEPTANCE_STATUS_ARTIFACT}: ${entry.id} is not an acceptance criterion of this task`,
      );
    }
  }
  const byId = new Map(stored.criteria.map((entry) => [entry.id, entry]));
  if (stored.criteria.some((entry) => entry.overrides !== undefined))
    issues.push(
      'Unverified local overrides require a canonical engine projection; they grant no review authority.',
    );
  for (const criterion of criteria) {
    const entry = byId.get(criterion.id);
    if (!entry) {
      issues.push(
        `${criterion.id} has no engine verdict. Run the task recipe with an eligible assertion for this criterion.`,
      );
      continue;
    }
    const retainedReviewEvidence =
      completion &&
      entry.verdict === 'awaiting-review' &&
      ['visual', 'mixed', 'review'].includes(entry.proofMode);
    if (
      (completion || options.deferClaimVerdicts !== true) &&
      !retainedReviewEvidence &&
      (entry.verdict === 'failed' ||
        entry.verdict === 'awaiting-review' ||
        (!options.allowWeak && (entry.verdict === 'missing' || entry.verdict === 'weak')))
    ) {
      issues.push(
        `${criterion.id} is ${entry.verdict}: run an eligible recipe assertion or request human evidence review.`,
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
  workerAcceptanceCriteria,
  acceptanceCriterionId,
  acceptanceRowExecution,
  acceptanceStatusList,
  handoffAcceptanceCriteria,
  pendingInitialAcceptanceDerivation,
  inheritedCriterionIdsForTask,
  requireHandoffAcceptanceCriteria,
  readAcceptanceLedger,
  renderAcceptanceCoverage,
  rowPackageDir,
  setDerivedClaims,
  summarizeAcceptanceStatus,
  validateAcceptanceStatusLedger,
  writeAcceptanceLedger,
};
