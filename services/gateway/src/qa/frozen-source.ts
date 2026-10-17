import type { QaInput, QaProfileSelection, Run } from '@farmslot/protocol';

import { getRun, updateRun } from '../runs/store.js';

const EXACT_COMMIT_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

function isQaObject(value: QaInput | undefined): value is { [key: string]: QaInput } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactCommit(value: QaInput | undefined): string | undefined {
  return typeof value === 'string' && EXACT_COMMIT_RE.test(value) ? value : undefined;
}

/**
 * The commits an admitted ref or range QA scope names exactly, read as the Recipe
 * QA resolver reads it: a same-kind preset scope under the admitted one. A ref
 * compares against its own head. Branch or tag names and window scopes resolve
 * only when the skill runs, so they freeze nothing here.
 */
export function qaScopeSource(qa: QaProfileSelection | undefined): Run['qaSource'] {
  const preset = qa?.profile.inputs?.scope;
  const admitted = qa?.inputs.scope;
  if (!isQaObject(admitted)) return undefined;
  const scope =
    isQaObject(preset) && (admitted.kind === undefined || admitted.kind === preset.kind)
      ? { ...preset, ...admitted }
      : admitted;
  if (scope.kind === 'ref') {
    const head = exactCommit(scope.expectedHeadSha ?? scope.ref);
    return head ? { baseSha: head, headSha: head } : undefined;
  }
  if (scope.kind !== 'range') return undefined;
  const head = exactCommit(scope.expectedHeadSha ?? scope.head);
  const base = exactCommit(scope.expectedBaseSha ?? scope.base);
  return head && base ? { baseSha: base, headSha: head } : undefined;
}

/**
 * Freeze a non-PR QA run's source identity from its admitted scope, as fetchPRData
 * does for a PR. Prepare lands on its head and completion validates against it.
 * An existing identity is never replaced.
 */
export function ensureFrozenQaSource(runId: string): Run | undefined {
  const run = getRun(runId);
  if (!run || run.flowType !== 'qa' || run.qaSource) return run;
  const qaSource = qaScopeSource(run.qa);
  return qaSource ? updateRun(runId, { qaSource }) : run;
}
