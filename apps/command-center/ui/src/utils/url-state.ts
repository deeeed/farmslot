export interface HashRouteState {
  route: string;
  params: URLSearchParams;
}

export function hashWithoutPrefix(hash: string = location.hash): string {
  return hash.replace(/^#/, '');
}

export function hashRoute(hash: string = location.hash): string {
  return hashWithoutPrefix(hash).split('?')[0] ?? '';
}

export function hashSearch(hash: string = location.hash): string {
  const queryIndex = hash.indexOf('?');
  return queryIndex >= 0 ? hash.slice(queryIndex + 1) : '';
}

export function hashParams(hash: string = location.hash): URLSearchParams {
  return new URLSearchParams(hashSearch(hash));
}

export function getHashParam(name: string, hash: string = location.hash): string | null {
  return hashParams(hash).get(name);
}

export function parseHashRoute(hash: string = location.hash): HashRouteState {
  return {
    route: hashRoute(hash),
    params: hashParams(hash),
  };
}

export function buildHash(route: string, params: URLSearchParams = new URLSearchParams()): string {
  const query = params.toString();
  return `#${route}${query ? `?${query}` : ''}`;
}

/** Context owns the route, parameter and omitted default for a persistent view choice. */
export interface ViewChoiceContext {
  route: string;
  param: string;
  defaultValue: string;
}

export function readViewChoice(context: ViewChoiceContext, hash = location.hash): string {
  const { route, params } = parseHashRoute(hash);
  return route === context.route
    ? (params.get(context.param) ?? context.defaultValue)
    : context.defaultValue;
}

export function viewChoiceHash(
  context: ViewChoiceContext,
  value: string,
  hash = location.hash,
): string {
  const { route, params } = parseHashRoute(hash);
  if (route !== context.route) return hash;
  if (value === context.defaultValue) params.delete(context.param);
  else params.set(context.param, value);
  return buildHash(route, params);
}
