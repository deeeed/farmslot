import type { ResourceQuery } from '@farmslot/protocol/client-cache';

/** Primary data for a screen; secondary panels retain their own read/error indicators. */
const viewMethods: Record<string, readonly string[]> = {
  runs: ['run.list'],
  run: ['run.get'],
  family: ['family.observability.get'],
  fleet: ['fleet.status'],
  slot: ['fleet.status'],
  decisions: ['decision.list'],
  dispatch: ['dispatch.queue.list'],
  backlog: ['backlog.list'],
  sources: ['sources.status'],
  config: ['config.projects'],
  projects: ['config.projects'],
  native: ['node.list'],
};

export function resourceViewMatches(route: string, query: ResourceQuery): boolean {
  const section = route.split('/')[0];
  const methods = viewMethods[section];
  return methods === undefined || methods.includes(query.method);
}
