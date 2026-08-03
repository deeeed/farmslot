import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';
import { create } from 'zustand';

import {
  type DecisionListResult,
  Events,
  type FleetStatusResult,
  Methods,
  type MonitorViolationPayload,
  type PendingDecision,
  type PRUpdatedPayload,
  type Run,
  type SlotStatus,
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
} from '../lib/gateway-client';
import {
  gatewayProfileForConnection,
  selectInitialGatewayConnection,
} from '../lib/gateway-profile-selection';
import {
  parseGatewayProfilesFromStorage,
  sanitizeGatewayProfilesForStorage,
} from '../lib/gateway-profile-storage';
import {
  DEFAULT_GATEWAY_PROFILES,
  DEFAULT_GATEWAY_URL,
  type GatewayProfile,
  type GatewayProfileAuthMode,
  isLegacyPresetGatewayUrl,
  mergeGatewayProfiles,
  profileIdForUrl,
  profileSecretStorageKey,
  readGatewayProfileSecret,
  seedPresetGatewayProfileSecrets,
  writeGatewayProfileSecret,
} from '../lib/gateway-profiles';
import { fetchActiveRuns, fetchRecentRunHistory } from '../lib/gateway-run-sync';
import { notifyDecision, notifyRunCompleted, notifyViolation } from '../lib/notifications';

import { useDecisionStore } from './decisions';
import { useFleetStore } from './fleet';
import { usePRStore } from './prs';
import { useRunStore } from './runs';

const GATEWAY_URL_KEY = '@farmslot:gatewayUrl';
const GATEWAY_PROFILES_KEY = '@farmslot:gatewayProfiles';
const ACTIVE_GATEWAY_PROFILE_KEY = '@farmslot:activeGatewayProfileId';
const LIVENESS_PROBE_TIMEOUT_MS = 8_000;
const DECISION_LIST_TIMEOUT_MS = 30_000;

let livenessController: ConnectionLivenessController | null = null;
let appStateSubscription: ReturnType<typeof AppState.addEventListener> | null = null;
const probeAttemptTracker = new ConnectionProbeAttemptTracker();

export type { ConnectionProbeResult } from '../lib/connection-probe';

type DecisionNewEventPayload = {
  decision?: PendingDecision;
};

interface ConnectionStore {
  status: ConnectionState;
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
  saveProfile: (profile: GatewayProfile, secret?: string) => Promise<void>;
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
  retryDecisionSync: () => Promise<void>;
  syncRunHistory: () => Promise<void>;
}

