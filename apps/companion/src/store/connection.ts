import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';
import { create } from 'zustand';

import {
  Events,
  type GatewayAuthConnectResult,
  type MonitorViolationPayload,
  type PersonDeviceSession,
  type PersonSessionAuth,
  type Run,
  signOutAccount,
} from '@farmslot/protocol';

import {
  type ConnectionHealthState,
  type ConnectionLiveness,
  INITIAL_CONNECTION_LIVENESS,
  livenessAfterFailure,
  livenessAfterSuccess,
  livenessForTransportState,
} from '../lib/connection-liveness';
import { ConnectionLivenessController } from '../lib/connection-liveness-controller';
import { type ConnectionProbeResult, runConnectionProbe } from '../lib/connection-probe';
import { isCurrentConnectionProbe } from '../lib/connection-probe-identity';
import {
  ConnectionProbeAttemptTracker,
  connectionProbeInvalidation,
} from '../lib/connection-store-probe';
import {
  type ConnectionState,
  type GatewayAuthCredentials,
  GatewayClient,
  type GatewayHttpAuthHeaders,
  gatewayHttpAuthHeaders,
  testGatewayConnection,
} from '../lib/gateway-client';
import {
  gatewayProfileForConnection,
  selectInitialGatewayConnection,
} from '../lib/gateway-profile-selection';
import {
  parseGatewayProfilesFromStorage,
  sanitizeGatewayProfilesForStorage,
} from '../lib/gateway-profile-storage';
import { commandCenterUrlForProfile } from '../lib/gateway-profile-web-url';
import {
  DEFAULT_GATEWAY_PROFILES,
  DEFAULT_GATEWAY_URL,
  forgetGatewayProfileSecret,
  type GatewayProfile,
  type GatewayProfileAuthMode,
  type GatewayProfileLoginOptions,
  isLegacyPresetGatewayUrl,
  mergeGatewayProfiles,
  prepareGatewayProfileLogin,
  profileIdForUrl,
  profileSecretStorageKey,
  readGatewayProfilePersonSession,
} from '../lib/gateway-profiles';
import { notifyRunCompleted, notifyViolation } from '../lib/notifications';
import type { WorkspaceAccess } from '../lib/workspace-access';

import { resetFarmState } from './reset-farm-state';

const SIGNED_OUT_KEY = '@farmslot:signedOut';
const GATEWAY_URL_KEY = '@farmslot:gatewayUrl';
const GATEWAY_PROFILES_KEY = '@farmslot:gatewayProfiles';
const ACTIVE_GATEWAY_PROFILE_KEY = '@farmslot:activeGatewayProfileId';
const LIVENESS_PROBE_TIMEOUT_MS = 8_000;

let livenessController: ConnectionLivenessController | null = null;
let appStateSubscription: ReturnType<typeof AppState.addEventListener> | null = null;
const probeAttemptTracker = new ConnectionProbeAttemptTracker();

export type { ConnectionProbeResult } from '../lib/connection-probe';

interface ConnectionStore {
  status: ConnectionState;
  signedOut: boolean;
  personSession: PersonDeviceSession | null;
  signOut: () => Promise<void>;
  principalId: string | null;
  workspaceAccess: WorkspaceAccess;
  authorityEpoch: number;
  healthStatus: ConnectionHealthState;
  gatewayUrl: string;
  profiles: GatewayProfile[];
  activeProfileId: string;
  activeProfileAuthMode: GatewayProfileAuthMode;
  activeProfileHttpAuthHeaders: GatewayHttpAuthHeaders;
  client: GatewayClient | null;
  lastConnectedAt: number | null;
  lastSuccessfulProbeAt: number | null;
  lastProbeLatencyMs: number | null;
  lastProbeError: string | null;
  gatewayCompatibilityHint: string | null;
  consecutiveProbeFailures: number;
  probeInProgress: boolean;
  lastSyncError: string | null;
  initializing: boolean;
  init: () => Promise<void>;
  setGatewayUrl: (url: string) => Promise<void>;
  setActiveProfile: (profileId: string) => Promise<void>;
  saveProfile: (
    profile: GatewayProfile,
    secret?: string,
    personSession?: PersonSessionAuth,
    verification?: GatewayAuthConnectResult,
    options?: GatewayProfileLoginOptions,
  ) => Promise<void>;
  setProfileAuth: (
    profileId: string,
    authMode: GatewayProfileAuthMode,
    secret: string,
  ) => Promise<void>;
  deleteProfile: (profileId: string) => Promise<void>;
  resetSavedProfiles: () => Promise<void>;
  connect: () => void;
  retryConnection: () => Promise<ConnectionProbeResult>;
  disconnect: () => void;
  probeConnection: () => Promise<ConnectionProbeResult>;
  testConnection: () => Promise<ConnectionProbeResult>;
}

