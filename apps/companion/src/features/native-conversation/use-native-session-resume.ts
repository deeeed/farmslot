import { useEffect, useRef, useState } from 'react';

import {
  Methods,
  type NativeProfileReference,
  nativeProfileSessionParams,
  type NativeSessionCreateParams,
  type NativeSessionInfo,
} from '@farmslot/protocol';
import { nativeImplementAvailable, nativeImplementSession } from '@farmslot/protocol/client-cache';

import { nativeResumeRequest, sessionNativeProfile } from '../../lib/native-profile';
import { useConnectionStore } from '../../store/connection';

import { useNativeProfileSelection } from './use-native-profile-selection';

/**
 * Starts a session from this one, on its node, runner and validated account profile: Resume
 * continues a stopped conversation, and Implement carries out a plan-mode session's proposal in
 * a new default-mode session.
 */
export function useNativeSessionResume(
  session: NativeSessionInfo | undefined,
  enabled: boolean,
  eligible: boolean,
  assertCurrent: () => void,
) {
  const client = useConnectionStore((state) => state.client);
  const connection = useConnectionStore((state) => state.status);
  const principalId = useConnectionStore((state) => state.principalId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const alive = useRef(true);
  const mutation = useRef(false);
  let profile: NativeProfileReference | undefined;
  let available = false;
  let implementable = false;
  if (session && eligible) {
    try {
      profile = sessionNativeProfile(session);
      implementable = nativeImplementAvailable(session);
      nativeResumeRequest(session, profile);
      available = true;
    } catch {
      /* Unsupported or incomplete saved bindings stay read-only; never infer a replacement. */
    }
  }
  const profiles = useNativeProfileSelection({
    enabled: (available || implementable) && enabled,
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
    implementable,
    enabled,
  ]);
  const keyRef = useRef(key);
  keyRef.current = key;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const ready = enabled && profiles.viewModel.ready && connection === 'connected' && !busy;
  const start = async (
    allowed: boolean,
    request: (
      from: NativeSessionInfo,
      selected: NativeProfileReference | undefined,
    ) => NativeSessionCreateParams,
  ): Promise<NativeSessionInfo | undefined> => {
    if (
      !enabled ||
      !allowed ||
      !session ||
      !client ||
      !profiles.viewModel.ready ||
      mutation.current
    )
      return;
    mutation.current = true;
    setBusy(true);
    setError('');
    const generation = client.connectionGeneration;
    try {
      assertCurrent();
      const selected = await profiles.actions.validate();
      if (!alive.current || keyRef.current !== key || client.connectionGeneration !== generation)
        throw new Error('Conversation changed before the session started.');
      assertCurrent();
      const result = await client.request<{ session: NativeSessionInfo }>(
        Methods.NATIVE_SESSION_CREATE,
        request(session, selected),
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
  };
  return {
    viewModel: {
      available,
      implementable,
      ready: available && ready,
      implementReady: implementable && ready,
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
      resume: () => start(available, nativeResumeRequest),
      implement: () =>
        start(implementable, (from, selected) => ({
          ...nativeImplementSession(from),
          ...nativeProfileSessionParams(selected),
        })),
    },
  };
}
