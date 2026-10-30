import { type BarcodeScanningResult, useCameraPermissions } from 'expo-camera';
import { type Dispatch, type SetStateAction, useState } from 'react';
import { Alert } from 'react-native';

import {
  exchangeGatewayPairingQr,
  type GatewayPairingQrPayload,
  pairingLinkPrompt,
  parseGatewayPairingQr,
  profileFromPairingResult,
} from '../../lib/gateway-pairing';
import { claimPairing, forgetLastPairing, releasePairing } from '../../lib/gateway-pairing-claim';
import { keepPairing } from '../../lib/gateway-pairing-save';
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
  onPaired?: () => void;
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
    forgetLastPairing();
    setPairingInProgress(false);
    setPairingScannerOpen(true);
  };

  /** Pairs from a pairing QR payload, scanned or from a link, that the caller claimed with `claimPairing`. */
  const pair = async (data: string) => {
    setPairingInProgress(true);
    try {
      const payload = parseGatewayPairingQr(data);
      const pairedProfileResults = await exchangeGatewayPairingQr(payload);
      const importedProfiles = pairedProfileResults.map((pairedProfileResult) => ({
        profile: profileFromPairingResult(pairedProfileResult),
        secret: pairedProfileResult.secret,
        personSession: pairedProfileResult.personSession,
        verification: pairedProfileResult.verification,
      }));
      options.setRecentImportedProfiles(
        importedProfiles.map((importedProfile) => importedProfile.profile),
      );
      // Nothing is saved until an address answers. Scanning a new code for a gateway then replaces
      // the sign-in saved for it.
      const preferredReachable = await keepPairing(importedProfiles, {
        probe: async () => {
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
          void Promise.all(reachabilityChecks).then((reachability) => {
            options.setProfileConnectionTests(
              Object.fromEntries(
                reachability.map((candidate) => [
                  candidate.profile.id,
                  pairingProfileTestState(candidate),
                ]),
              ),
            );
          });
          return preferredReachablePairingResult(importedProfiles, reachabilityChecks);
        },
        save: (importedProfile, onReplace) =>
          saveProfile(
            importedProfile.profile,
            importedProfile.secret,
            importedProfile.personSession,
            importedProfile.verification,
            { replacePersonLogin: true, onReplace },
          ),
        activate: async ({ profile }) => {
          try {
            // A fresh login adapter replaces the running client's, also when this profile was active.
            await setActiveProfile(profile.id);
          } catch (error) {
            // The saved logins stay; the running client must not keep a login they replaced.
            const { activeProfileId, signedOut } = useConnectionStore.getState();
            if (
              !signedOut &&
              importedProfiles.some((entry) => entry.profile.id === activeProfileId)
            )
              await setActiveProfile(activeProfileId).catch(() => undefined);
            throw new Error(
              `Paired, but Companion could not switch to ${profile.name}: ${(error as Error).message}`,
            );
          }
        },
      });
      const preferredProfile = preferredReachable.profile;
      options.setUrlInput(preferredProfile.url);
      options.setAuthMode(preferredProfile.authMode ?? 'none');
      options.setProfileConnectionTests((current) => ({
        ...current,
        [preferredProfile.id]: pairingProfileTestState(preferredReachable),
      }));
      const importMessage = `${importedProfiles.length} profile${importedProfiles.length === 1 ? '' : 's'} imported. Connected to ${preferredProfile.name}.`;
      options.setPairingImportMessage(importMessage);
      options.setAdvancedGatewaySetupOpen(false);
      connect();
      options.onPaired?.();
      setPairingScannerOpen(false);
      Alert.alert('Companion paired', importMessage);
    } catch (error) {
      // The code may be spent: rescanning the same QR would only report it invalid.
      setPairingScannerOpen(false);
      setPairingInProgress(false);
      Alert.alert('Pairing failed', (error as Error).message);
    } finally {
      releasePairing();
    }
  };

  const handlePairingBarcodeScanned = (result: BarcodeScanningResult) => {
    if (claimPairing(result.data) === 'claimed') void pair(result.data);
  };

  /** Any app or web page can open a pair link, so it pairs only after the user confirms where. */
  const pairFromLink = (data: string) => {
    const claim = claimPairing(data);
    // The same link again (its route remounted) was handled already; its code is single-use.
    if (claim === 'busy')
      Alert.alert('Pairing already running', 'Wait for it to finish, then open the link again.');
    if (claim !== 'claimed') return;
    let payload: GatewayPairingQrPayload;
    try {
      payload = parseGatewayPairingQr(data);
    } catch (error) {
      releasePairing();
      Alert.alert('Pairing link not valid', (error as Error).message);
      return;
    }
    Alert.alert(
      'Pair with this gateway?',
      pairingLinkPrompt(payload, useConnectionStore.getState().profiles),
      [
        { text: 'Cancel', style: 'cancel', onPress: releasePairing },
        { text: 'Pair', onPress: () => void pair(data) },
      ],
      { cancelable: false },
    );
  };

  return {
    closePairingScanner: () => setPairingScannerOpen(false),
    handlePairingBarcodeScanned,
    openPairingScanner,
    pairFromLink,
    pairingInProgress,
    pairingScannerOpen,
  };
}
