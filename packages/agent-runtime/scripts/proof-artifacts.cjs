// Proof-artifact declarations: the evidence a checklist step claims.
//
// ADR-064 froze a step's deterministic command so a checked box could not stand
// in for an execution. This is the same shape for a proof step's output: a row
// declares the artifact it produces,
//
//   - [ ] 9. Retain the failing baseline run [PROOF: artifacts/recipe-baseline-run]
//
// and the declaration is frozen into the task's terminal contract at init.
// `./mark N` refuses the tick while that path is absent, and completion refuses a
// ticked step whose evidence is missing or was written after the step's last
// mark. A step without a declaration behaves exactly as before: templates that
// have not adopted the marker are untouched.

const fs = require('node:fs');
const path = require('node:path');

const { enumerateChecklistCheckboxes, signalFileForChecklist } = require('./checklist-target.cjs');
const { readJson } = require('./mark-io.cjs');
const checklistOrder = require('./checklist-order.cjs');

/** How an absent declared path reads in a refusal. */
const EVIDENCE_ABSENCE = {
  empty: 'empty',
  outside: 'outside the task directory',
  missing: 'missing',
};

const PROOF_REFERENCE = /\[PROOF:\s*([^\]]+?)\s*\]/;

/**
 * A declared path is task-relative: the worker writes it inside the task dir and
 * the gate reads it from there. An absolute or escaping path would point at
 * something the run does not own, so it is a template error, not a refusal.
 */
function normalizeProofPath(raw, checklist, stepNumber) {
  const normalized = String(raw).trim().split(path.sep).join('/');
  const invalid =
    normalized.length === 0 ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split('/').includes('..');
  if (invalid)
    throw new Error(
      `Invalid proof declaration in ${checklist} step ${stepNumber}: ` +
        `'${raw}' must be a path inside the task directory`,
    );
  return normalized;
}

function proofDeclarations(markdown, checklist) {
  return enumerateChecklistCheckboxes(markdown).flatMap((item) => {
    const match = item.rawLabel.match(PROOF_REFERENCE);
    if (!match && item.rawLabel.includes('[PROOF'))
      throw new Error(`Invalid proof declaration in ${checklist} step ${item.stepNumber}`);
    return match
      ? [
          {
            checklist,
            stepNumber: item.stepNumber,
            path: normalizeProofPath(match[1], checklist, item.stepNumber),
          },
        ]
      : [];
  });
}

/** Freeze the checklist's declarations into the contract, as ADR-064 does for commands. */
function freezeProofArtifacts(contract, markdown, checklist) {
  const steps = proofDeclarations(markdown, checklist);
  return steps.length ? { ...contract, proofArtifacts: steps } : contract;
}

/**
 * The frozen declarations plus any the live checklist carries. A row added after
 * init still gates: the contract is the record, never the waiver.
 */
function declaredProofArtifacts(taskDir, checklist, contract) {
  const frozen = (contract?.proofArtifacts ?? []).filter((step) => step.checklist === checklist);
  const file = path.join(taskDir, checklist);
  const live = fs.existsSync(file)
    ? proofDeclarations(fs.readFileSync(file, 'utf8'), checklist)
    : [];
  const steps = [...frozen];
  for (const step of live) {
    if (!steps.some((candidate) => candidate.stepNumber === step.stepNumber)) steps.push(step);
  }
  return steps;
}

/**
 * Evidence is present when the path exists and holds something: an empty
 * directory is the shape of a retained run that never ran.
 */
function proofEvidence(taskDir, relPath) {
  const target = path.join(taskDir, relPath);
  let stat;
  let resolved;
  try {
    // A declared path is evidence only where the task says it is: a symlink can
    // point the gate at a populated directory the run never produced, so the
    // resolved path has to stay inside the task directory.
    resolved = fs.realpathSync(target);
    const root = fs.realpathSync(taskDir);
    if (resolved !== root && !resolved.startsWith(root + path.sep))
      return { present: false, reason: 'outside', mtimeMs: null };
    stat = fs.statSync(resolved);
  } catch (error) {
    if (error.code === 'ENOENT') return { present: false, reason: 'missing', mtimeMs: null };
    throw error;
  }
  if (stat.isDirectory()) {
    // Read the resolved directory and never follow a child link: an inside
    // directory of symlinks must not stand in for files the run never wrote.
    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    const own = entries.filter((entry) => !entry.isSymbolicLink());
    if (own.length === 0) return { present: false, reason: 'empty', mtimeMs: null };
    const newest = own.reduce((latest, entry) => {
      try {
        return Math.max(latest, fs.lstatSync(path.join(resolved, entry.name)).mtimeMs);
      } catch {
        return latest;
      }
    }, stat.mtimeMs);
    return { present: true, reason: null, mtimeMs: newest };
  }
  if (stat.size === 0) return { present: false, reason: 'empty', mtimeMs: null };
  return { present: true, reason: null, mtimeMs: stat.mtimeMs };
}

/**
 * When each step was last marked, from the signal the mark engine writes. The
 * caller passes the signal it selected (`mark --signal`), because a run using
 * that escape hatch keeps its claims there and not in the derived name.
 */
