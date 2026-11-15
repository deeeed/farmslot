// Checklist order: a step is claimed after the ones before it, or not at all.
//
// A checked box records a claim, and a claim made out of order is not a smaller
// claim — it is a different one. Blind trial 40d98f79 marked step 13, the
// changed-file CI gate, while it was still on step 1, having applied a fix with
// no baseline behind it. Nothing refused that.
//
// `./mark N` now refuses while an earlier step is unchecked. The exception is
// declared in the template, never by the worker: a step whose title carries
//
//   - [ ] 11. Exit early if already fixed or not reproduced [OPTIONAL: the bug still reproduces]
//
// may be skipped with `./mark 11 --skip "<reason>"`, which records the reason in
// the ledger beside the step. A step without that marker can never be skipped,
// and completion refuses a checklist with a gap in it.

const fs = require('node:fs');
const path = require('node:path');

const { enumerateChecklistCheckboxes, signalFileForChecklist } = require('./checklist-target.cjs');
const { readJson } = require('./mark-io.cjs');

const OPTIONAL_REFERENCE = /\[OPTIONAL:\s*([^\]]+?)\s*\]/;

function optionalDeclarations(markdown, checklist) {
  return enumerateChecklistCheckboxes(markdown).flatMap((item) => {
    const match = item.rawLabel.match(OPTIONAL_REFERENCE);
    if (!match && item.rawLabel.includes('[OPTIONAL'))
      throw new Error(
        `Invalid optional declaration in ${checklist} step ${item.stepNumber}: ` +
          'use [OPTIONAL: <when it does not apply>]',
      );
    return match ? [{ checklist, stepNumber: item.stepNumber, when: match[1].trim() }] : [];
  });
}

/** Freeze the checklist's optional steps into the contract, as ADR-064 does for commands. */
function freezeOptionalSteps(contract, markdown, checklist) {
  const steps = optionalDeclarations(markdown, checklist);
  return steps.length ? { ...contract, optionalSteps: steps } : contract;
}

/**
 * The frozen optional steps plus any the live checklist carries, by step number.
 * The frozen contract is the record; a row added later still reads as optional,
 * because the worker cannot award itself a skip without the marker anyway.
 */
function declaredOptionalSteps(taskDir, checklist, contract) {
  const steps = new Map();
  for (const step of contract?.optionalSteps ?? []) {
    if (step.checklist === checklist) steps.set(step.stepNumber, step.when);
  }
  const file = path.join(taskDir, checklist);
  if (fs.existsSync(file)) {
    for (const step of optionalDeclarations(fs.readFileSync(file, 'utf8'), checklist)) {
      if (!steps.has(step.stepNumber)) steps.set(step.stepNumber, step.when);
    }
  }
  return steps;
}

/** Steps the worker skipped, with the reason it recorded, from the ledger. */
function skippedSteps(taskDir, checklist, signalFile) {
  const signal = readJson(path.join(taskDir, signalFile ?? signalFileForChecklist(checklist)));
  const events = Array.isArray(signal?.checklistTiming?.events)
    ? signal.checklistTiming.events
    : [];
  const skipped = new Map();
  for (const event of events) {
    if (event?.skipped === true && typeof event.stepNumber === 'number')
      skipped.set(event.stepNumber, typeof event.reason === 'string' ? event.reason : '');
  }
  return skipped;
}

function checklistItems(taskDir, checklist) {
  const file = path.join(taskDir, checklist);
  if (!fs.existsSync(file)) return [];
  return enumerateChecklistCheckboxes(fs.readFileSync(file, 'utf8'));
}

/**
 * The first step before `stepNumber` that is still unchecked, or null. A skipped
 * step is checked, so it does not hold the next one back.
 */
function firstUnmarkedEarlierStep(items, stepNumber) {
  return items.find((item) => item.stepNumber < stepNumber && !item.checked) ?? null;
}

/**
 * Completion issues: a gap, and a skip the template never allowed. The mark path
 * refuses both as they happen; these catch a checklist edited around it.
 */
function orderIssues(taskDir, checklist, contract, signalFile) {
  const items = checklistItems(taskDir, checklist);
  const optional = declaredOptionalSteps(taskDir, checklist, contract);
  const skipped = skippedSteps(taskDir, checklist, signalFile);
  const issues = [];
  const lastChecked = items.filter((item) => item.checked).pop();
  if (lastChecked) {
    for (const item of items) {
      if (item.stepNumber >= lastChecked.stepNumber || item.checked) continue;
      issues.push(
        `${checklist} step ${item.stepNumber} is unchecked while step ${lastChecked.stepNumber} ` +
          'is checked: steps are claimed in order, and an optional step is skipped with ' +
          `\`./mark ${item.stepNumber} --skip "<reason>"\``,
      );
    }
  }
  for (const [stepNumber, reason] of skipped) {
    if (!optional.has(stepNumber))
      issues.push(
        `${checklist} step ${stepNumber} was skipped (${reason || 'no reason recorded'}) but the ` +
          'template does not declare it optional',
      );
  }
  return issues;
}

module.exports = {
  OPTIONAL_REFERENCE,
  declarations: optionalDeclarations,
  freeze: freezeOptionalSteps,
  declared: declaredOptionalSteps,
  skipped: skippedSteps,
  items: checklistItems,
  firstUnmarkedEarlierStep,
  issues: orderIssues,
};
