import { viewRouteFromLink } from './view-links.mjs';

const ID = '[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}';
const entityLink = new RegExp(`^farmslot://(run|gate|slot)/(${ID})(?:\\?runId=(${ID}))?$`, 'i');
const entityRoute = new RegExp(`^(run|slot)/(${ID})$`);
const validId = new RegExp(`^${ID}$`);
const views = new Set(['fleet', 'runs', 'decisions']);

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

/** Copy only the current entity; unrelated query values must never enter a link. */
export function deepLinkFromRoute(value) {
  if (typeof value !== 'string' || !value.startsWith('#') || value.length > 4096) return null;
  const [route, query = ''] = value.slice(1).split('?');
  const params = new URLSearchParams(query);
  if (route === 'runs' && params.has('run')) {
    const id = params.get('run');
    return validId.test(id) ? `farmslot://run/${id}` : null;
  }
  if (views.has(route)) return `farmslot://${route}`;
  const match = entityRoute.exec(route);
  if (!match) return null;
  const [, kind, id] = match;
  const runId = kind === 'slot' ? params.get('runId') : null;
  if (runId !== null && !validId.test(runId)) return null;
  return `farmslot://${kind}/${id}${runId ? `?runId=${runId}` : ''}`;
}