export const useConnectionStore = create<ConnectionStore>((set, get) => ({
  status: 'disconnected',
  signedOut: false,
  personSession: null,
  principalId: null,
  workspaceAccess: 'none',
  authorityEpoch: 0,
  healthStatus: INITIAL_CONNECTION_LIVENESS.status,
  gatewayUrl: DEFAULT_GATEWAY_URL,
  profiles: DEFAULT_GATEWAY_PROFILES,
  activeProfileId: DEFAULT_GATEWAY_PROFILES[0]?.id ?? '',
  activeProfileAuthMode: DEFAULT_GATEWAY_PROFILES[0]?.authMode ?? 'none',
  activeProfileHttpAuthHeaders: {},
  client: null,
  lastConnectedAt: null,
  lastSuccessfulProbeAt: null,
  lastProbeLatencyMs: null,
  lastProbeError: null,
  gatewayCompatibilityHint: null,
  consecutiveProbeFailures: 0,
  probeInProgress: false,
  lastSyncError: null,
  initializing: false,

  init: async () => {
    if (get().client || get().initializing) return; // Prevent concurrent init and HMR duplication
    set({ initializing: true });
    try {
      const signedOut = (await AsyncStorage.getItem(SIGNED_OUT_KEY)) === 'true';
      const saved = await AsyncStorage.getItem(GATEWAY_URL_KEY);
      const savedProfiles = await readSavedProfiles();
      const profiles = mergeGatewayProfiles(savedProfiles);
      const savedActiveProfileId = await AsyncStorage.getItem(ACTIVE_GATEWAY_PROFILE_KEY);
      const savedUrl = saved && !isLegacyPresetGatewayUrl(saved) ? saved : null;
      const { profile: activeProfile, url } = selectInitialGatewayConnection(
        profiles,
        savedUrl,
        savedActiveProfileId,
        DEFAULT_GATEWAY_URL,
      );
      const auth =
        !signedOut && activeProfile ? await authCredentialsForProfile(activeProfile) : {};
      const client = new GatewayClient(url, auth);
      const session =
        !signedOut && activeProfile ? await readGatewayProfilePersonSession(activeProfile) : null;

      // Completion alerts do not own the run collection.
      client.subscribe(Events.RUN_COMPLETED, (payload) => {
        if (get().client !== client || client.workspaceAccess !== 'farm') return;
        const data = payload as { run?: Run };
        if (data.run)
          void notifyRunCompleted(data.run).catch((error: unknown) => {
            set({
              lastSyncError: `Run notification failed: ${error instanceof Error ? error.message : String(error)}`,
            });
          });
      });

      client.subscribe(Events.MONITOR_VIOLATION, (payload) => {
        notifyViolation(payload as MonitorViolationPayload);
      });

      client.onConnectionChange((status) => {
        if (get().client !== client) return;
        const principalId = client.authenticatedPrincipal?.id ?? null;
        const workspaceAccess = client.workspaceAccess;
        const authorityChanged =
          get().principalId !== principalId || get().workspaceAccess !== workspaceAccess;
        if (authorityChanged) {
          if (get().workspaceAccess !== 'none' || workspaceAccess !== 'farm') resetFarmState();
          probeAttemptTracker.invalidate();
          livenessController?.reset();
        }
        const liveness = livenessForTransportState(
          authorityChanged ? INITIAL_CONNECTION_LIVENESS : livenessFromStore(get()),
          status,
        );
        set({
          status,
          principalId,
          workspaceAccess,
          activeProfileHttpAuthHeaders: client.httpAuthHeaders,
          personSession: client.personDeviceSession,
          authorityEpoch: get().authorityEpoch + (authorityChanged ? 1 : 0),
          ...(authorityChanged
            ? { lastSyncError: null, gatewayCompatibilityHint: null, probeInProgress: false }
            : {}),
          ...livenessPatch(liveness),
          lastConnectedAt: status === 'connected' ? Date.now() : get().lastConnectedAt,
        });
        if (status === 'connected') {
          void livenessController?.probeFresh();
        }
      });

      set({
        signedOut,
        personSession: session?.session ?? null,
        gatewayUrl: url,
        profiles,
        activeProfileId: activeProfile?.id ?? '',
        activeProfileAuthMode: activeProfile?.authMode ?? 'none',
        activeProfileHttpAuthHeaders: gatewayHttpAuthHeaders(auth),
        client,
      });

      livenessController?.stop();
      appStateSubscription?.remove();
      livenessController = new ConnectionLivenessController({
        probe: () => get().probeConnection(),
        onForeground: () => get().connect(),
        onProbeError: (error) => {
          const liveness = livenessAfterFailure(
            livenessFromStore(get()),
            get().client?.connectionState ?? 'disconnected',
            error,
          );
          set(livenessPatch(liveness));
        },
      });
      livenessController.setAppActive(AppState.currentState === 'active');
      appStateSubscription = AppState.addEventListener('change', (nextState) => {
        livenessController?.setAppActive(nextState === 'active');
      });
      if (!signedOut) client.connect();
    } finally {
      set({ initializing: false });
    }
  },

  setGatewayUrl: async (url: string) => {
    if (url) await AsyncStorage.setItem(GATEWAY_URL_KEY, url);
    else await AsyncStorage.removeItem(GATEWAY_URL_KEY);
    const { profiles } = get();
    const matchingProfileId = profileIdForUrl(profiles, url);
    if (matchingProfileId)
      await AsyncStorage.setItem(ACTIVE_GATEWAY_PROFILE_KEY, matchingProfileId);
    else await AsyncStorage.removeItem(ACTIVE_GATEWAY_PROFILE_KEY);
    const profile = matchingProfileId
      ? profiles.find((candidate) => candidate.id === matchingProfileId)
      : undefined;
    const auth = profile ? await authCredentialsForProfile(profile) : {};
    const nextAuthMode = matchingProfileId ? (profile?.authMode ?? 'none') : 'none';
    const nextAuthHeaders = matchingProfileId ? gatewayHttpAuthHeaders(auth) : {};
    const state = get();
    const transition = connectionIdentityTransition(state, {
      url,
      profileId: matchingProfileId ?? '',
      authMode: nextAuthMode,
      authHeaders: nextAuthHeaders,
    });
    set({
      gatewayUrl: url,
      activeProfileId: matchingProfileId ?? '',
      activeProfileAuthMode: nextAuthMode,
      activeProfileHttpAuthHeaders: nextAuthHeaders,
      ...transition.patch,
    });
    if (transition.changed) {
      resetFarmState();
      probeAttemptTracker.invalidate();
      livenessController?.reset();
    }

    await state.client?.setConnection(
      url,
      auth,
      transition.changed,
      state.activeProfileId !== (matchingProfileId ?? '') ? 'profile-change' : 'principal-change',
    );
    if (transition.changed) void livenessController?.probeFresh();
  },

  setActiveProfile: async (profileId: string) => {
    const profile = get().profiles.find((candidate) => candidate.id === profileId);
    if (!profile) return;
    // A login that cannot be read must not become the saved selection a restart opens.
    const auth = await authCredentialsForProfile(profile);
    await AsyncStorage.multiSet([
      [ACTIVE_GATEWAY_PROFILE_KEY, profile.id],
      [GATEWAY_URL_KEY, profile.url],
    ]);
    await AsyncStorage.removeItem(SIGNED_OUT_KEY);
    set({ signedOut: false });
    const authMode = profile.authMode ?? 'none';
    const authHeaders = gatewayHttpAuthHeaders(auth);
    const state = get();
    const transition = connectionIdentityTransition(state, {
      url: profile.url,
      profileId: profile.id,
      authMode,
      authHeaders,
    });
    set({
      activeProfileId: profile.id,
      activeProfileAuthMode: authMode,
      activeProfileHttpAuthHeaders: authHeaders,
      gatewayUrl: profile.url,
      ...transition.patch,
    });
    if (transition.changed) {
      resetFarmState();
      probeAttemptTracker.invalidate();
      livenessController?.reset();
    }

    await state.client?.setConnection(
      profile.url,
      auth,
      transition.changed,
      state.activeProfileId !== profile.id ? 'profile-change' : 'principal-change',
    );
    if (transition.changed) void livenessController?.probeFresh();
  },

  saveProfile: async (
    profile: GatewayProfile,
    secret?: string,
    personSession?: PersonSessionAuth,
    verification?: GatewayAuthConnectResult,
    options: GatewayProfileLoginOptions = {},
  ) => {
    const normalizedProfile: GatewayProfile = {
      ...profile,
      commandCenterUrl: commandCenterUrlForProfile(
        profile,
        get().profiles.find((p) => p.id === profile.id),
      ),
      authMode: profile.authMode ?? 'none',
      secretStorageKey:
        profile.authMode && profile.authMode !== 'none'
          ? (profile.secretStorageKey ?? profileSecretStorageKey(profile.id))
          : undefined,
    };
    const login = await prepareGatewayProfileLogin(
      normalizedProfile,
      secret,
      personSession,
      options,
    );
    if (personSession) {
      const current = await readGatewayProfilePersonSession(normalizedProfile);
      if (current && current.session.id !== personSession.session.id && !options.replacePersonLogin)
        throw new Error('Sign out this device before replacing its person login.');
      await login.credentials.sessionStorage.save(personSession);
      const result =
        verification ?? (await testGatewayConnection(normalizedProfile.url, login.credentials));
      await login.commitVerifiedCredential(result);
    } else if (secret?.trim() && normalizedProfile.authMode !== 'none') {
      const result =
        verification ?? (await testGatewayConnection(normalizedProfile.url, login.credentials));
      await login.commitVerifiedCredential(result);
    }
    const profiles = mergeGatewayProfiles([
      ...get().profiles.filter((candidate) => candidate.id !== normalizedProfile.id),
      normalizedProfile,
    ]);
    await AsyncStorage.setItem(
      GATEWAY_PROFILES_KEY,
      JSON.stringify(sanitizeGatewayProfilesForStorage(profiles)),
    );
    const persistedProfiles = mergeGatewayProfiles(await readSavedProfiles());
    if (!persistedProfiles.some((candidate) => candidate.id === normalizedProfile.id)) {
      throw new Error(
        `Gateway profile ${normalizedProfile.name} was not persisted. Check the profile URL and retry pairing.`,
      );
    }
    set({ profiles });
  },

  setProfileAuth: async (profileId: string, authMode: GatewayProfileAuthMode, secret: string) => {
    const profile = get().profiles.find((candidate) => candidate.id === profileId);
    if (!profile) return;
    const updated: GatewayProfile = {
      ...profile,
      authMode,
      secretStorageKey:
        authMode === 'none'
          ? undefined
          : (profile.secretStorageKey ?? profileSecretStorageKey(profile.id)),
    };
    await get().saveProfile(updated, secret);
    await AsyncStorage.removeItem(SIGNED_OUT_KEY);
    set({ signedOut: false });
    if (profileId === get().activeProfileId) {
      const auth = await authCredentialsForProfile(updated);
      const authHeaders = gatewayHttpAuthHeaders(auth);
      const state = get();
      const transition = connectionIdentityTransition(state, {
        url: updated.url,
        profileId: updated.id,
        authMode,
        authHeaders,
      });
      set({
        activeProfileAuthMode: authMode,
        activeProfileHttpAuthHeaders: authHeaders,
        ...transition.patch,
      });
      if (transition.changed) {
        resetFarmState();
        probeAttemptTracker.invalidate();
        livenessController?.reset();
      }

      await state.client?.setConnection(updated.url, auth, transition.changed);
      if (transition.changed) void livenessController?.probeFresh();
    }
  },

  deleteProfile: async (profileId: string) => {
    const profile = get().profiles.find((candidate) => candidate.id === profileId);
    if (!profile || profile.readonly) return;
    if (await readGatewayProfilePersonSession(profile))
      throw new Error('Sign out this device before deleting its profile.');
    const profiles = mergeGatewayProfiles(
      get().profiles.filter((candidate) => candidate.id !== profileId),
    );
    await AsyncStorage.setItem(
      GATEWAY_PROFILES_KEY,
      JSON.stringify(sanitizeGatewayProfilesForStorage(profiles)),
    );
    await forgetGatewayProfileSecret(profile);
    if (profileId !== get().activeProfileId) {
      set({ profiles });
      return;
    }
    const state = get();
    const nextProfile = profiles[0] ?? null;
    if (!nextProfile) {
      await AsyncStorage.removeItem(ACTIVE_GATEWAY_PROFILE_KEY);
      await AsyncStorage.removeItem(GATEWAY_URL_KEY);
      set({
        profiles,
        activeProfileId: '',
        activeProfileAuthMode: 'none',
        activeProfileHttpAuthHeaders: {},
        gatewayUrl: '',
        principalId: null,
        workspaceAccess: 'none',
        authorityEpoch: get().authorityEpoch + 1,
        lastSyncError: null,
        ...livenessPatch(INITIAL_CONNECTION_LIVENESS),
        gatewayCompatibilityHint: null,
      });
      probeAttemptTracker.invalidate();
      livenessController?.reset();
      resetFarmState();

      set({ personSession: null });
      await state.client?.setConnection('', {}, false, 'profile-change');
      return;
    }
    await AsyncStorage.setItem(ACTIVE_GATEWAY_PROFILE_KEY, nextProfile.id);
    await AsyncStorage.setItem(GATEWAY_URL_KEY, nextProfile.url);
    const auth = await authCredentialsForProfile(nextProfile);
    const authMode = nextProfile.authMode ?? 'none';
    const authHeaders = gatewayHttpAuthHeaders(auth);
    const transition = connectionIdentityTransition(state, {
      url: nextProfile.url,
      profileId: nextProfile.id,
      authMode,
      authHeaders,
    });
    set({
      profiles,
      activeProfileId: nextProfile.id,
      activeProfileAuthMode: authMode,
      activeProfileHttpAuthHeaders: authHeaders,
      gatewayUrl: nextProfile.url,
      ...transition.patch,
    });
    if (transition.changed) {
      resetFarmState();
      probeAttemptTracker.invalidate();
      livenessController?.reset();
    }

    await state.client?.setConnection(nextProfile.url, auth, transition.changed, 'profile-change');
    if (transition.changed) void livenessController?.probeFresh();
  },

  resetSavedProfiles: async () => {
    const profiles = mergeGatewayProfiles([]);
    const preservedSecretKeys = new Set(
      profiles.flatMap((profile) =>
        profile.authMode !== 'none' && profile.secretStorageKey ? [profile.secretStorageKey] : [],
      ),
    );
    const rawSavedProfiles = await readSavedProfiles();
    const personLogins = await Promise.all(get().profiles.map(readGatewayProfilePersonSession));
    if (personLogins.some(Boolean))
      throw new Error('Sign out person profiles before resetting saved profiles.');
    const removableProfiles = [...get().profiles, ...rawSavedProfiles].filter(
      (profile) =>
        !preservedSecretKeys.has(profile.secretStorageKey ?? profileSecretStorageKey(profile.id)),
    );
    await Promise.all(removableProfiles.map((profile) => forgetGatewayProfileSecret(profile)));
    await AsyncStorage.removeItem(GATEWAY_PROFILES_KEY);

    const nextProfile = profiles[0] ?? null;
    const state = get();
    if (!nextProfile) {
      await AsyncStorage.removeItem(ACTIVE_GATEWAY_PROFILE_KEY);
      await AsyncStorage.removeItem(GATEWAY_URL_KEY);
      set({
        profiles,
        activeProfileId: '',
        activeProfileAuthMode: 'none',
        activeProfileHttpAuthHeaders: {},
        gatewayUrl: '',
        principalId: null,
        workspaceAccess: 'none',
        authorityEpoch: get().authorityEpoch + 1,
        lastSyncError: null,
        ...livenessPatch(INITIAL_CONNECTION_LIVENESS),
        gatewayCompatibilityHint: null,
      });
      probeAttemptTracker.invalidate();
      livenessController?.reset();
      resetFarmState();

      set({ personSession: null });
      await state.client?.setConnection('', {}, false, 'profile-change');
      return;
    }

    await AsyncStorage.setItem(ACTIVE_GATEWAY_PROFILE_KEY, nextProfile.id);
    await AsyncStorage.setItem(GATEWAY_URL_KEY, nextProfile.url);
    const auth = await authCredentialsForProfile(nextProfile);
    const authMode = nextProfile.authMode ?? 'none';
    const authHeaders = gatewayHttpAuthHeaders(auth);
    const transition = connectionIdentityTransition(state, {
      url: nextProfile.url,
      profileId: nextProfile.id,
      authMode,
      authHeaders,
    });
    set({
      profiles,
      activeProfileId: nextProfile.id,
      activeProfileAuthMode: authMode,
      activeProfileHttpAuthHeaders: authHeaders,
      gatewayUrl: nextProfile.url,
      ...transition.patch,
    });
    if (transition.changed) {
      resetFarmState();
      probeAttemptTracker.invalidate();
      livenessController?.reset();
    }

    await state.client?.setConnection(nextProfile.url, auth, transition.changed, 'profile-change');
    if (transition.changed) void livenessController?.probeFresh();
  },

  signOut: async () => {
    await signOutAccount({
      forgetLogin: async () => {
        const profile = get().profiles.find((p) => p.id === get().activeProfileId);
        await get().client?.clearAccountSession();
        if (profile) await forgetGatewayProfileSecret(profile);
        await AsyncStorage.setItem(SIGNED_OUT_KEY, 'true');
      },
      closeSession: () => {
        livenessController?.stop();
        appStateSubscription?.remove();
        appStateSubscription = null;
        get().client?.disconnect();
        probeAttemptTracker.invalidate();
        resetFarmState();
        set((state) => ({
          signedOut: true,
          personSession: null,
          client: null,
          principalId: null,
          workspaceAccess: 'none',
          activeProfileHttpAuthHeaders: {},
          authorityEpoch: state.authorityEpoch + 1,
          status: 'disconnected',
          ...livenessPatch(INITIAL_CONNECTION_LIVENESS),
        }));
      },
    });
  },

  connect: () => {
    if (get().signedOut) return;
    if (get().client) get().client!.connect();
    else void get().init();
  },

  retryConnection: async () => {
    if (get().signedOut) return { ok: false, error: 'Sign in or pair to connect.' };
    get().client?.reconnect();
    return get().testConnection();
  },

  disconnect: () => {
    livenessController?.stop();
    get().client?.disconnect();
  },

  probeConnection: async () => {
    const client = get().client;
    if (!client) {
      const liveness = livenessAfterFailure(
        livenessFromStore(get()),
        'disconnected',
        new Error('Gateway client is not connected'),
      );
      set({ ...livenessPatch(liveness), probeInProgress: false });
      return { ok: false, error: liveness.lastError ?? 'Gateway is not connected.' };
    }

    const attempt = probeAttemptTracker.begin();
    const profileUrl = get().gatewayUrl;
    const profileId = get().activeProfileId;
    const connectionGeneration = client.connectionGeneration;
    const startedIdentity = {
      client,
      gatewayUrl: profileUrl,
      profileId,
      connectionGeneration,
    };
    const currentIdentity = () => ({
      client: get().client ?? {},
      gatewayUrl: get().gatewayUrl,
      profileId: get().activeProfileId,
      connectionGeneration: client.connectionGeneration,
    });
    const probeIsCurrent = () =>
      probeAttemptTracker.isCurrent(attempt) &&
      isCurrentConnectionProbe(startedIdentity, currentIdentity());
    const failForInvalidation = (): ConnectionProbeResult | null => {
      const invalidation = connectionProbeInvalidation(
        startedIdentity,
        currentIdentity(),
        probeAttemptTracker.isCurrent(attempt),
      );
      if (!invalidation) return null;
      if (invalidation.kind === 'transport') {
        const liveness = livenessAfterFailure(
          livenessFromStore(get()),
          client.connectionState,
          new Error(invalidation.error),
        );
        set(livenessPatch(liveness));
        return {
          ok: false,
          error: liveness.lastError ?? invalidation.error,
        };
      }
      return { ok: false, error: invalidation.error };
    };
    set({ probeInProgress: true });
    try {
      const activeProfile = gatewayProfileForConnection(get().profiles, profileUrl, profileId);
      const auth = activeProfile ? await authCredentialsForProfile(activeProfile) : {};
      const outcome = await runConnectionProbe({
        client,
        gatewayUrl: profileUrl,
        auth,
        appActive: AppState.currentState === 'active',
        timeoutMs: LIVENESS_PROBE_TIMEOUT_MS,
        isCurrent: probeIsCurrent,
      });
      const invalidationFailure = failForInvalidation();
      if (invalidationFailure) return invalidationFailure;
      if (!outcome.result.ok) {
        const liveness = livenessAfterFailure(
          livenessFromStore(get()),
          client.connectionState,
          new Error(outcome.result.error),
        );
        set(livenessPatch(liveness));
        return {
          ok: false,
          error: liveness.lastError ?? outcome.result.error,
        };
      }
      const liveness = livenessAfterSuccess(
        livenessFromStore(get()),
        Date.now(),
        outcome.result.latencyMs,
      );
      set({
        ...livenessPatch(liveness),
        healthStatus: outcome.activeTransportProven ? liveness.status : 'socket-up-not-proven',
        gatewayCompatibilityHint: outcome.compatibilityHint,
      });
      return outcome.result;
    } catch (error) {
      const invalidationFailure = failForInvalidation();
      if (invalidationFailure) return invalidationFailure;
      const liveness = livenessAfterFailure(
        livenessFromStore(get()),
        client.connectionState,
        error,
      );
      set(livenessPatch(liveness));
      return { ok: false, error: liveness.lastError ?? 'Gateway did not answer.' };
    } finally {
      if (probeAttemptTracker.isCurrent(attempt)) {
        set({ probeInProgress: false });
      }
    }
  },

  testConnection: async () => {
    if (livenessController) {
      const result = await livenessController.probeFresh();
      if (result.ok && 'latencyMs' in result && result.latencyMs !== undefined) {
        return { ok: true, latencyMs: result.latencyMs };
      }
      return {
        ok: false,
        error: (!result.ok && result.error) || 'Gateway did not answer.',
      };
    }
    return get().probeConnection();
  },
}));