function stepMarkTimes(taskDir, checklist, signalFile) {
  const signal = readJson(path.join(taskDir, signalFile ?? signalFileForChecklist(checklist)));
  const events = Array.isArray(signal?.checklistTiming?.events)
    ? signal.checklistTiming.events
    : [];
  const times = new Map();
  for (const event of events) {
    if (!event || typeof event.stepNumber !== 'number') continue;
    const stamp = Date.parse(event.remarkedAt ?? event.checkedAt ?? '');
    if (!Number.isNaN(stamp)) times.set(event.stepNumber, stamp);
  }
  return times;
}

function checkedSteps(taskDir, checklist) {
  const file = path.join(taskDir, checklist);
  if (!fs.existsSync(file)) return new Set();
  return new Set(
    enumerateChecklistCheckboxes(fs.readFileSync(file, 'utf8'))
      .filter((item) => item.checked)
      .map((item) => item.stepNumber),
  );
}

/**
 * Why `./mark N` cannot tick this step yet, or null when it can. Only a declared
 * step can refuse, and only for absent evidence — the tick is the claim, so the
 * artifact has to exist before it.
 */
function pendingProofArtifact(taskDir, checklist, stepNumber, contract) {
  const step = declaredProofArtifacts(taskDir, checklist, contract).find(
    (candidate) => candidate.stepNumber === stepNumber,
  );
  if (!step) return null;
  const evidence = proofEvidence(taskDir, step.path);
  if (evidence.present) return null;
  return (
    `step ${stepNumber} declares its proof at ${step.path}, which is ` +
    `${EVIDENCE_ABSENCE[evidence.reason] ?? 'missing'}. ` +
    'Produce the evidence, then mark the step.'
  );
}

/**
 * The one definition of "the evidence is newer than the claim". A mark and a
 * completion must not decide this differently, so both callers come here. Null
 * when the step declares nothing, has no evidence, or was never marked.
 */
function claimOlderThanEvidence(taskDir, checklist, stepNumber, contract, signalFile) {
  const step = declaredProofArtifacts(taskDir, checklist, contract).find(
    (candidate) => candidate.stepNumber === stepNumber,
  );
  if (!step) return null;
  const evidence = proofEvidence(taskDir, step.path);
  const markedAt = stepMarkTimes(taskDir, checklist, signalFile).get(stepNumber);
  if (!evidence.present || evidence.mtimeMs == null || markedAt == null) return null;
  return evidence.mtimeMs > markedAt ? { step, evidence, markedAt } : null;
}

/**
 * Completion issues for declared steps: a ticked step needs its evidence, and
 * evidence written after the step's last mark means the claim came first. An
 * unticked step is simply unfinished work and not an issue here.
 */
function proofArtifactIssues(taskDir, checklist, contract, signalFile) {
  const ticked = checkedSteps(taskDir, checklist);
  // A skipped step claims the work did not apply, so it owes no evidence. The
  // skip itself is only granted on a template-declared optional step, and the
  // order check refuses one that was not.
  const skipped = checklistOrder.skipped(taskDir, checklist, signalFile);
  const issues = [];
  for (const step of declaredProofArtifacts(taskDir, checklist, contract)) {
    if (!ticked.has(step.stepNumber) || skipped.has(step.stepNumber)) continue;
    const evidence = proofEvidence(taskDir, step.path);
    if (!evidence.present) {
      issues.push(
        `${checklist} step ${step.stepNumber} is checked but its declared proof ${step.path} is ` +
          `${EVIDENCE_ABSENCE[evidence.reason] ?? 'missing'}`,
      );
      continue;
    }
    const late = claimOlderThanEvidence(taskDir, checklist, step.stepNumber, contract, signalFile);
    if (late) {
      issues.push(
        `${checklist} step ${step.stepNumber}: its declared proof ${step.path} was written ` +
          `${new Date(late.evidence.mtimeMs).toISOString()}, after the step was marked ` +
          `${new Date(late.markedAt).toISOString()}; mark the step again now the evidence is current`,
      );
    }
  }
  return issues;
}

/**
 * Steps marked after a later-numbered step, recorded for the run record only.
 * Order alone proves nothing about the work, so it never refuses anything.
 */
function outOfOrderMarks(events) {
  const ordered = (Array.isArray(events) ? events : [])
    .filter((event) => event && typeof event.stepNumber === 'number' && event.checkedAt)
    .map((event) => ({ stepNumber: event.stepNumber, checkedAt: event.checkedAt }));
  const anomalies = [];
  let highest = 0;
  for (const event of ordered) {
    if (event.stepNumber < highest)
      anomalies.push({ stepNumber: event.stepNumber, checkedAt: event.checkedAt, after: highest });
    highest = Math.max(highest, event.stepNumber);
  }
  return anomalies;
}

module.exports = {
  PROOF_REFERENCE,
  declarations: proofDeclarations,
  freeze: freezeProofArtifacts,
  declared: declaredProofArtifacts,
  evidence: proofEvidence,
  pending: pendingProofArtifact,
  issues: proofArtifactIssues,
  claimOlderThanEvidence,
  outOfOrderMarks,
};
