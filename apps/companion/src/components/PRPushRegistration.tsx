import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';

import { registerPRPushDevice, usePRPushDeviceState } from '../lib/pr-push-device';
import { useAttentionPrefsStore } from '../store/attention-prefs';
import { useConnectionStore } from '../store/connection';

/** Refresh previously enrolled devices after reconnect, token rotation or app foreground. */
export function PRPushRegistration() {
  const seen = useRef(new Set<string>());
  const client = useConnectionStore((state) => state.client);
  const status = useConnectionStore((state) => state.status);
  const access = useConnectionStore((state) => state.workspaceAccess);
  const profileId = useConnectionStore((state) => state.activeProfileId);
  const authHeaders = useConnectionStore((state) => state.activeProfileHttpAuthHeaders);
  const enabled = useAttentionPrefsStore((state) => state.enabled);
  const sound = useAttentionPrefsStore((state) => state.sound);
  const initialized = useAttentionPrefsStore((state) => state.initialized);
  useEffect(() => {
    if (!client || status !== 'connected' || access !== 'farm' || !initialized) return;
    let active = true;
    let pending = false;
    const generation = client.connectionGeneration;
    const isCurrent = () =>
      active &&
      client.connectionState === 'connected' &&
      client.workspaceAccess === 'farm' &&
      client.connectionGeneration === generation;
    const refresh = () => {
      if (pending || !isCurrent()) return;
      pending = true;
      void registerPRPushDevice(client, profileId, { enabled, sound }, false, isCurrent)
        .then(
          () => {
            if (isCurrent()) usePRPushDeviceState.getState().setError('');
          },
          (error) => {
            if (isCurrent())
              usePRPushDeviceState
                .getState()
                .setError(error instanceof Error ? error.message : String(error));
          },
        )
        .finally(() => {
          pending = false;
        });
    };
    refresh();
    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'active') refresh();
    });
    const token = Notifications.addPushTokenListener(refresh);
    return () => {
      active = false;
      appState.remove();
      token.remove();
    };
  }, [client, status, access, profileId, authHeaders, enabled, sound, initialized]);

  useEffect(() => {
    if (!client || access !== 'farm') return;
    let active = true;
    const principalId = client.authenticatedPrincipal?.id;
    const open = async (response: Notifications.NotificationResponse | null) => {
      if (
        !response ||
        !active ||
        client.workspaceAccess !== 'farm' ||
        client.authenticatedPrincipal?.id !== principalId
      )
        return;
      const content = response.notification.request.content.data;
      if (
        !content ||
        typeof content.notificationId !== 'string' ||
        typeof content.profileId !== 'string' ||
        typeof content.route !== 'string' ||
        !content.route.startsWith('/pr-automation?')
      )
        return;
      const id = response.notification.request.identifier;
      if (seen.current.has(id)) return;
      seen.current.add(id);
      try {
        const state = useConnectionStore.getState();
        if (!state.profiles.some((profile) => profile.id === content.profileId))
          throw new Error('The notification gateway profile is no longer saved.');
        if (state.activeProfileId !== content.profileId)
          await state.setActiveProfile(content.profileId);
        if (
          !active ||
          useConnectionStore.getState().workspaceAccess !== 'farm' ||
          client.authenticatedPrincipal?.id !== principalId
        )
          return;
        router.push(content.route);
        await Notifications.clearLastNotificationResponseAsync();
      } catch (error) {
        if (!active) return;
        seen.current.delete(id);
        usePRPushDeviceState
          .getState()
          .setError(error instanceof Error ? error.message : String(error));
      }
    };
    const listener = Notifications.addNotificationResponseReceivedListener((response) => {
      void open(response);
    });
    void Notifications.getLastNotificationResponseAsync().then(open, (error) => {
      if (!active) return;
      usePRPushDeviceState
        .getState()
        .setError(error instanceof Error ? error.message : String(error));
    });
    return () => {
      active = false;
      listener.remove();
    };
  }, [client, access]);
  return null;
}
