import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

import { parseResourceStoreIdentity, resourceIdentityStorageKey } from '@farmslot/local-store';
import { createNativeSqliteResourceStore } from '@farmslot/local-store/native';
import {
  sourceObservationAge,
  type SourceStatusController,
  sourceStatusQuery,
} from '@farmslot/protocol';
import {
  normalizeResourceStoreScope,
  type ResourceQueryState,
  type ResourceStoreScope,
} from '@farmslot/protocol/client-cache';

import { getResourceCache, getResourceWorkspaceAccess } from '../lib/resource-cache';
import { useConnectionStore } from '../store/connection';

import type { FarmslotRecipeUiObserver } from './RecipeBridgeProvider';

const controllers = new Set<SourceStatusController>();
const startedAt = Date.now();

/** Inspect actual persisted rows, including a previous scope after sign-out or profile removal. */
async function inspectResourceAuthority(scope?: ResourceStoreScope) {
  const connection = useConnectionStore.getState();
  const identity = connection.gatewayUrl
    ? parseResourceStoreIdentity(
        await AsyncStorage.getItem(
          resourceIdentityStorageKey(
            connection.gatewayUrl,
            connection.activeProfileId || undefined,
          ),
        ),
        connection.gatewayUrl,
        connection.activeProfileId || undefined,
      )
    : undefined;
  const inspectedScope = scope ?? identity?.metadata.scope;
  let persistent = false;
  let storedObservedAt: number | undefined;
  if (inspectedScope) {
    if (
      connection.gatewayUrl &&
      normalizeResourceStoreScope(inspectedScope).gatewayUrl !==
        normalizeResourceStoreScope({ gatewayUrl: connection.gatewayUrl }).gatewayUrl
    )
      throw new Error('Inspect only the selected gateway scope');
    const store = await createNativeSqliteResourceStore({ scope: inspectedScope });
    try {
      persistent = store.persistent;
      storedObservedAt = (await store.getQuery(sourceStatusQuery().id))?.observedAt;
    } finally {
      await store.close();
    }
  }
  const state = getResourceCache()?.read(sourceStatusQuery());
  return {
    result: 'PASS',
    platform: Platform.OS,
    connection: connection.client?.connectionState,
    signedOut: connection.signedOut,
    profileId: connection.activeProfileId,
    principalId: connection.client?.authenticatedPrincipal?.id,
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

/** Observe mounted production controllers, without issuing reads or changing their state. */
export function observeSourcesController(controller: SourceStatusController): () => void {
  controllers.add(controller);
  return () => {
    controllers.delete(controller);
  };
}

async function reconnectCurrentSources() {
  const cache = getResourceCache();
  const client = useConnectionStore.getState().client;
  const query = sourceStatusQuery();
  const before = cache?.read(query);
  if (!cache || !client || before?.status !== 'ready' || !before.data)
    throw new Error('The production Sources panel must be ready before reconnect');
  const data = JSON.stringify(before.data);
  const selections = () =>
    [...controllers].map((controller) => controller.getSnapshot().selections);
  const beforeSelections = structuredClone(selections());
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
      client.reconnect();
    });
    const stale = observations.find(
      (state) =>
        state.status === 'stale' && state.sameData && state.observedAt === before.observedAt,
    );
    if (!stale || recovered.epoch !== before.resourceState?.epoch)
      throw new Error('Reconnect did not retain stale bytes under the same gateway epoch');
    const recoveredSelections = selections();
    if (JSON.stringify(recoveredSelections) !== JSON.stringify(beforeSelections))
      throw new Error('Reconnect discarded an unsubmitted source selection');
    return {
      result: 'PASS',
      platform: Platform.OS,
      before: summary(before),
      stale,
      recovered,
      beforeSelections,
      recoveredSelections,
      observations,
    };
  } finally {
    stop?.();
    if (timer) clearTimeout(timer);
  }
}

/** Read the production cache used by the actual Sources section, without changing UI state. */
export const observeSourcesCacheProof: FarmslotRecipeUiObserver = async (refs) => {
  if (!__DEV__ || refs.length !== 1) return undefined;
  const authorityPrefix = 'sources-cache:authority';
  if (refs[0] === authorityPrefix || refs[0].startsWith(`${authorityPrefix}:`)) {
    try {
      const scope = refs[0].slice(authorityPrefix.length + 1);
      return {
        observations: {
          sourcesAuthority: await inspectResourceAuthority(scope ? JSON.parse(scope) : undefined),
        },
      };
    } catch (error) {
      // Report inspection failures to the waiting recipe rather than losing its relay reply.
      return {
        observations: {
          sourcesAuthority: {
            result: 'FAIL',
            platform: Platform.OS,
            error: error instanceof Error ? error.message : String(error),
          },
        },
      };
    }
  }
  if (refs[0] === 'sources-cache:reconnect') {
    try {
      return { observations: { sourcesReconnect: await reconnectCurrentSources() } };
    } catch (error) {
      // Return a failed proof to the waiting command; a thrown observer error loses its relay reply.
      return {
        observations: {
          sourcesReconnect: {
            result: 'FAIL',
            platform: Platform.OS,
            error: error instanceof Error ? error.message : String(error),
            current: getResourceCache()?.read(sourceStatusQuery()).status,
          },
        },
      };
    }
  }
  if (refs[0] !== 'sources-cache:snapshot') return undefined;
  const state = getResourceCache()?.read(sourceStatusQuery());
  const client = useConnectionStore.getState().client;
  return {
    observations: {
      sourcesCache: {
        platform: Platform.OS,
        startedAt,
        freshness: state?.status ?? 'loading',
        observedAt: state?.observedAt,
        online: client?.connectionState === 'connected',
        error: state?.error,
        epoch: state?.resourceState?.epoch,
        pinRevision: state?.data?.pinRevision,
        selections: state?.data?.effectiveSelections,
        nodes: state?.data?.nodes,
        resolutions: state?.data?.resolutions,
        errors: state?.data?.errors,
        panels: [...controllers].map((controller) => {
          const snapshot = controller.getSnapshot();
          return {
            line: snapshot.view?.line,
            freshness: snapshot.freshness,
            interactive: snapshot.interactive,
            canEdit: snapshot.canEdit,
            canRetry: snapshot.canRetry,
            age: sourceObservationAge(snapshot.observedAt),
            rows: snapshot.view?.rows.map((row) => ({
              sourceId: row.declaration.id,
              materializations: row.materializations,
              details: row.details,
            })),
          };
        }),
      },
    },
  };
};
