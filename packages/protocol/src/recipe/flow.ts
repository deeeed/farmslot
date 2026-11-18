import { isRecord, type RecipeFlowUpdate } from './common.js';

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
