import { viewStateParams, viewTextField } from '@farmslot/protocol';

import { inheritSidebarViewState } from './sidebar-view-state.js';

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

export function buildHash(
  route: string,
  params: URLSearchParams = new URLSearchParams(),
  currentHash = typeof location === 'undefined' ? '' : location.hash,
): string {
  const query = inheritSidebarViewState(params, hashParams(currentHash)).toString();
  return `#${route}${query ? `?${query}` : ''}`;
}

export function navigationHash(destination: string, currentHash = location.hash): string {
  const { route, params } = parseHashRoute(destination);
  return buildHash(route, params, currentHash);
}

/** Apply route changes at their writer, including asynchronous action completions. */
export function navigateHash(
  destination: string,
  mode: 'assign' | 'push' | 'replace' = 'assign',
): void {
  const next = navigationHash(destination);
  if (next === location.hash) return;
  if (mode === 'assign') location.hash = next;
  else history[mode === 'push' ? 'pushState' : 'replaceState'](null, '', next);
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
    ? viewTextField(context.param, context.defaultValue).read(params)
    : context.defaultValue;
}

export function viewChoiceHash(
  context: ViewChoiceContext,
  value: string,
  hash = location.hash,
): string {
  const { route, params } = parseHashRoute(hash);
  if (route !== context.route) return hash;
  return buildHash(
    route,
    viewStateParams(params, (state) =>
      state.set(viewTextField(context.param, context.defaultValue), value),
    ),
  );
}
