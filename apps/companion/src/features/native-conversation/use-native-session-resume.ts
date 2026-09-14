import { useEffect, useRef, useState } from 'react';

import { Methods, type NativeProfileReference, type NativeSessionInfo } from '@farmslot/protocol';

import { nativeResumeRequest, sessionNativeProfile } from '../../lib/native-profile';
import { useConnectionStore } from '../../store/connection';

import { useNativeProfileSelection } from './use-native-profile-selection';

export function useNativeSessionResume(session: NativeSessionInfo | undefined, enabled: boolean) {
  const client = useConnectionStore((state) => state.client);
  const connection = useConnectionStore((state) => state.status);
  const principalId = useConnectionStore((state) => state.principalId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const alive = useRef(true);
  const mutation = useRef(false);
  let profile: NativeProfileReference | undefined;
  let available = false;
  if (session && enabled) {
    try {
      profile = sessionNativeProfile(session);
      nativeResumeRequest(session, profile);
      available = true;
    } catch {
      /* Unsupported or incomplete saved bindings stay read-only; never infer a replacement. */
    }
  }
  const profiles = useNativeProfileSelection({
    enabled: available,
    node: session?.executionNodeId ?? 'local',
    runner: session?.runner ?? '',
    supported: !!profile,
    fixedProfile: profile,
  });
  const key = JSON.stringify([
    principalId,
    client?.connectionGeneration,
    session?.id,
    session?.generation,
    profile,
    available,
  ]);
  const keyRef = useRef(key);
  keyRef.current = key;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  return {
    viewModel: {
      available,
      ready: available && profiles.viewModel.ready && connection === 'connected' && !busy,
      profiles: profiles.viewModel,
      busy,
      error,
    },
    actions: {
      profiles: {
        ...profiles.actions,
        refresh: () => {
          setError('');
          profiles.actions.refresh();
        },
      },
      resume: async (): Promise<NativeSessionInfo | undefined> => {
        if (!available || !session || !client || !profiles.viewModel.ready || mutation.current)
          return;
        mutation.current = true;
        setBusy(true);
        setError('');
        const generation = client.connectionGeneration;
        try {
          const selected = await profiles.actions.validate();
          if (
            !alive.current ||
            keyRef.current !== key ||
            client.connectionGeneration !== generation
          )
            throw new Error('Conversation changed before resume.');
          const result = await client.request<{ session: NativeSessionInfo }>(
            Methods.NATIVE_SESSION_CREATE,
            nativeResumeRequest(session, selected),
            30_000,
          );
          if (
            alive.current &&
            keyRef.current === key &&
            client.connectionGeneration === generation &&
            (client.authenticatedPrincipal?.id ?? null) === principalId
          )
            return result.session;
        } catch (cause) {
          if (alive.current && keyRef.current === key) setError(String(cause));
        } finally {
          mutation.current = false;
          if (alive.current) setBusy(false);
        }
      },
    },
  };
}
