import { viewRouteFromLink } from './view-links.mjs';

const ID = '[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}';
const entityLink = new RegExp(`^farmslot://(run|gate|slot)/(${ID})(?:\\?runId=(${ID}))?$`, 'i');

/** Only navigation targets are accepted, never credentials, gateways or actions. */
export function routeFromDeepLink(value) {
  const fullView = viewRouteFromLink(value);
  if (fullView) return fullView;
  if (typeof value !== 'string' || value.length > 512) return null;
  const view = /^farmslot:\/\/(fleet|runs|decisions)\/?$/i.exec(value);
  if (view) return `#${view[1].toLowerCase()}`;
  const match = entityLink.exec(value);
  if (!match) return null;
  const [, kind, id, runId] = match;
  if (kind.toLowerCase() === 'slot') return `#slot/${id}${runId ? `?runId=${runId}` : ''}`;
  if (runId) return null;
  // The run drawer presents the run's current gate as well as its progress.
  return `#runs?run=${id}`;
}
