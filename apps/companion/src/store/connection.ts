import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';

import {
  type DecisionListResult,
  Events,
  type FleetStatusResult,
  Methods,
  type MonitorViolationPayload,
  type PendingDecision,
  type PRListResult,
  type PRUpdatedPayload,
  type Run,
  type RunDecision,
  type RunListResult,
  type SlotStatus,
} from '@farmslot/protocol';

import {
  type ConnectionState,
  type GatewayAuthCredentials,
  GatewayClient,
  type GatewayHttpAuthHeaders,
  gatewayHttpAuthHeaders,
} from '../lib/gateway-client';
import {
  parseGatewayProfilesFromStorage,
  sanitizeGatewayProfilesForStorage,
} from '../lib/gateway-profile-storage';
import {
  DEFAULT_GATEWAY_PROFILES,
  DEFAULT_GATEWAY_URL,
  type GatewayProfile,
  type GatewayProfileAuthMode,
  isLegacyLocalhostGatewayUrl,
  isLegacyPresetGatewayUrl,
  mergeGatewayProfiles,
  profileIdForUrl,
  profileSecretStorageKey,
  readGatewayProfileSecret,
  seedPresetGatewayProfileSecrets,
  writeGatewayProfileSecret,
} from '../lib/gateway-profiles';
import { notifyDecision, notifyRunCompleted, notifyViolation } from '../lib/notifications';

import { useDecisionStore } from './decisions';
import { useFleetStore } from './fleet';
import { usePRStore } from './prs';
import { useRunStore } from './runs';

const GATEWAY_URL_KEY = '@farmslot:gatewayUrl';
const GATEWAY_PROFILES_KEY = '@farmslot:gatewayProfiles';
const ACTIVE_GATEWAY_PROFILE_KEY = '@farmslot:activeGatewayProfileId';
const PR_LIST_TIMEOUT_MS = 30_000;

type DecisionNewEventPayload = {
  decision?: PendingDecision | RunDecision;
  slotId?: string | null;
  runId?: string;
};

interface ConnectionStore {
  status: ConnectionState;
  gatewayUrl: string;
  profiles: GatewayProfile[];
  activeProfileId: string;
  activeProfileAuthMode: GatewayProfileAuthMode;
  activeProfileHttpAuthHeaders: GatewayHttpAuthHeaders;
  client: GatewayClient | null;
  lastConnectedAt: number | null;
  lastSyncError: string | null;
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
  connect: () => void;
  disconnect: () => void;
}

