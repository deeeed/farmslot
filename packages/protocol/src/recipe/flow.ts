import {
  isRecord,
  type RecipeFlowTiming,
  type RecipeFlowUpdate,
  type RecipeInvocationBreadcrumb,
} from './common.js';

const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const identity = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/** Decode the optional producer update without turning unavailable totals into zero. */
export function isRecipeFlowUpdate(value: unknown): value is RecipeFlowUpdate {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !identity(value.recipeRunId) ||
    !identity(value.rootId) ||
    !(value.activeId === null || identity(value.activeId)) ||
    !isRecord(value.progress)
  )
    return false;
  if (value.ancestry !== undefined && !validAncestry(value.ancestry, value.rootId, value.activeId))
    return false;
  if (value.timing !== undefined && !validTiming(value.timing)) return false;
  const p = value.progress;
  if (
    !count(p.current) ||
    !count(p.completed) ||
    p.current < p.completed ||
    p.current > p.completed + 1
  )
    return false;
  if (p.qualification === 'unknown') return p.total === null && p.remaining === null;
  return (
    p.qualification === 'exact' &&
    count(p.total) &&
    count(p.remaining) &&
    p.total >= p.current &&
    p.remaining === p.total - p.completed
  );
}

function isBreadcrumb(value: unknown): value is RecipeInvocationBreadcrumb {
  return isRecord(value) && identity(value.id) && typeof value.label === 'string';
}

function validAncestry(value: unknown, rootId: string, activeId: string | null): boolean {
  if (value === null) return activeId === null;
  if (
    activeId === null ||
    !isRecord(value) ||
    !count(value.depth) ||
    !(value.parentId === null || identity(value.parentId)) ||
    !Array.isArray(value.breadcrumbs) ||
    !value.breadcrumbs.every(isBreadcrumb)
  )
    return false;
  const ids = value.breadcrumbs.map((item) => item.id);
  return (
    ids.length === value.depth + 1 &&
    new Set(ids).size === ids.length &&
    ids[0] === rootId &&
    ids.at(-1) === activeId &&
    value.parentId === (ids.length === 1 ? null : ids.at(-2))
  );
}

function validMetric(value: unknown, qualification: unknown): boolean {
  return qualification === 'unknown'
    ? value === null
    : (qualification === 'measured' || qualification === 'partial') &&
        typeof value === 'number' &&
        Number.isFinite(value) &&
        value >= 0;
}
function validTiming(value: unknown): value is RecipeFlowTiming {
  if (!isRecord(value) || !isRecord(value.nodes) || !isRecord(value.claimTimings)) return false;
  const rollup = (row: unknown) =>
    isRecord(row) &&
    validMetric(row.durationMs, row.qualification) &&
    Array.isArray(row.invocationIds) &&
    row.invocationIds.every(identity);
  return (
    Object.values(value.nodes).every(
      (row) =>
        isRecord(row) &&
        isRecord(row.qualification) &&
        validMetric(row.inclusiveMs, row.qualification.inclusive) &&
        validMetric(row.selfMs, row.qualification.self) &&
        (row.inclusiveMs === null ||
          row.selfMs === null ||
          Number(row.selfMs) <= Number(row.inclusiveMs)),
    ) &&
    Object.values(value.claimTimings).every(rollup) &&
    rollup(value.unassignedTiming)
  );
}
