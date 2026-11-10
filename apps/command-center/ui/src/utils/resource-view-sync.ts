import { Methods } from '@farmslot/protocol';
import type { ResourceQuery, ResourceReadMethod } from '@farmslot/protocol/client-cache';

/** Primary data for a screen; secondary panels retain their own read/error indicators. */
const viewMethods: Record<string, readonly ResourceReadMethod[]> = {
  runs: [Methods.RUN_LIST],
  run: [Methods.RUN_GET],
  family: [Methods.FAMILY_OBSERVABILITY_GET],
  fleet: [Methods.FLEET_STATUS],
  slot: [Methods.FLEET_STATUS],
  decisions: [Methods.DECISION_LIST],
  dispatch: [Methods.DISPATCH_QUEUE_LIST],
  backlog: [Methods.BACKLOG_LIST],
  sources: [Methods.SOURCES_STATUS],
  config: [Methods.CONFIG_PROJECTS],
  projects: [Methods.CONFIG_PROJECTS],
  native: [Methods.NATIVE_SESSION_LIST, Methods.NATIVE_SESSION_CATALOG],
  'runs/compare': [Methods.RUN_GET],
};

export function resourceViewMatches(route: string, query: ResourceQuery): boolean {
  const section = route.split('/')[0];
  const methods = viewMethods[route] ?? viewMethods[section];
  return methods === undefined || methods.includes(query.method);
}
