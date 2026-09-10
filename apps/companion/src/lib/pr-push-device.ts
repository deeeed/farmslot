import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { create } from 'zustand';

import { Methods, type PRPushListResult, type PRPushRegisterParams } from '@farmslot/protocol';

import { useAttentionPrefsStore } from '../store/attention-prefs';

import type { GatewayClient } from './gateway-client';

const INSTALLATION_KEY = '@farmslot:prPushInstallation';
let installation: Promise<string> | undefined;
export function prPushInstallation(): Promise<string> {
  installation ??= (async () => {
    const saved = await AsyncStorage.getItem(INSTALLATION_KEY);
    if (saved) return saved;
    const id = `companion-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    await AsyncStorage.setItem(INSTALLATION_KEY, id);
    return id;
  })();
  return installation;
}

export const usePRPushDeviceState = create<{ error: string; setError: (error: string) => void }>(
  (set) => ({ error: '', setError: (error) => set({ error }) }),
);

export async function registerPRPushDevice(
  client: GatewayClient,
  profileId: string,
  preferences: { enabled: boolean; sound: boolean },
  requestPermission: boolean,
  isCurrent: () => boolean,
): Promise<void> {
  const installationId = await prPushInstallation();
  if (!isCurrent()) return;
  const saved = await client.request<PRPushListResult>(Methods.PR_PUSH_LIST, {});
  const device = saved.devices.find((device) => device.installationId === installationId);
  if (!requestPermission) {
    if (!device?.enabled && device?.error !== 'DeviceNotRegistered') return;
  }
  if (!preferences.enabled) {
    if (isCurrent()) await client.request(Methods.PR_PUSH_UNREGISTER, { installationId });
    return;
  }
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(
      preferences.sound ? 'pr-attention' : 'pr-attention-silent',
      {
        name: preferences.sound ? 'PR attention' : 'PR attention without sound',
        // Android uses its system sound when this field is omitted. A string
        // is a bundled resource filename; null explicitly makes it silent.
        ...(preferences.sound ? {} : { sound: null }),
        importance: Notifications.AndroidImportance.HIGH,
      },
    );
  }
  const permission = requestPermission
    ? await Notifications.requestPermissionsAsync()
    : await Notifications.getPermissionsAsync();
  if (permission.status !== 'granted') {
    if (isCurrent()) await client.request(Methods.PR_PUSH_UNREGISTER, { installationId });
    throw new Error('Allow notifications in device settings to receive PR push alerts.');
  }
  const projectId = Constants.expoConfig?.extra?.eas?.projectId;
  if (typeof projectId !== 'string' || !projectId)
    throw new Error('This build has no push project configured.');
  const token = await Notifications.getExpoPushTokenAsync({ projectId });
  if (!isCurrent()) return;
  if (!useAttentionPrefsStore.getState().enabled) {
    await client.request(Methods.PR_PUSH_UNREGISTER, { installationId });
    return;
  }
  const params: PRPushRegisterParams = {
    installationId,
    expectedRevision: device?.revision,
    token: token.data,
    profileId,
    enabled: true,
    sound: preferences.sound,
    platform: Platform.OS === 'ios' ? 'ios' : 'android',
  };
  await client.request(Methods.PR_PUSH_REGISTER, params);
}
