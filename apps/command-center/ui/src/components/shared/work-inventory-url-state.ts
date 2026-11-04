import { viewChoiceField } from '@farmslot/protocol';

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
  return {
    key: viewChoiceField(sortParamName(options), options.defaultKey, options.validKeys).read(
      params,
    ),
    direction: viewChoiceField<WorkInventorySortDirection>(
      directionParamName(options),
      options.defaultDirection ?? 'desc',
      ['asc', 'desc'],
    ).read(params),
  };
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
  viewChoiceField(sortParamName(options), options.defaultKey, options.validKeys).write(
    params,
    state.key,
  );
  viewChoiceField<WorkInventorySortDirection>(
    directionParamName(options),
    options.defaultDirection ?? 'desc',
    ['asc', 'desc'],
  ).write(params, state.direction);
  return params;
}
