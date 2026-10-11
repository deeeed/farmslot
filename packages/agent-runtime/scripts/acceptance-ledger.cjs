const fs = require('node:fs');
const path = require('node:path');

const { atomicWrite, readJson } = require('./mark-io.cjs');

// Acceptance-criteria ledger (ADR-060; contract in docs/reference/agent-runtime.md
// and docs/reference/task-directory-contract.md).
//
// This module is the only writer of artifacts/acceptance-status.json, the way
// `mark` is the only writer of SIGNAL.json. Two commands call it: `farmslot-agent ac`
// and a recipe run with a task dir, which records its proof targets
// (@farmslot/recipe-cli). The ids come from task init, which records the criteria in
// inputs/handoff.json; this module never invents one.
//
// Portable contract helpers are shared with protocol clients, including unbuilt slot scripts.

const HANDOFF_INPUT = path.join('inputs', 'handoff.json');
const {
  ACCEPTANCE_STATUS_ARTIFACT,
  ACCEPTANCE_VERDICTS,
  ACCEPTANCE_PROOF_MODES,
  ACCEPTANCE_CRITERION_ID_PATTERN,
  acceptanceCriterionId,
  validateAcceptanceStatusLedger,
  acceptanceCriteriaView,
  summarizeAcceptanceStatus,
  renderAcceptanceCoverage,
} = require('@farmslot/protocol/scripts/acceptance.cjs');

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
  return criteriaFromHandoff(readJson(path.join(taskDir, HANDOFF_INPUT)));
}

/** The `AC-<N>` list a parsed handoff carries; positions are the ids. */
function criteriaFromHandoff(handoff) {
  const task = isRecord(handoff.task) ? handoff.task : {};
  const criteria = Array.isArray(task.acceptanceCriteria) ? task.acceptanceCriteria : [];
  return criteria
    .map((text, index) => ({ id: acceptanceCriterionId(index), text: String(text) }))
    .filter((criterion) => criterion.text.trim().length > 0);
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
  return criteriaFromHandoff(handoff);
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
  if (stored?.schemaVersion === 2) {
    if (input.verdict !== 'untestable' || !input.note?.trim() || !input.actor?.trim())
      throw new AcceptanceRefusal(
        'Automatic claim verdicts are engine-owned; an untestable override requires actor and reason.',
      );
    const prior = stored.criteria.find((entry) => entry.id === input.id);
    if (!prior) throw new AcceptanceRefusal(`No automatic claim ${input.id} to override.`);
    const override = {
      actor: input.actor,
      reason: input.note,
      priorVerdict: prior.verdict,
      at: input.now ?? new Date().toISOString(),
    };
    const updated = {
      ...stored,
      criteria: stored.criteria.map((entry) =>
        entry.id === input.id
          ? {
              ...entry,
              verdict: 'untestable',
              note: input.note,
              overrides: [...(entry.overrides ?? []), override],
            }
          : entry,
      ),
    };
    writeAcceptanceLedger(taskDir, updated);
    return updated;
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

/** Transfer one engine-owned execution. Never aggregate sibling attempts. */
function setDerivedClaims(taskDir, claims) {
  if (claims.schemaVersion !== 2) throw new AcceptanceRefusal('Derived claims require schema 2.');
  const registered = handoffAcceptanceCriteria(taskDir);
  for (const criterion of registered) {
    const claim = claims.criteria.find((entry) => entry.id === criterion.id);
    if (!claim || claim.text !== criterion.text)
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
  writeAcceptanceLedger(taskDir, claims);
  return claims;
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
    if (
      !known.has(entry.id) &&
      (stored.schemaVersion === 1 || ACCEPTANCE_CRITERION_ID_PATTERN.test(entry.id))
    ) {
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
    if (
      entry.verdict === 'failed' ||
      entry.verdict === 'awaiting-review' ||
      (!options.allowWeak && (entry.verdict === 'missing' || entry.verdict === 'weak'))
    ) {
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
  requireHandoffAcceptanceCriteria,
  readAcceptanceLedger,
  renderAcceptanceCoverage,
  setAcceptanceVerdict,
  setDerivedClaims,
  summarizeAcceptanceStatus,
  validateAcceptanceStatusLedger,
  writeAcceptanceLedger,
};
