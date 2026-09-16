import { useEffect, useRef, useState } from 'react';

import { inferGatewayProfileKindFromUrl } from '../../lib/gateway-profile-kind';
import {
  type GatewayProfile,
  type GatewayProfileAuthMode,
  mobileGatewayProfileUrlError,
} from '../../lib/gateway-profiles';
import { workspaceHome } from '../../lib/workspace-access';
import { useConnectionStore } from '../../store/connection';
import { useGatewayPairingController } from '../settings/use-gateway-pairing-controller';
import type { ProfileConnectionTestState } from '../settings/use-gateway-profile-controller';

export function useNativeConnectionController() {
  const connection = useConnectionStore();
  const [name, setName] = useState('My gateway');
  const [url, setUrl] = useState(connection.gatewayUrl);
  const [authMode, setAuthMode] = useState<GatewayProfileAuthMode>('token');
  const [secret, setSecret] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [paired, setPaired] = useState(false);
  const [pairingImportMessage, setPairingImportMessage] = useState<string | null>(null);
  const [, setProfileConnectionTests] = useState<Record<string, ProfileConnectionTestState>>({});
  const [, setRecentImportedProfiles] = useState<GatewayProfile[]>([]);
  const alive = useRef(true);
  const mutation = useRef(false);
  const autoOpenedScanner = useRef(false);
  const openScannerRef = useRef<() => Promise<void>>(async () => undefined);
  const pairing = useGatewayPairingController({
    setAuthMode,
    setPairingImportMessage,
    setProfileConnectionTests,
    setRecentImportedProfiles,
    setUrlInput: setUrl,
    setAdvancedGatewaySetupOpen: setManualOpen,
    onPaired: () => setPaired(true),
  });
  openScannerRef.current = pairing.openPairingScanner;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (autoOpenedScanner.current || connection.profiles.length > 0) return;
    autoOpenedScanner.current = true;
    void openScannerRef.current();
  }, [connection.profiles.length]);
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
  const canOpen = connection.status === 'connected' && connection.workspaceAccess !== 'none';
  return {
    viewModel: {
      name,
      url,
      authMode,
      secret,
      error,
      busy,
      manualOpen,
      pairingImportMessage,
      pairingScannerOpen: pairing.pairingScannerOpen,
      pairingInProgress: pairing.pairingInProgress,
      profiles: connection.profiles,
      activeProfileId: connection.activeProfileId,
      status: connection.status,
      principalId: connection.principalId,
      access: connection.workspaceAccess,
      connectionError: connection.lastProbeError,
      home: workspaceHome(connection.workspaceAccess),
      canOpen,
      leaveToHome: paired && canOpen,
    },
    actions: {
      setName,
      setUrl,
      setSecret,
      setAuthMode,
      toggleManual: () => setManualOpen((open) => !open),
      openPairingScanner: pairing.openPairingScanner,
      closePairingScanner: pairing.closePairingScanner,
      handlePairingBarcodeScanned: pairing.handlePairingBarcodeScanned,
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
