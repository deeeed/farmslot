import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  Methods,
  type NativeProfileListResult,
  type NativeProfileReference,
  type NativeProfileStatusResult,
  sameNativeProfileReference,
} from '@farmslot/protocol';
import { nativeObservationQuery } from '@farmslot/protocol/client-cache';

import { useResourceQuery } from '../../hooks/useResourceQuery';
import {
  nativeProfileLoginReason,
  nativeProfileReference,
  validateNativeProfileStatus,
} from '../../lib/native-profile';
import {
  getResourceCache,
  getResourceNativeOwnerId,
  getResourceWorkspaceKey,
} from '../../lib/resource-cache';
import { readErrorMessage } from '../../lib/resource-read-status';
import { useConnectionStore } from '../../store/connection';
import { heldConnectionCurrent } from '../../store/held-connection';

import { readNativeProfileSelection } from './native-profile-queries';

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
  let observedError: string | undefined;
  const registered = selected && profiles.find((profile) => profile.id === selected.profileId);
  if (selected) {
    if (
      !registered ||
      !sameNativeProfileReference(selected, nativeProfileReference(input.node, registered))
    )
      observedError =
        'Profile registration changed or is missing. Select a profile explicitly to continue.';
    else if (statusObservation.data) {
      try {
        validateNativeProfileStatus(selected, registered, statusObservation.data);
      } catch (cause) {
        observedError = cause instanceof Error ? cause.message : String(cause);
      }
    }
  }
  const currentSnapshot =
    listObservation.status === 'ready' && (!selected || statusObservation.status === 'ready')
      ? { profiles, status: statusObservation.data, error: observedError }
      : undefined;
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
  const reason = selected
    ? !input.supported
      ? 'Profiles are unavailable on this node.'
      : !currentSnapshot
        ? 'Checking profile login.'
        : (currentSnapshot.error ?? nativeProfileLoginReason(currentSnapshot.status))
    : undefined;
  const ready =
    input.enabled &&
    connection === 'connected' &&
    (input.supported ? !!currentSnapshot : !selected) &&
    !reason;
  return {
    viewModel: {
      visible: input.supported || !!selected,
      profiles,
      selected,
      status: currentSnapshot?.status,
      error:
        refreshError ??
        currentSnapshot?.error ??
        readErrorMessage(listObservation, heldConnectionCurrent()) ??
        readErrorMessage(statusObservation, heldConnectionCurrent()),
      reason,
      loading:
        input.supported &&
        (listObservation.status === 'loading' ||
          (!!selected && statusObservation.status === 'loading')),
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
