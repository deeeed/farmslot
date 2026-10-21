import { parseResourceStoreIdentity, resourceIdentityStorageKey } from '@farmslot/local-store';
import { createBrowserSqliteResourceStore } from '@farmslot/local-store/browser';
import { sourceStatusQuery } from '@farmslot/protocol';
import {
  normalizeResourceStoreScope,
  type ResourceQuery,
  type ResourceQueryState,
  type ResourceStoreScope,
} from '@farmslot/protocol/client-cache';

import { gateway } from '../gateway-client.js';
import { getResourceCache, getResourceWorkspaceAccess } from '../resource-cache.js';

interface DevelopmentImportMeta extends ImportMeta {
  env: { DEV: boolean };
}

function requireDevelopment(): void {
  if (!(import.meta as DevelopmentImportMeta).env.DEV)
    throw new Error('Resource authority inspection is development-only');
}

export function requestResourceReconnect() {
  requireDevelopment();
  gateway.reconnect();
  return { requested: true };
}

/** Read the real app cache and its SQLite row; never seed data or change authentication. */
export async function inspectResourceAuthority(
  scope?: ResourceStoreScope,
  query: ResourceQuery<unknown> = sourceStatusQuery(),
) {
  requireDevelopment();
  const identity = parseResourceStoreIdentity(
    localStorage.getItem(resourceIdentityStorageKey(gateway.gatewayUrl)),
    gateway.gatewayUrl,
  );
  const inspectedScope = scope ?? identity?.metadata.scope;
  let persistent = false;
  let storedObservedAt: number | undefined;
  if (inspectedScope) {
    if (
      normalizeResourceStoreScope(inspectedScope).gatewayUrl !==
      normalizeResourceStoreScope({ gatewayUrl: gateway.gatewayUrl }).gatewayUrl
    )
      throw new Error('Inspect only the selected gateway scope');
    const store = await createBrowserSqliteResourceStore({ scope: inspectedScope });
    try {
      persistent = store.persistent;
      storedObservedAt = (await store.getQuery(query.id))?.observedAt;
    } finally {
      await store.close();
    }
  }
  const state = getResourceCache()?.read(query);
  return {
    connection: gateway.connectionState,
    principalId: gateway.authenticatedPrincipalId,
    renderAccess: getResourceWorkspaceAccess(),
    identity,
    inspectedScope,
    persistent,
    storedObservedAt,
    cacheStatus: state?.status,
    cacheObservedAt: state?.observedAt,
    cacheHasData: state?.data !== undefined,
  };
}

/** Exercise the existing real socket reconnect path, observing the same query as the panel. */
export async function reconnectResourceAuthority() {
  requireDevelopment();
  const cache = getResourceCache();
  const query = sourceStatusQuery();
  const before = cache?.read(query);
  if (!cache || before?.status !== 'ready' || !before.data)
    throw new Error('The production Sources panel must be ready before reconnect');
  const data = JSON.stringify(before.data);
  const panel = () => document.querySelector('source-status-panel');
  const inputs = () =>
    [...(panel()?.shadowRoot?.querySelectorAll<HTMLInputElement>('input[data-testid]') ?? [])].map(
      (input) => ({ id: input.dataset.testid, value: input.value }),
    );
  const beforeInputs = inputs();
  const summary = (state: ResourceQueryState) => ({
    status: state.status,
    observedAt: state.observedAt,
    epoch: state.resourceState?.epoch,
    hasData: state.data !== undefined,
    sameData: JSON.stringify(state.data) === data,
  });
  const observations: ReturnType<typeof summary>[] = [];
  let stop: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const recovered = await new Promise<ReturnType<typeof summary>>((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error('The production cache did not recover on reconnect')),
        120000,
      );
      stop = cache.observe(query, (state) => {
        const value = summary(state);
        observations.push(value);
        if (state.status === 'ready' && state.observedAt! > before.observedAt!) resolve(value);
      });
      gateway.reconnect();
    });
    const stale = observations.find(
      (state) =>
        state.status === 'stale' && state.sameData && state.observedAt === before.observedAt,
    );
    if (!stale || recovered.epoch !== before.resourceState?.epoch)
      throw new Error('Reconnect did not retain stale bytes under the same gateway epoch');
    await panel()?.updateComplete;
    const recoveredInputs = inputs();
    if (JSON.stringify(recoveredInputs) !== JSON.stringify(beforeInputs))
      throw new Error('Reconnect discarded an unsubmitted source selection');
    return {
      result: 'PASS',
      before: summary(before),
      stale,
      recovered,
      beforeInputs,
      recoveredInputs,
      observations,
    };
  } finally {
    stop?.();
    if (timer) clearTimeout(timer);
  }
}
