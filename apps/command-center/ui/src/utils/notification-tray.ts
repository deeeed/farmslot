import type { GatewayUpdateStatus } from '@farmslot/protocol';
import type { ResourceQuery, ResourceQueryState } from '@farmslot/protocol/client-cache';

import { NotificationTrayModel, type TrayItem } from './notification-tray-model.js';
import { notify } from './notifications.js';

export const notificationTray = new NotificationTrayModel((item) =>
  notify(item.title, {
    body: item.body,
    tag: item.id,
    route: item.route,
    attention: true,
    dedupe: false,
  }),
);
const labels: Record<string, string> = {
  'run.list': 'Runs',
  'run.get': 'Run',
  'run.family': 'Family',
  'task.progress': 'Task progress',
  'run.taskProgress': 'Task progress',
  'decision.list': 'Decisions',
  'fleet.status': 'Fleet',
  'gateway.status': 'Farmslot updates',
  'node.list': 'Nodes',
  'config.projects': 'Projects',
  'sources.status': 'Sources',
  'dispatch.queue.list': 'Dispatch queue',
};
function readRoute(query: ResourceQuery, fallback: string): string {
  const params = query.params;
  if (params && typeof params === 'object') {
    if ('runId' in params && typeof params.runId === 'string')
      return `#run/${encodeURIComponent(params.runId)}`;
    if ('slotId' in params && typeof params.slotId === 'string')
      return `#slot/${encodeURIComponent(params.slotId)}`;
    if ('familyId' in params && typeof params.familyId === 'string')
      return `#family/${encodeURIComponent(params.familyId)}`;
  }
  return fallback;
}
/** One item per canonical query, even when several mounted cards observe it. */
export function publishReadNotice(
  source: object | string,
  owner: string | undefined,
  query: ResourceQuery,
  state: ResourceQueryState,
  route: string,
  retry?: () => void,
): void {
  const label = labels[query.method] ?? 'This view';
  const error = state.error;
  const stale =
    state.data !== undefined &&
    (state.status === 'stale' ||
      (state.sourceObservation && state.sourceObservation.status !== 'ready'));
  const target = readRoute(query, route);
  const item: TrayItem | undefined = error
    ? {
        id: `read:${query.id}`,
        title: `Could not refresh ${label.toLowerCase()}`,
        body: error.message,
        route: target,
        needsYou: false,
        current: false,
        retry,
        observedAt: state.sourceObservation?.observedAt ?? state.observedAt,
      }
    : state.status === 'unsupported'
      ? {
          id: `read:${query.id}`,
          title: `${label} updates unavailable`,
          body: 'Update the gateway to restore live reads.',
          route: target,
          needsYou: false,
          current: false,
        }
      : stale
        ? {
            id: `read:${query.id}`,
            title: `Saved ${label.toLowerCase()}`,
            body: 'Actions wait for a current read.',
            route: target,
            observedAt: state.sourceObservation?.observedAt ?? state.observedAt,
            needsYou: false,
            current: false,
          }
        : undefined;
  notificationTray.set(source, owner, item ? [item] : []);
}
export function publishUpdateNotice(
  owner: string | undefined,
  status?: GatewayUpdateStatus | null,
): void {
  notificationTray.set(
    'update',
    owner,
    status?.updateAvailable ||
      status?.operation?.phase === 'running' ||
      status?.operation?.phase === 'error'
      ? [
          {
            id: 'gateway-update',
            title:
              status.operation?.phase === 'running'
                ? 'Updating Farmslot'
                : 'Farmslot update available',
            body: status.remoteSha?.slice(0, 8) ?? '',
            route: '#doctor',
            needsYou: false,
            current: true,
            view: 'update',
          },
        ]
      : [],
  );
}