export const useConnectionStore = create<ConnectionStore>((set, get) => ({
  status: 'disconnected',
  gatewayUrl: DEFAULT_GATEWAY_URL,
  profiles: DEFAULT_GATEWAY_PROFILES,
  activeProfileId: DEFAULT_GATEWAY_PROFILES[0]?.id ?? '',
  activeProfileAuthMode: DEFAULT_GATEWAY_PROFILES[0]?.authMode ?? 'none',
  activeProfileHttpAuthHeaders: {},
  client: null,
  lastConnectedAt: null,
  lastSyncError: null,

  init: async () => {
    if (get().client) return; // Prevent double-init on HMR
    const saved = await AsyncStorage.getItem(GATEWAY_URL_KEY);
    const savedProfiles = await readSavedProfiles();
    const profiles = mergeGatewayProfiles(savedProfiles);
    await seedPresetGatewayProfileSecrets(profiles);
    const savedActiveProfileId = await AsyncStorage.getItem(ACTIVE_GATEWAY_PROFILE_KEY);
    const savedUrl =
      saved && !isLegacyLocalhostGatewayUrl(saved) && !isLegacyPresetGatewayUrl(saved)
        ? saved
        : null;
    const activeProfile =
      profiles.find((profile) => profile.id === savedActiveProfileId) ??
      (savedUrl ? profiles.find((profile) => profile.url === savedUrl) : undefined) ??
      profiles[0] ??
      null;
    const url = savedUrl || activeProfile?.url || DEFAULT_GATEWAY_URL;
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

    const refreshDecisions = (reason: string) => {
      client
        .request<DecisionListResult>('decision.list')
        .then((result) => {
          useDecisionStore.getState().setDecisions(result.decisions);
          set({ lastSyncError: null });
        })
        .catch((err: Error) => {
          set({ lastSyncError: `Failed to refresh decisions after ${reason}: ${err.message}` });
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
      if (d?.id) {
        useDecisionStore.getState().addDecision(d);
        notifyDecision(d);
        if (!hasDecisionPayload(d) || !d.runMeta) refreshDecisions('run.decision.new fallback');
      } else {
        refreshDecisions('run.decision.new');
      }
    });

    const upsertDecisionFromEvent = (payload: unknown, reason: string) => {
      const d = normalizeDecisionEvent(payload);
      if (d?.id) {
        useDecisionStore.getState().upsertDecision(d);
        if (!hasDecisionPayload(d) || !d.runMeta) refreshDecisions(`${reason} fallback`);
        return;
      }
      refreshDecisions(reason);
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
      set({
        status,
        lastConnectedAt: status === 'connected' ? Date.now() : get().lastConnectedAt,
      });
      if (status !== 'connected') usePRStore.getState().setLoading(false);

      // Fetch all state on connect/reconnect
      if (status === 'connected') {
        useFleetStore.getState().setLoading(true);
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

        client
          .request<RunListResult>(Methods.RUN_LIST, { limit: 30 })
          .then((result) => {
            useRunStore.getState().setRuns(result.runs);
            set({ lastSyncError: null });
          })
          .catch((err: Error) => set({ lastSyncError: `Failed to refresh runs: ${err.message}` }));

        client
          .request<DecisionListResult>(Methods.DECISION_LIST)
          .then((result) => {
            useDecisionStore.getState().setDecisions(result.decisions);
            set({ lastSyncError: null });
          })
          .catch((err: Error) =>
            set({ lastSyncError: `Failed to refresh decisions: ${err.message}` }),
          );

        usePRStore.getState().setLoading(true);
        client
          .request<PRListResult>(Methods.PR_LIST, {}, PR_LIST_TIMEOUT_MS)
          .then((result) => {
            usePRStore.getState().setPRs(result.prs);
            set({ lastSyncError: null });
          })
          .catch((err: Error) => {
            usePRStore.getState().setError(`Failed to refresh PRs: ${err.message}`);
            set({ lastSyncError: `Failed to refresh PRs: ${err.message}` });
          });
      }
    });

    set({
      gatewayUrl: url,
      profiles,
      activeProfileId: profileIdForUrl(profiles, url) ?? activeProfile?.id ?? '',
      activeProfileAuthMode: activeProfile?.authMode ?? 'none',
      activeProfileHttpAuthHeaders: gatewayHttpAuthHeaders(auth),
      client,
    });
    client.connect();
  },

  setGatewayUrl: async (url: string) => {
    if (url) await AsyncStorage.setItem(GATEWAY_URL_KEY, url);
    else await AsyncStorage.removeItem(GATEWAY_URL_KEY);
    const { profiles } = get();
    const matchingProfileId = profileIdForUrl(profiles, url);
    if (matchingProfileId)
      await AsyncStorage.setItem(ACTIVE_GATEWAY_PROFILE_KEY, matchingProfileId);
    const { client } = get();
    const profile = matchingProfileId
      ? profiles.find((candidate) => candidate.id === matchingProfileId)
      : undefined;
    const auth = profile ? await authCredentialsForProfile(profile) : {};
    if (client) {
      client.setConnection(url, auth);
    }
    set({
      gatewayUrl: url,
      activeProfileId: matchingProfileId ?? (url ? get().activeProfileId : ''),
      activeProfileAuthMode: matchingProfileId ? (profile?.authMode ?? 'none') : 'none',
      activeProfileHttpAuthHeaders: matchingProfileId ? gatewayHttpAuthHeaders(auth) : {},
    });
  },

  setActiveProfile: async (profileId: string) => {
    const profile = get().profiles.find((candidate) => candidate.id === profileId);
    if (!profile) return;
    await AsyncStorage.setItem(ACTIVE_GATEWAY_PROFILE_KEY, profile.id);
    await AsyncStorage.setItem(GATEWAY_URL_KEY, profile.url);
    const { client } = get();
    const auth = await authCredentialsForProfile(profile);
    if (client) client.setConnection(profile.url, auth);
    set({
      activeProfileId: profile.id,
      activeProfileAuthMode: profile.authMode ?? 'none',
      activeProfileHttpAuthHeaders: gatewayHttpAuthHeaders(auth),
      gatewayUrl: profile.url,
    });
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
      const { client } = get();
      if (client) client.setConnection(updated.url, auth);
      set({
        activeProfileAuthMode: authMode,
        activeProfileHttpAuthHeaders: gatewayHttpAuthHeaders(auth),
      });
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
    const { client } = get();
    const nextProfile = profiles[0] ?? null;
    if (!nextProfile) {
      await AsyncStorage.removeItem(ACTIVE_GATEWAY_PROFILE_KEY);
      await AsyncStorage.removeItem(GATEWAY_URL_KEY);
      if (client) client.setConnection('', {});
      set({
        profiles,
        activeProfileId: '',
        activeProfileAuthMode: 'none',
        activeProfileHttpAuthHeaders: {},
        gatewayUrl: '',
      });
      return;
    }
    await AsyncStorage.setItem(ACTIVE_GATEWAY_PROFILE_KEY, nextProfile.id);
    await AsyncStorage.setItem(GATEWAY_URL_KEY, nextProfile.url);
    const auth = await authCredentialsForProfile(nextProfile);
    if (client) client.setConnection(nextProfile.url, auth);
    set({
      profiles,
      activeProfileId: nextProfile.id,
      activeProfileAuthMode: nextProfile.authMode ?? 'none',
      activeProfileHttpAuthHeaders: gatewayHttpAuthHeaders(auth),
      gatewayUrl: nextProfile.url,
    });
  },

  connect: () => {
    get().client?.connect();
  },

  disconnect: () => {
    get().client?.disconnect();
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

  if ('runMeta' in raw && raw.runMeta) return raw as PendingDecision;

  // Run-decision websocket events can carry the decision payload before the
  // richer PendingDecision projection exists. The inbox tolerates optional
  // runMeta, and the subscriber above refetches when metadata is incomplete.
  const decision: PendingDecision = {
    id: raw.id,
    type: raw.type as PendingDecision['type'],
    slotId: event.slotId ?? (raw as PendingDecision).slotId ?? null,
    title: raw.title,
    description: raw.description,
    context: {
      ...(raw.context ?? {}),
      ...(event.runId ? { runId: event.runId } : {}),
    },
    actions: raw.actions,
    createdAt: raw.createdAt,
    payload: (raw as RunDecision).payload,
  };
  return decision;
}

function hasDecisionPayload(decision: PendingDecision): boolean {
  return 'payload' in decision && Boolean((decision as { payload?: unknown }).payload);
}
