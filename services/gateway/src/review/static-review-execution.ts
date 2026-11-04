/** Shared by slot reviewers and slot-free static workspaces. */
export const STATIC_REVIEW_EXECUTION_RULE =
  'Static-code review reads the diff, source, recorded evidence, CI results and CI receipts only. ' +
  'Tests and code validation belong to CI. Do not run tests, builds, recipes, installs, probes or ad hoc validation scripts. ' +
  'Do not change source or dependency state. Write only the required review artifacts and checklist progress. ' +
  'Read recorded deterministic-check receipts and their logs; do not execute their commands or mark their worker steps. ' +
  'A claim without recorded evidence is a finding or must be marked unverified. Never present inspection as execution.';
