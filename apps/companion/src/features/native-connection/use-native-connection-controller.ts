import { useEffect, useRef, useState } from 'react';

import { inferGatewayProfileKindFromUrl } from '../../lib/gateway-profile-kind';
import {
  type GatewayProfileAuthMode,
  mobileGatewayProfileUrlError,
} from '../../lib/gateway-profiles';
import { workspaceHome } from '../../lib/workspace-access';
import { useConnectionStore } from '../../store/connection';

export function useNativeConnectionController() {
  const connection = useConnectionStore();
  const [name, setName] = useState('My gateway');
  const [url, setUrl] = useState(connection.gatewayUrl);
  const [authMode, setAuthMode] = useState<GatewayProfileAuthMode>('token');
  const [secret, setSecret] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  const mutation = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const act = async (work: () => Promise<unknown>) => {
    if (mutation.current) return;
    mutation.current = true;
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (cause) {
      if (alive.current) setError(String(cause));
    } finally {
      mutation.current = false;
      if (alive.current) setBusy(false);
    }
  };
  return {
    viewModel: {
      name,
      url,
      authMode,
      secret,
      error,
      busy,
      profiles: connection.profiles,
      activeProfileId: connection.activeProfileId,
      status: connection.status,
      principalId: connection.principalId,
      access: connection.workspaceAccess,
      connectionError: connection.lastProbeError,
      home: workspaceHome(connection.workspaceAccess),
      canOpen: connection.status === 'connected' && connection.workspaceAccess !== 'none',
    },
    actions: {
      setName,
      setUrl,
      setSecret,
      setAuthMode,
      selectProfile: (id: string) => act(() => connection.setActiveProfile(id)),
      retry: () => act(() => connection.retryConnection()),
      save: () =>
        act(async () => {
          const problem = mobileGatewayProfileUrlError(url.trim());
          if (problem) throw new Error(problem);
          if (!name.trim()) throw new Error('Enter a profile name.');
          if (authMode !== 'none' && !secret.trim())
            throw new Error('Enter the gateway credential.');
          const profile = {
            id: `native-profile-${Date.now()}`,
            name: name.trim(),
            url: url.trim(),
            kind: inferGatewayProfileKindFromUrl(url.trim()),
            authMode,
          };
          await connection.saveProfile(profile, secret);
          if (alive.current) setSecret('');
          await connection.setActiveProfile(profile.id);
        }),
    },
  };
}
