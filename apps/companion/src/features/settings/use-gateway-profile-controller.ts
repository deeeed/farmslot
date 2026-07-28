import { useState } from 'react';
import { Alert } from 'react-native';

import {
  type ConnectionHealthState,
  connectionProbeTeachingError,
} from '../../lib/connection-liveness';
import { type GatewayAuthCredentials, testGatewayConnection } from '../../lib/gateway-client';
import { sortGatewayProfilesForAutoConnect } from '../../lib/gateway-profile-selection';
import {
  type GatewayProfile,
  type GatewayProfileAuthMode,
  mobileGatewayProfileUrlError,
  readGatewayProfileSecret,
} from '../../lib/gateway-profiles';
import { useConnectionStore } from '../../store/connection';

export type ProfileConnectionTestState = {
  status: 'testing' | 'healthy' | 'failed';
  message: string;
};

export type ImportedPairingProfile = {
  profile: GatewayProfile;
  secret: string;
};

export type PairingProfileReachability = {
  profile: GatewayProfile;
  reachable: boolean;
  latencyMs?: number;
  compatibilityHint?: string;
  error?: string;
};

interface GatewayProfileControllerOptions {
  profiles: GatewayProfile[];
  displayedProfiles: GatewayProfile[];
  activeProfile: GatewayProfile | undefined;
  urlInput: string;
  setUrlInput: (url: string) => void;
  setAuthMode: (mode: GatewayProfileAuthMode) => void;
  setPairingImportMessage: (message: string | null) => void;
  setRecentImportedProfiles: (profiles: GatewayProfile[]) => void;
}

const PAIRING_CONNECT_TIMEOUT_MS = 3_500;
const PAIRING_PING_TIMEOUT_MS = 3_500;

export function useGatewayProfileController(options: GatewayProfileControllerOptions) {
  const { connect, resetSavedProfiles, saveProfile, setActiveProfile, setGatewayUrl } =
    useConnectionStore();
  const [manualUrlValidationInProgress, setManualUrlValidationInProgress] = useState(false);
  const [profileConnectionTests, setProfileConnectionTests] = useState<
    Record<string, ProfileConnectionTestState>
  >({});
  const [testingAllProfiles, setTestingAllProfiles] = useState(false);
  const connectionTestsInProgress = Object.values(profileConnectionTests).some(
    (result) => result.status === 'testing',
  );

  const testProfileConnection = async (
    profile: GatewayProfile,
  ): Promise<ProfileConnectionTestState> => {
    try {
      const auth = await authCredentialsForProfile(profile);
      if (profile.authMode !== 'none' && Object.keys(auth).length === 0) {
        throw new Error(`No ${profile.authMode} credential is saved for this profile.`);
      }
      const result = await testGatewayConnection(profile.url, auth);
      return connectionTestStateFromResult(result);
    } catch (error) {
      return {
        status: 'failed',
        message: `Failed · ${connectionProbeTeachingError(error)}`,
      };
    }
  };

  const ensureVisibleProfileIsSelectable = async (profile: GatewayProfile) => {
    if (options.profiles.some((candidate) => candidate.id === profile.id)) return;
    await saveProfile(profile);
  };

  const saveCurrentUrl = async () => {
    const url = options.urlInput.trim();
    const urlError = mobileGatewayProfileUrlError(url);
    if (urlError) {
      Alert.alert('Invalid URL', urlError);
      return;
    }
    setManualUrlValidationInProgress(true);
    try {
      const matchingProfile = options.profiles.find((profile) => profile.url === url);
      const auth = matchingProfile ? await authCredentialsForProfile(matchingProfile) : {};
      await testGatewayConnection(url, auth);
      await setGatewayUrl(url);
      connect();
    } catch (error) {
      Alert.alert(
        'URL not activated',
        `${connectionProbeTeachingError(error)}\n\nThe current connection is unchanged.`,
      );
    } finally {
      setManualUrlValidationInProgress(false);
    }
  };

  const testProfile = async (
    profile: GatewayProfile,
    testOptions: { showAlert?: boolean } = {},
  ) => {
    if (connectionTestsInProgress) return;
    setProfileConnectionTests((current) => ({
      ...current,
      [profile.id]: testingState(profile, 'Testing'),
    }));
    const result = await testProfileConnection(profile);
    setProfileConnectionTests((current) => ({ ...current, [profile.id]: result }));
    if (testOptions.showAlert) {
      Alert.alert(
        result.status === 'healthy' ? 'Gateway profile works' : 'Gateway profile failed',
        result.message,
      );
    }
  };

  const activateProfile = async (profile: GatewayProfile) => {
    if (connectionTestsInProgress || profile.id === options.activeProfile?.id) return;
    setProfileConnectionTests((current) => ({
      ...current,
      [profile.id]: testingState(profile, 'Validating'),
    }));
    const result = await testProfileConnection(profile);
    setProfileConnectionTests((current) => ({ ...current, [profile.id]: result }));
    if (result.status !== 'healthy') {
      Alert.alert(
        'Profile not activated',
        `${result.message}\n\nThe current profile is unchanged.`,
      );
      return;
    }
    await ensureVisibleProfileIsSelectable(profile);
    await setActiveProfile(profile.id);
    options.setPairingImportMessage(null);
    options.setUrlInput(profile.url);
    options.setAuthMode(profile.authMode ?? 'none');
    connect();
  };

  const testAllProfiles = async () => {
    if (connectionTestsInProgress || options.displayedProfiles.length === 0) return;
    setTestingAllProfiles(true);
    setProfileConnectionTests(
      Object.fromEntries(
        options.displayedProfiles.map((profile) => [profile.id, testingState(profile, 'Testing')]),
      ),
    );
    const results: Array<readonly [string, ProfileConnectionTestState]> = await Promise.all(
      options.displayedProfiles.map(
        async (profile) => [profile.id, await testProfileConnection(profile)] as const,
      ),
    );
    const resultByProfile = Object.fromEntries(results);
    setProfileConnectionTests(resultByProfile);
    setTestingAllProfiles(false);
    const healthyCount = Object.values(resultByProfile).filter(
      (result) => result.status === 'healthy',
    ).length;
    Alert.alert(
      'Profile checks complete',
      `${healthyCount} healthy · ${options.displayedProfiles.length - healthyCount} failed`,
    );
  };

  const resetProfiles = () => {
    Alert.alert(
      'Reset saved gateway profiles?',
      'This removes every paired or custom profile and its credential. The launcher-provided Configured Gateway is preserved.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset profiles',
          style: 'destructive',
          onPress: () => {
            void resetSavedProfiles()
              .then(() => {
                options.setRecentImportedProfiles([]);
                setProfileConnectionTests({});
                Alert.alert(
                  'Saved profiles reset',
                  'Pair the current Command Center QR to rebuild LAN and Tailscale profiles for this worktree.',
                );
              })
              .catch((error: Error) => {
                Alert.alert('Profile reset failed', error.message);
              });
          },
        },
      ],
    );
  };

  return {
    activateProfile,
    connectionTestsInProgress,
    manualUrlValidationInProgress,
    profileConnectionTests,
    resetProfiles,
    saveCurrentUrl,
    setProfileConnectionTests,
    testAllProfiles,
    testingAllProfiles,
    testProfile,
  };
}