async function authCredentialsForProfile(profile: GatewayProfile): Promise<GatewayAuthCredentials> {
  return (await prepareGatewayProfileLogin(profile)).credentials;
}

async function readSavedProfiles(): Promise<GatewayProfile[]> {
  const raw = await AsyncStorage.getItem(GATEWAY_PROFILES_KEY);
  return parseGatewayProfilesFromStorage(raw);
}

function livenessFromStore(
  state: Pick<
    ConnectionStore,
    | 'healthStatus'
    | 'lastSuccessfulProbeAt'
    | 'lastProbeLatencyMs'
    | 'lastProbeError'
    | 'consecutiveProbeFailures'
  >,
): ConnectionLiveness {
  return {
    status: state.healthStatus,
    lastSuccessAt: state.lastSuccessfulProbeAt,
    lastLatencyMs: state.lastProbeLatencyMs,
    lastError: state.lastProbeError,
    consecutiveFailures: state.consecutiveProbeFailures,
  };
}

function livenessPatch(liveness: ConnectionLiveness) {
  return {
    healthStatus: liveness.status,
    lastSuccessfulProbeAt: liveness.lastSuccessAt,
    lastProbeLatencyMs: liveness.lastLatencyMs,
    lastProbeError: liveness.lastError,
    consecutiveProbeFailures: liveness.consecutiveFailures,
  };
}

function connectionIdentityTransition(
  current: Pick<
    ConnectionStore,
    | 'gatewayUrl'
    | 'activeProfileId'
    | 'activeProfileAuthMode'
    | 'activeProfileHttpAuthHeaders'
    | 'authorityEpoch'
  >,
  next: {
    url: string;
    profileId: string;
    authMode: GatewayProfileAuthMode;
    authHeaders: GatewayHttpAuthHeaders;
  },
) {
  const changed =
    current.gatewayUrl !== next.url ||
    current.activeProfileId !== next.profileId ||
    current.activeProfileAuthMode !== next.authMode ||
    current.activeProfileHttpAuthHeaders.Authorization !== next.authHeaders.Authorization;
  return {
    changed,
    patch: changed
      ? {
          principalId: null,
          workspaceAccess: 'none' as const,
          authorityEpoch: current.authorityEpoch + 1,
          lastSyncError: null,
          ...livenessPatch(INITIAL_CONNECTION_LIVENESS),
          gatewayCompatibilityHint: null,
          probeInProgress: false,
        }
      : {},
  };
}
