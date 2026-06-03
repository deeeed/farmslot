import { buildHash, parseHashRoute } from '../../utils/url-state.js';

export type FleetCanvasGroupBy = 'machine' | 'project' | 'resource';
export type FleetCanvasViewMode = 'card' | 'list';

export interface FleetCanvasUrlState {
  groupBy: FleetCanvasGroupBy;
  viewMode: FleetCanvasViewMode;
  fleetRefreshOpen: boolean;
}

export interface FleetCanvasUrlFallbacks {
  groupBy?: string | null;
  viewMode?: string | null;
}

const GROUP_PARAM = 'group';
const VIEW_PARAM = 'view';
const REFRESH_PARAM = 'refresh';

function isFleetCanvasGroupBy(value: string | null): value is FleetCanvasGroupBy {
  return value === 'machine' || value === 'project' || value === 'resource';
}

function isFleetCanvasViewMode(value: string | null): value is FleetCanvasViewMode {
  return value === 'card' || value === 'list';
}

function isTruthyUrlFlag(value: string | null): boolean {
  const normalized = value?.toLowerCase();
  return (
    normalized === '1' ||
    normalized === 'open' ||
    normalized === 'true' ||
    normalized === 'yes' ||
    normalized === 'on'
  );
}

export function fleetCanvasUrlStateFromHash(
  hash: string = location.hash,
  fallbacks: FleetCanvasUrlFallbacks = {},
): FleetCanvasUrlState {
  const { params } = parseHashRoute(hash);
  const group = params.get(GROUP_PARAM);
  const view = params.get(VIEW_PARAM);
  const fallbackGroup = fallbacks.groupBy ?? null;
  const fallbackView = fallbacks.viewMode ?? null;
  return {
    groupBy: isFleetCanvasGroupBy(group)
      ? group
      : isFleetCanvasGroupBy(fallbackGroup)
        ? fallbackGroup
        : 'machine',
    viewMode: isFleetCanvasViewMode(view)
      ? view
      : isFleetCanvasViewMode(fallbackView)
        ? fallbackView
        : 'card',
    fleetRefreshOpen: isTruthyUrlFlag(params.get(REFRESH_PARAM)),
  };
}

export function fleetCanvasUrlStateHash(
  state: FleetCanvasUrlState,
  hash: string = location.hash,
): string | null {
  const { route, params } = parseHashRoute(hash);
  if (!route.startsWith('fleet')) return null;
  params.set(GROUP_PARAM, state.groupBy);
  params.set(VIEW_PARAM, state.viewMode);
  if (state.fleetRefreshOpen) params.set(REFRESH_PARAM, '1');
  else params.delete(REFRESH_PARAM);
  return buildHash(route, params);
}
