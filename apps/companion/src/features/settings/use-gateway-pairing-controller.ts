import { type BarcodeScanningResult, useCameraPermissions } from 'expo-camera';
import { type Dispatch, type SetStateAction, useState } from 'react';
import { Alert } from 'react-native';

import {
  exchangeGatewayPairingQr,
  parseGatewayPairingQr,
  profileFromPairingResult,
} from '../../lib/gateway-pairing';
import type { GatewayProfile, GatewayProfileAuthMode } from '../../lib/gateway-profiles';
import { useConnectionStore } from '../../store/connection';

import {
  pairingProfileTestState,
  preferredReachablePairingResult,
  type ProfileConnectionTestState,
  startImportedPairingProfileTests,
} from './use-gateway-profile-controller';

interface GatewayPairingControllerOptions {
  setAuthMode: (mode: GatewayProfileAuthMode) => void;
  setPairingImportMessage: (message: string | null) => void;
  setProfileConnectionTests: Dispatch<SetStateAction<Record<string, ProfileConnectionTestState>>>;
  setRecentImportedProfiles: Dispatch<SetStateAction<GatewayProfile[]>>;
  setUrlInput: (url: string) => void;
  setAdvancedGatewaySetupOpen: (open: boolean) => void;
}

export function useGatewayPairingController(options: GatewayPairingControllerOptions) {
  const { connect, saveProfile, setActiveProfile } = useConnectionStore();
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [pairingScannerOpen, setPairingScannerOpen] = useState(false);
  const [pairingInProgress, setPairingInProgress] = useState(false);

  const openPairingScanner = async () => {
    if (!cameraPermission?.granted) {
      const result = await requestCameraPermission();
      if (!result.granted) {
        Alert.alert('Camera permission required', 'Allow camera access to scan a pairing QR.');
        return;
      }
    }
    setPairingInProgress(false);
    setPairingScannerOpen(true);
  };

  const handlePairingBarcodeScanned = async (result: BarcodeScanningResult) => {
    if (pairingInProgress) return;
    setPairingInProgress(true);
    try {
      const payload = parseGatewayPairingQr(result.data);
      const pairedProfileResults = await exchangeGatewayPairingQr(payload);
      const importedProfiles = pairedProfileResults.map((pairedProfileResult) => ({
        profile: profileFromPairingResult(pairedProfileResult),
        secret: pairedProfileResult.secret,
      }));
      options.setRecentImportedProfiles(
        importedProfiles.map((importedProfile) => importedProfile.profile),
      );
      for (const importedProfile of importedProfiles) {
        await saveProfile(importedProfile.profile, importedProfile.secret);
      }
      options.setProfileConnectionTests(
        Object.fromEntries(
          importedProfiles.map(({ profile }) => [
            profile.id,
            {
              status: 'testing',
              message: `Testing ${profile.url}…`,
            },
          ]),
        ),
      );
      const reachabilityChecks = startImportedPairingProfileTests(importedProfiles);
      const allReachability = Promise.all(reachabilityChecks);
      const preferredReachable = await preferredReachablePairingResult(
        importedProfiles,
        reachabilityChecks,
      );
      const preferredProfile = preferredReachable?.profile;
      if (preferredProfile && preferredReachable) {
        await setActiveProfile(preferredProfile.id);
        options.setUrlInput(preferredProfile.url);
        options.setAuthMode(preferredProfile.authMode ?? 'none');
        options.setProfileConnectionTests((current) => ({
          ...current,
          [preferredProfile.id]: pairingProfileTestState(preferredReachable),
        }));
      }
      const importMessage = preferredProfile
        ? `${importedProfiles.length} profile${importedProfiles.length === 1 ? '' : 's'} imported. Connected to ${preferredProfile.name}.`
        : `${importedProfiles.length} profile${importedProfiles.length === 1 ? '' : 's'} imported, but none passed validation. The current profile is unchanged.`;
      options.setPairingImportMessage(importMessage);
      void allReachability
        .then((reachability) => {
          options.setProfileConnectionTests(
            Object.fromEntries(
              reachability.map((candidate) => [
                candidate.profile.id,
                pairingProfileTestState(candidate),
              ]),
            ),
          );
        })
        .catch(() => {
          // Individual reachability checks resolve to failed rows; this is only
          // a defensive guard against an unexpected aggregate rejection.
        });
      options.setAdvancedGatewaySetupOpen(false);
      if (preferredProfile) connect();
      setPairingScannerOpen(false);
      Alert.alert('Companion paired', importMessage);
    } catch (error) {
      setPairingInProgress(false);
      Alert.alert('Pairing failed', (error as Error).message);
    }
  };

  return {
    closePairingScanner: () => setPairingScannerOpen(false),
    handlePairingBarcodeScanned,
    openPairingScanner,
    pairingInProgress,
    pairingScannerOpen,
  };
}
