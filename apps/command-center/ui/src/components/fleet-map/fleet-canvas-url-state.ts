import { viewChoiceField, viewTextField } from '@farmslot/protocol';

import { buildHash, parseHashRoute } from '../../utils/url-state.js';

export type FleetCanvasGroupBy = 'machine' | 'project' | 'resource';
export type FleetCanvasViewMode = 'card' | 'list';

export interface FleetCanvasUrlState {
  groupBy: FleetCanvasGroupBy;
  viewMode: FleetCanvasViewMode;
  fleetRefreshOpen: boolean;
}

const fields = {
  groupBy: viewChoiceField('group', 'machine', ['machine', 'project', 'resource']),
  viewMode: viewChoiceField('view', 'list', ['card', 'list']),
  refresh: viewChoiceField('refresh', '', ['', '1', 'open', 'true', 'yes', 'on']),
};

export function fleetCanvasUrlStateFromHash(hash: string = location.hash): FleetCanvasUrlState {
  const { params } = parseHashRoute(hash);
  return {
    groupBy: fields.groupBy.read(params),
    viewMode: fields.viewMode.read(params),
    fleetRefreshOpen: fields.refresh.read(params) !== '',
  };
}

export function fleetCanvasUrlStateHash(
  state: FleetCanvasUrlState,
  hash: string = location.hash,
): string | null {
  const { route, params } = parseHashRoute(hash);
  if (!route.startsWith('fleet')) return null;
  fields.groupBy.write(params, state.groupBy);
  fields.viewMode.write(params, state.viewMode);
  viewTextField('refresh').write(params, state.fleetRefreshOpen ? '1' : '');
  return buildHash(route, params);
}