export function mergeVisibleProfiles(
  profiles: GatewayProfile[],
  recentImportedProfiles: GatewayProfile[],
): GatewayProfile[] {
  const byId = new Map<string, GatewayProfile>();
  for (const profile of recentImportedProfiles) byId.set(profile.id, profile);
  for (const profile of profiles) byId.set(profile.id, profile);
  return [...byId.values()];
}

export function startImportedPairingProfileTests(
  importedProfiles: ImportedPairingProfile[],
): Promise<PairingProfileReachability>[] {
  return importedProfiles.map(async (importedProfile) => {
    const auth = authCredentialsForSecret(importedProfile.profile, importedProfile.secret);
    try {
      const result = await testGatewayConnection(importedProfile.profile.url, auth, {
        connectMs: PAIRING_CONNECT_TIMEOUT_MS,
        pingMs: PAIRING_PING_TIMEOUT_MS,
      });
      return {
        profile: importedProfile.profile,
        reachable: true,
        latencyMs: result.latencyMs,
        compatibilityHint: result.compatibilityHint,
      };
    } catch (error) {
      return {
        profile: importedProfile.profile,
        reachable: false,
        error: (error as Error).message,
      };
    }
  });
}

export async function preferredReachablePairingResult(
  importedProfiles: ImportedPairingProfile[],
  checks: Promise<PairingProfileReachability>[],
): Promise<PairingProfileReachability | null> {
  const checksByProfileId = new Map(
    importedProfiles.map(({ profile }, index) => [profile.id, checks[index]]),
  );
  const profilesByPreference = sortGatewayProfilesForAutoConnect(
    importedProfiles.map(({ profile }) => profile),
  );
  for (const profile of profilesByPreference) {
    const check = checksByProfileId.get(profile.id);
    if (!check) continue;
    const result = await check;
    if (result.reachable) return result;
  }
  return null;
}

export function pairingProfileTestState(
  result: PairingProfileReachability,
): ProfileConnectionTestState {
  if (result.reachable) {
    return {
      status: 'healthy',
      message: result.compatibilityHint
        ? `Healthy · authenticated legacy gateway · ${result.latencyMs}ms · ${result.compatibilityHint}`
        : `Healthy · authenticated gateway.ping · ${result.latencyMs}ms`,
    };
  }
  return {
    status: 'failed',
    message: `Failed · ${result.error ?? 'Gateway did not answer.'}`,
  };
}

export function formatProfileKind(kind: GatewayProfile['kind']): string {
  if (kind === 'lan') return 'LAN';
  if (kind === 'tailnet') return 'Tailnet';
  if (kind === 'remote') return 'Remote';
  return 'Custom';
}

function connectionTestStateFromResult(result: {
  latencyMs: number;
  compatibilityHint?: string;
}): ProfileConnectionTestState {
  return {
    status: 'healthy',
    message: result.compatibilityHint
      ? `Healthy · authenticated legacy gateway · ${result.latencyMs}ms · ${result.compatibilityHint}`
      : `Healthy · authenticated gateway.ping · ${result.latencyMs}ms`,
  };
}

function testingState(profile: GatewayProfile, verb: string): ProfileConnectionTestState {
  return {
    status: 'testing',
    message: `${verb} ${profile.name} at ${profile.url}…`,
  };
}

async function authCredentialsForProfile(profile: GatewayProfile): Promise<GatewayAuthCredentials> {
  const secret = await readGatewayProfileSecret(profile);
  return authCredentialsForSecret(profile, secret ?? '');
}

function authCredentialsForSecret(profile: GatewayProfile, secret: string): GatewayAuthCredentials {
  if (!secret) return {};
  if (profile.authMode === 'password') return { password: secret };
  if (profile.authMode === 'token') return { token: secret };
  return {};
}

export function connectionHealthNeedsAttention(
  status: ConnectionHealthState,
  lastSyncError: string | null,
): boolean {
  return status === 'disconnected' || status === 'degraded' || Boolean(lastSyncError);
}
