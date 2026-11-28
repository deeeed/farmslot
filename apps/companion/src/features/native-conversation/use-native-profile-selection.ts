import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  Methods,
  type NativeProfileListResult,
  type NativeProfileReference,
  type NativeProfileStatusResult,
} from '@farmslot/protocol';
import { nativeObservationQuery } from '@farmslot/protocol/client-cache';

import { useResourceQuery } from '../../hooks/useResourceQuery';
import {
  nativeProfileLoginReason,
  nativeProfileReference,
  nativeProfileSelectionReady,
} from '../../lib/native-profile';
import {
  getResourceCache,
  getResourceNativeOwnerId,
  getResourceWorkspaceKey,
} from '../../lib/resource-cache';
import { readErrorMessage } from '../../lib/resource-read-status';
import { useConnectionStore } from '../../store/connection';
import { heldConnectionCurrent } from '../../store/held-connection';

import {
  type NativeProfileBlocker,
  nativeProfileObservationView,
  readNativeProfileSelection,
} from './native-profile-queries';

interface ProfileBlockerSnapshot {
  scope: string;
  issue: NativeProfileBlocker;
}

export function useNativeProfileSelection(input: {
  enabled: boolean;
  node: string;
  runner: string;
  supported: boolean;
  fixedProfile?: NativeProfileReference;
  refreshKey?: string;
}) {
  const client = useConnectionStore((state) => state.client);
  const connection = useConnectionStore((state) => state.status);
  const principalId = useConnectionStore((state) => state.principalId);
  const gatewayUrl = useConnectionStore((state) => state.gatewayUrl);
  const authorityEpoch = useConnectionStore((state) => state.authorityEpoch);
  const gatewayProfile = useConnectionStore((state) => state.activeProfileId);
  const scope = JSON.stringify([principalId, gatewayUrl, gatewayProfile, input.node, input.runner]);
  const [choice, setChoice] = useState<{ scope: string; profile?: NativeProfileReference }>();
  const selected = input.fixedProfile ?? (choice?.scope === scope ? choice.profile : undefined);
  useEffect(() => {
    setChoice(undefined);
  }, [scope]);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [refreshError, setRefreshError] = useState<string>();
  const revision = useRef(0);
  const connectionGeneration = client?.connectionGeneration;
  const key = JSON.stringify([
    scope,
    authorityEpoch,
    connectionGeneration,
    connection,
    selected,
    refreshVersion,
    input.refreshKey,
  ]);
  const keyRef = useRef(key);
  keyRef.current = key;
  const nativeOwner = getResourceNativeOwnerId();
  const listQuery = useMemo(
    () =>
      input.enabled && input.supported && nativeOwner
        ? nativeObservationQuery<NativeProfileListResult>(
            Methods.NATIVE_PROFILE_LIST,
            { executionNodeId: input.node },
            nativeOwner,
          )
        : undefined,
    [input.enabled, input.supported, input.node, nativeOwner],
  );
  const statusQuery = useMemo(
    () =>
      input.enabled && selected && nativeOwner
        ? nativeObservationQuery<NativeProfileStatusResult>(
            Methods.NATIVE_PROFILE_STATUS,
            { executionNodeId: input.node, profileId: selected.profileId },
            nativeOwner,
          )
        : undefined,
    [input.enabled, input.node, selected, nativeOwner],
  );
  const listObservation = useResourceQuery(listQuery);
  const statusObservation = useResourceQuery(statusQuery);
  const profiles = (listObservation.data?.profiles ?? []).filter(
    (profile) => profile.runner === input.runner,
  );
  const blockerScope =
    statusQuery && input.supported && connection === 'connected'
      ? JSON.stringify([
          scope,
          authorityEpoch,
          connectionGeneration,
          getResourceWorkspaceKey(),
          statusQuery.id,
          selected?.accountContextId,
        ])
      : undefined;
  const [blocker, setBlocker] = useState<ProfileBlockerSnapshot>();
  const previousStatusBlocker = blocker?.scope === blockerScope ? blocker?.issue : undefined;
  const observed = nativeProfileObservationView({
    node: input.node,
    supported: input.supported,
    selected,
    profiles,
    list: listObservation,
    status: statusObservation,
    previousStatusBlocker,
  });
  // Cold retries clear the cache error until the read settles. Keep only the same profile's blocker.
  const nextBlocker = blockerScope ? observed.statusBlocker : undefined;
  if (
    blocker?.issue.detail !== nextBlocker?.detail ||
    (blocker && blocker.scope !== blockerScope)
  ) {
    setBlocker(
      nextBlocker && blockerScope ? { scope: blockerScope, issue: nextBlocker } : undefined,
    );
  }
  const current = useCallback(
    (started: string, generation: number | undefined, version: number) =>
      keyRef.current === started &&
      revision.current === version &&
      client?.connectionState === 'connected' &&
      client.connectionGeneration === generation &&
      (client.authenticatedPrincipal?.id ?? null) === principalId &&
      useConnectionStore.getState().authorityEpoch === authorityEpoch,
    [client, principalId, authorityEpoch],
  );
  const { reason } = observed;
  const ready = nativeProfileSelectionReady({
    enabled: input.enabled,
    connected: connection === 'connected',
    selected: !!selected,
    current: observed.current,
    reason,
  });
  return {
    viewModel: {
      visible: input.supported || !!selected,
      profiles,
      selected,
      status: observed.status,
      readIssue: observed.readIssue,
      error:
        refreshError ??
        observed.error ??
        readErrorMessage(listObservation, heldConnectionCurrent()) ??
        readErrorMessage(statusObservation, heldConnectionCurrent()),
      reason,
      loading: observed.loading,
      ready,
    },
    actions: {
      choose: (profileId: string) => {
        if (input.fixedProfile) return;
        const profile = profiles.find((item) => item.id === profileId);
        if (profileId && !profile) return;
        revision.current++;
        keyRef.current = '';
        setChoice({
          scope,
          profile: profile ? nativeProfileReference(input.node, profile) : undefined,
        });
        setRefreshVersion((value) => value + 1);
      },
      refresh: () => {
        revision.current++;
        keyRef.current = '';
        setRefreshVersion((value) => value + 1);
        void Promise.all(
          [listQuery, statusQuery]
            .filter((query) => !!query)
            .filter((query) => getResourceCache()?.read<unknown>(query).error)
            .map((query) => getResourceCache()?.retry<unknown>(query)),
        ).catch((cause) => {
          setRefreshError(String(cause));
        });
      },
      validate: async (): Promise<NativeProfileReference | undefined> => {
        if (!ready || !client)
          throw new Error(reason ?? 'Connect before choosing a runner profile.');
        if (!current(key, connectionGeneration, revision.current))
          throw new Error('Gateway identity changed before launch.');
        if (!selected) return undefined;
        const cache = getResourceCache();
        const workspaceKey = getResourceWorkspaceKey();
        if (!cache || !nativeOwner)
          throw new Error('The current runner profile store is unavailable.');
        const version = ++revision.current;
        const generation = client.connectionGeneration;
        const isCurrent = () =>
          current(key, generation, version) &&
          cache === getResourceCache() &&
          workspaceKey === getResourceWorkspaceKey() &&
          nativeOwner === getResourceNativeOwnerId();
        const result = await readNativeProfileSelection(
          { cache, nativeOwnerId: nativeOwner },
          input.node,
          input.runner,
          selected,
          isCurrent,
        );
        if (!result || !isCurrent()) throw new Error('Profile selection changed before launch.');
        const blocked = result.error ?? nativeProfileLoginReason(result.status);
        if (blocked) throw new Error(blocked);
        return selected;
      },
    },
  };
}