export const useConnectionStore = create<ConnectionStore>((set, get) => ({
  status: 'disconnected',
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
      const saved = await AsyncStorage.getItem(GATEWAY_URL_KEY);
      const savedProfiles = await readSavedProfiles();
      const profiles = mergeGatewayProfiles(savedProfiles);
      await seedPresetGatewayProfileSecrets(profiles);
      const savedActiveProfileId = await AsyncStorage.getItem(ACTIVE_GATEWAY_PROFILE_KEY);
      const savedUrl = saved && !isLegacyPresetGatewayUrl(saved) ? saved : null;
      const { profile: activeProfile, url } = selectInitialGatewayConnection(
        profiles,
        savedUrl,
        savedActiveProfileId,
        DEFAULT_GATEWAY_URL,
      );
      const auth = activeProfile ? await authCredentialsForProfile(activeProfile) : {};
      const client = new GatewayClient(url, auth);

      // Subscribe to fleet events
      client.subscribe(Events.FLEET_UPDATED, (payload) => {
        const data = payload as { fleet: FleetStatusResult['fleet'] };
        if (data.fleet) {
          useFleetStore.getState().setFleet(data.fleet);
        }
      });

      client.subscribe(Events.SLOT_CHANGED, (payload) => {
        const slot = payload as SlotStatus;
        if (slot?.slot) {
          useFleetStore.getState().updateSlot(slot);
        }
      });

      // Run events
      client.subscribe(Events.RUN_UPDATED, (payload) => {
        const data = payload as { run: Run };
        if (data.run) useRunStore.getState().upsertRun(data.run);
      });

      client.subscribe(Events.RUN_COMPLETED, (payload) => {
        const data = payload as { run: Run };
        if (data.run) {
          useRunStore.getState().upsertRun(data.run);
          notifyRunCompleted(data.run);
        }
      });

      client.subscribe(Events.RUN_CREATED, (payload) => {
        const data = payload as { run: Run };
        if (data.run) useRunStore.getState().upsertRun(data.run);
      });

      client.subscribe(Events.PR_UPDATED, (payload) => {
        const data = payload as PRUpdatedPayload;
        if (data.pr) usePRStore.getState().upsertPR(data.pr);
      });

      let decisionRefreshInFlight: Promise<void> | null = null;
      const clearDecisionSyncError = () => {
        set((state) => ({
          lastSyncError: state.lastSyncError?.startsWith('Failed to refresh decisions')
            ? null
            : state.lastSyncError,
        }));
      };
      const refreshDecisions = (reason: string) => {
        if (decisionRefreshInFlight) return;
        decisionRefreshInFlight = client
          .request<DecisionListResult>(Methods.DECISION_LIST, undefined, DECISION_LIST_TIMEOUT_MS)
          .then((result) => {
            useDecisionStore.getState().setDecisions(result.decisions);
            clearDecisionSyncError();
          })
          .catch((err: Error) => {
            set({ lastSyncError: `Failed to refresh decisions after ${reason}: ${err.message}` });
          })
          .finally(() => {
            decisionRefreshInFlight = null;
          });
      };

      // Decision events + notifications
      client.subscribe(Events.DECISION_NEW, (payload) => {
        const d = normalizeDecisionEvent(payload);
        if (d?.id) {
          useDecisionStore.getState().addDecision(d);
          notifyDecision(d);
        } else {
          refreshDecisions('decision.new');
        }
      });

      client.subscribe(Events.RUN_DECISION_NEW, (payload) => {
        const d = normalizeDecisionEvent(payload);
        if (d?.id && d.runMeta) {
          useDecisionStore.getState().addDecision(d);
          notifyDecision(d);
          if (d.type === 'retrospective' && !d.payload) {
            refreshDecisions('run.decision.new incomplete retrospective');
          } else {
            clearDecisionSyncError();
          }
        } else {
          refreshDecisions('run.decision.new fallback');
        }
      });

      const upsertDecisionFromEvent = (payload: unknown, reason: string) => {
        const d = normalizeDecisionEvent(payload);
        if (d?.id && d.runMeta) {
          useDecisionStore.getState().upsertDecision(d);
          if (d.type === 'retrospective' && !d.payload) {
            refreshDecisions(`${reason} incomplete retrospective`);
          } else {
            clearDecisionSyncError();
          }
          return;
        }
        refreshDecisions(`${reason} fallback`);
      };

      client.subscribe(Events.DECISION_UPDATED, (payload) => {
        upsertDecisionFromEvent(payload, 'decision.updated');
      });

      client.subscribe(Events.RUN_DECISION_UPDATED, (payload) => {
        upsertDecisionFromEvent(payload, 'run.decision.updated');
      });

      client.subscribe(Events.MONITOR_VIOLATION, (payload) => {
        notifyViolation(payload as MonitorViolationPayload);
      });

      client.subscribe(Events.DECISION_RESOLVED, (payload) => {
        const data = payload as { decisionId: string };
        if (data.decisionId) useDecisionStore.getState().removeDecision(data.decisionId);
      });

      client.subscribe(Events.RUN_DECISION_RESOLVED, (payload) => {
        const data = payload as { decisionId: string };
        if (data.decisionId) useDecisionStore.getState().removeDecision(data.decisionId);
      });

      client.onConnectionChange((status) => {
        const liveness = livenessForTransportState(livenessFromStore(get()), status);
        set({
          status,
          ...livenessPatch(liveness),
          lastConnectedAt: status === 'connected' ? Date.now() : get().lastConnectedAt,
        });
        if (status !== 'connected') {
          usePRStore.getState().setLoading(false);
          useRunStore.getState().setActiveLoading(false);
          useRunStore.getState().resetHistorySync();
        }

        // Fetch all state on connect/reconnect
        if (status === 'connected') {
          void livenessController?.probeFresh();
          useFleetStore.getState().setLoading(true);
          useRunStore.getState().resetHistorySync();
          useRunStore.getState().setActiveLoading(true);
          client
            .request<FleetStatusResult>(Methods.FLEET_STATUS)
            .then((result) => {
              useFleetStore.getState().setFleet(result.fleet);
              set({ lastSyncError: null });
            })
            .catch((err: Error) => {
              set({ lastSyncError: `Failed to refresh fleet: ${err.message}` });
              useFleetStore.getState().setLoading(false);
            });

          fetchActiveRuns(client)
            .then((runs) => {
              useRunStore.getState().setRuns(runs);
              set((state) => ({
                lastSyncError:
                  state.lastSyncError?.startsWith('Failed to refresh runs:') ||
                  state.lastSyncError?.startsWith('Failed to download run history:')
                    ? null
                    : state.lastSyncError,
              }));
            })
            .catch((err: Error) => {
              useRunStore.getState().setActiveLoading(false);
              set({ lastSyncError: `Failed to refresh runs: ${err.message}` });
            });

          refreshDecisions('connection sync');

          // PR_LIST fans out through GitHub and can legitimately outlive a cold
          // connect. Keep it lazy on the PR screen so a slow PR refresh does not
          // turn the whole app connection banner into a warning.
        }
      });

      set({
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
      client.connect();
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
      probeAttemptTracker.invalidate();
      livenessController?.reset();
    }
    state.client?.setConnection(url, auth);
    if (transition.changed) void livenessController?.probeFresh();
  },

  setActiveProfile: async (profileId: string) => {
    const profile = get().profiles.find((candidate) => candidate.id === profileId);
    if (!profile) return;
    await AsyncStorage.setItem(ACTIVE_GATEWAY_PROFILE_KEY, profile.id);
    await AsyncStorage.setItem(GATEWAY_URL_KEY, profile.url);
    const auth = await authCredentialsForProfile(profile);
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
      probeAttemptTracker.invalidate();
      livenessController?.reset();
    }
    state.client?.setConnection(profile.url, auth);
    if (transition.changed) void livenessController?.probeFresh();
  },

  saveProfile: async (profile: GatewayProfile, secret?: string) => {
    const normalizedProfile: GatewayProfile = {
      ...profile,
      authMode: profile.authMode ?? 'none',
      secretStorageKey:
        profile.authMode && profile.authMode !== 'none'
          ? (profile.secretStorageKey ?? profileSecretStorageKey(profile.id))
          : undefined,
    };
    if (secret !== undefined && normalizedProfile.authMode !== 'none') {
      await writeGatewayProfileSecret(normalizedProfile, secret);
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
        probeAttemptTracker.invalidate();
        livenessController?.reset();
      }
      state.client?.setConnection(updated.url, auth);
      if (transition.changed) void livenessController?.probeFresh();
    }
  },

  deleteProfile: async (profileId: string) => {
    const profile = get().profiles.find((candidate) => candidate.id === profileId);
    if (!profile || profile.readonly) return;
    const profiles = mergeGatewayProfiles(
      get().profiles.filter((candidate) => candidate.id !== profileId),
    );
    await AsyncStorage.setItem(
      GATEWAY_PROFILES_KEY,
      JSON.stringify(sanitizeGatewayProfilesForStorage(profiles)),
    );
    await writeGatewayProfileSecret(profile, '');
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
        ...livenessPatch(INITIAL_CONNECTION_LIVENESS),
        gatewayCompatibilityHint: null,
      });
      probeAttemptTracker.invalidate();
      livenessController?.reset();
      state.client?.setConnection('', {});
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
      probeAttemptTracker.invalidate();
      livenessController?.reset();
    }
    state.client?.setConnection(nextProfile.url, auth);
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
    const removableProfiles = [...get().profiles, ...rawSavedProfiles].filter(
      (profile) =>
        !preservedSecretKeys.has(profile.secretStorageKey ?? profileSecretStorageKey(profile.id)),
    );
    await Promise.all(removableProfiles.map((profile) => writeGatewayProfileSecret(profile, '')));
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
        ...livenessPatch(INITIAL_CONNECTION_LIVENESS),
        gatewayCompatibilityHint: null,
      });
      probeAttemptTracker.invalidate();
      livenessController?.reset();
      state.client?.setConnection('', {});
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
      probeAttemptTracker.invalidate();
      livenessController?.reset();
    }
    state.client?.setConnection(nextProfile.url, auth);
    if (transition.changed) void livenessController?.probeFresh();
  },

  connect: () => {
    get().client?.connect();
  },

  retryConnection: async () => {
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

  retryDecisionSync: async () => {
    const { client, status } = get();
    if (!client || status !== 'connected') return;
    try {
      const result = await client.request<DecisionListResult>(
        Methods.DECISION_LIST,
        undefined,
        DECISION_LIST_TIMEOUT_MS,
      );
      useDecisionStore.getState().setDecisions(result.decisions);
      set((state) => ({
        lastSyncError: state.lastSyncError?.startsWith('Failed to refresh decisions')
          ? null
          : state.lastSyncError,
      }));
    } catch (err) {
      set({ lastSyncError: `Failed to refresh decisions: ${(err as Error).message}` });
    }
  },

  syncRunHistory: async () => {
    const { client, status } = get();
    if (!client || status !== 'connected') return;
    const runStore = useRunStore.getState();
    if (runStore.activeLoading || runStore.historyLoaded || runStore.historyLoading) return;

    runStore.setHistoryLoading(true);
    try {
      const runs = await fetchRecentRunHistory(client);
      useRunStore.getState().mergeRuns(runs);
      set((state) => ({
        lastSyncError: state.lastSyncError?.startsWith('Failed to download run history:')
          ? null
          : state.lastSyncError,
      }));
    } catch (err) {
      useRunStore.getState().setHistoryLoading(false);
      set({
        lastSyncError: `Failed to download run history: ${(err as Error).message}`,
      });
    }
  },
}));

async function authCredentialsForProfile(profile: GatewayProfile): Promise<GatewayAuthCredentials> {
  if (profile.authMode === 'token') {
    const token = await readGatewayProfileSecret(profile);
    return token ? { token } : {};
  }
  if (profile.authMode === 'password') {
    const password = await readGatewayProfileSecret(profile);
    return password ? { password } : {};
  }
  return {};
}

async function readSavedProfiles(): Promise<GatewayProfile[]> {
  const raw = await AsyncStorage.getItem(GATEWAY_PROFILES_KEY);
  return parseGatewayProfilesFromStorage(raw);
}

function normalizeDecisionEvent(payload: unknown): PendingDecision | null {
  const event = payload as DecisionNewEventPayload;
  const raw = event.decision ?? (payload as PendingDecision | undefined);
  if (!raw?.id || !raw.title || !raw.description || !raw.actions || !raw.createdAt) return null;
  return raw;
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
    'gatewayUrl' | 'activeProfileId' | 'activeProfileAuthMode' | 'activeProfileHttpAuthHeaders'
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
          ...livenessPatch(INITIAL_CONNECTION_LIVENESS),
          gatewayCompatibilityHint: null,
          probeInProgress: false,
        }
      : {},
  };
}
