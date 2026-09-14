import { useCallback, useEffect, useRef, useState } from 'react';

import {
  type NativeProfileInfo,
  type NativeProfileReference,
  type NativeProfileStatusResult,
} from '@farmslot/protocol';

import { nativeProfileLoginReason, nativeProfileReference } from '../../lib/native-profile';
import { useConnectionStore } from '../../store/connection';

import { readNativeProfileSelection } from './native-profile-queries';

interface ProfileSnapshot {
  key: string;
  scope: string;
  profiles: NativeProfileInfo[];
  status?: NativeProfileStatusResult;
  error?: string;
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
  const gatewayProfile = useConnectionStore((state) => state.activeProfileId);
  const scope = JSON.stringify([principalId, gatewayUrl, gatewayProfile, input.node, input.runner]);
  const [choice, setChoice] = useState<{ scope: string; profile?: NativeProfileReference }>();
  const selected = input.fixedProfile ?? (choice?.scope === scope ? choice.profile : undefined);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  useEffect(() => {
    setChoice(undefined);
  }, [scope]);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [snapshot, setSnapshot] = useState<ProfileSnapshot>();
  const revision = useRef(0);
  const connectionGeneration = client?.connectionGeneration;
  const key = JSON.stringify([
    scope,
    connectionGeneration,
    connection,
    selected,
    refreshVersion,
    input.refreshKey,
  ]);
  const keyRef = useRef(key);
  keyRef.current = key;
  const currentSnapshot = snapshot?.key === key ? snapshot : undefined;
  const profiles =
    currentSnapshot?.profiles ??
    (input.enabled && input.supported && connection === 'connected' && snapshot?.scope === scope
      ? snapshot.profiles
      : []);
  const current = useCallback(
    (started: string, generation: number | undefined, version: number) =>
      keyRef.current === started &&
      revision.current === version &&
      client?.connectionState === 'connected' &&
      client.connectionGeneration === generation &&
      (client.authenticatedPrincipal?.id ?? null) === principalId,
    [client, principalId],
  );
  useEffect(() => {
    const version = ++revision.current;
    if (!input.enabled || !input.supported || !client || connection !== 'connected') return;
    const generation = client.connectionGeneration;
    const isCurrent = () => current(key, generation, version);
    void readNativeProfileSelection(
      client,
      input.node,
      input.runner,
      selectedRef.current,
      isCurrent,
    ).then(
      (result) => {
        if (result && isCurrent()) setSnapshot({ key, scope, ...result });
      },
      (cause) => {
        if (isCurrent()) setSnapshot({ key, scope, profiles: [], error: String(cause) });
      },
    );
    return () => {
      revision.current++;
    };
  }, [
    client,
    connection,
    input.enabled,
    input.supported,
    input.node,
    input.runner,
    key,
    scope,
    current,
  ]);
  const reason = selected
    ? !input.supported
      ? 'Profiles are unavailable on this node.'
      : !currentSnapshot
        ? 'Checking profile login.'
        : (currentSnapshot.error ?? nativeProfileLoginReason(currentSnapshot.status))
    : undefined;
  const ready = input.enabled && connection === 'connected' && !reason;
  return {
    viewModel: {
      visible: input.supported || !!selected,
      profiles,
      selected,
      status: currentSnapshot?.status,
      error: currentSnapshot?.error,
      reason,
      loading: input.supported && !currentSnapshot,
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
      },
      validate: async (): Promise<NativeProfileReference | undefined> => {
        if (!ready || !client)
          throw new Error(reason ?? 'Connect before choosing a runner profile.');
        if (!current(key, connectionGeneration, revision.current))
          throw new Error('Gateway identity changed before launch.');
        if (!selected) return undefined;
        const version = ++revision.current;
        const generation = client.connectionGeneration;
        const isCurrent = () => current(key, generation, version);
        const result = await readNativeProfileSelection(
          client,
          input.node,
          input.runner,
          selected,
          isCurrent,
        );
        if (!result || !isCurrent()) throw new Error('Profile selection changed before launch.');
        setSnapshot({ key, scope, ...result });
        const blocked = result.error ?? nativeProfileLoginReason(result.status);
        if (blocked) throw new Error(blocked);
        return selected;
      },
    },
  };
}
