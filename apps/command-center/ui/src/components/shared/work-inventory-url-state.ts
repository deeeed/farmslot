import type {
  WorkInventorySortDirection,
  WorkInventorySortState,
  WorkInventoryUrlSortOptions,
} from './work-inventory-types.js';

const DEFAULT_SORT_PARAM = 'sort';
const DEFAULT_DIRECTION_PARAM = 'direction';

function sortParamName<TSortKey extends string>(options: WorkInventoryUrlSortOptions<TSortKey>) {
  return options.sortParam ?? DEFAULT_SORT_PARAM;
}

function directionParamName<TSortKey extends string>(
  options: WorkInventoryUrlSortOptions<TSortKey>,
) {
  return options.directionParam ?? DEFAULT_DIRECTION_PARAM;
}

/**
 * Parse sort key + direction from route-scoped hash params.
 * Invalid keys fall back to defaults; unknown direction falls back to default.
 */
export function parseWorkInventorySort<TSortKey extends string>(
  params: URLSearchParams,
  options: WorkInventoryUrlSortOptions<TSortKey>,
): WorkInventorySortState<TSortKey> {
  const rawKey = params.get(sortParamName(options));
  const key =
    rawKey && (options.validKeys as readonly string[]).includes(rawKey)
      ? (rawKey as TSortKey)
      : options.defaultKey;
  const rawDirection = params.get(directionParamName(options));
  const defaultDirection = options.defaultDirection ?? 'desc';
  const direction: WorkInventorySortDirection =
    rawDirection === 'asc' || rawDirection === 'desc' ? rawDirection : defaultDirection;
  return { key, direction };
}

/**
 * Write sort state into hash params. Omits defaults so URLs stay short.
 * Mutates and returns the same `params` instance.
 */
export function applyWorkInventorySort<TSortKey extends string>(
  params: URLSearchParams,
  state: WorkInventorySortState<TSortKey>,
  options: WorkInventoryUrlSortOptions<TSortKey>,
): URLSearchParams {
  const sortParam = sortParamName(options);
  const directionParam = directionParamName(options);
  const defaultDirection = options.defaultDirection ?? 'desc';

  if (state.key === options.defaultKey) params.delete(sortParam);
  else params.set(sortParam, state.key);

  if (state.direction === defaultDirection) params.delete(directionParam);
  else params.set(directionParam, state.direction);

  return params;
}
