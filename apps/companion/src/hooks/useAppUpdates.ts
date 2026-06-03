import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Updates from 'expo-updates';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { getCompanionEnvironment } from '../lib/app-environment';

const UPDATE_RESTART_ATTEMPT_KEY = '@farmslot:updateRestartAttempt';
const UPDATE_RELOAD_SETTLE_MS = 250;

type UpdateRestartAttempt = {
  attemptedAt: string;
  currentUpdateId?: string;
  targetUpdateId?: string;
};

export type AppUpdateStatus =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'downloaded'
  | 'restarting'
  | 'error';

export interface CheckUpdatesOptions {
  silent?: boolean;
  reloadWhenDownloaded?: boolean;
}

export interface AppUpdatesState {
  status: AppUpdateStatus;
  message: string;
  currentUpdateId?: string;
  channel?: string;
  runtimeVersion?: string;
  isEmbeddedLaunch: boolean;
  isEmergencyLaunch: boolean;
  checkUpdates: (options?: CheckUpdatesOptions) => Promise<void>;
  reloadDownloadedUpdate: () => Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function updateIdFromInfo(update: Updates.UpdateInfo | undefined): string | undefined {
  if (!update || update.type !== Updates.UpdateInfoType.NEW) return undefined;
  return update.updateId;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useAppUpdates(): AppUpdatesState {
  const environment = getCompanionEnvironment();
  const [manualStatus, setManualStatus] = useState<AppUpdateStatus>('idle');
  const [message, setMessage] = useState('Updates are ready.');
  const updatesState = Updates.useUpdates();
  const updatesEnabled = Updates.isEnabled && !__DEV__;
  const currentUpdateId = updatesState.currentlyRunning.updateId ?? Updates.updateId ?? undefined;
  const downloadedUpdateId = updateIdFromInfo(updatesState.downloadedUpdate);

  const status = useMemo<AppUpdateStatus>(() => {
    if (!updatesEnabled) return 'disabled';
    if (updatesState.isRestarting || manualStatus === 'restarting') return 'restarting';
    if (updatesState.isDownloading || manualStatus === 'downloading') return 'downloading';
    if (updatesState.isChecking || manualStatus === 'checking') return 'checking';
    if (updatesState.downloadedUpdate || manualStatus === 'downloaded') return 'downloaded';
    if (manualStatus === 'error') return 'error';
    return 'idle';
  }, [manualStatus, updatesEnabled, updatesState]);

  useEffect(() => {
    if (!updatesEnabled) {
      setMessage(
        __DEV__ ? 'OTA updates are disabled in development.' : 'Expo Updates are disabled.',
      );
      return;
    }
    let disposed = false;
    const clearCompletedRestartAttempt = async () => {
      try {
        const rawAttempt = await AsyncStorage.getItem(UPDATE_RESTART_ATTEMPT_KEY);
        if (!rawAttempt || disposed) return;
        const attempt = JSON.parse(rawAttempt) as UpdateRestartAttempt;
        if (attempt.targetUpdateId && attempt.targetUpdateId === currentUpdateId) {
          await AsyncStorage.removeItem(UPDATE_RESTART_ATTEMPT_KEY);
          if (!disposed) setMessage('Updated to the latest OTA bundle.');
        }
      } catch (error) {
        if (!disposed) {
          setManualStatus('error');
          setMessage(`Could not inspect previous update restart: ${getErrorMessage(error)}`);
        }
      }
    };
    void clearCompletedRestartAttempt();
    return () => {
      disposed = true;
    };
  }, [currentUpdateId, updatesEnabled]);

  const restartWithUpdate = useCallback(
    async (targetUpdateId?: string) => {
      if (!updatesEnabled) {
        setManualStatus('disabled');
        setMessage('OTA updates are disabled for this runtime.');
        return;
      }

      setManualStatus('restarting');
      setMessage('Restarting Farmslot to finish the update…');
      try {
        await AsyncStorage.setItem(
          UPDATE_RESTART_ATTEMPT_KEY,
          JSON.stringify({
            attemptedAt: new Date().toISOString(),
            currentUpdateId,
            targetUpdateId,
          } satisfies UpdateRestartAttempt),
        );
        await sleep(UPDATE_RELOAD_SETTLE_MS);
        await Updates.showReloadScreen({
          reloadScreenOptions: {
            backgroundColor: environment.appAccentColor,
            fade: true,
            spinner: { enabled: true, color: '#ffffff', size: 'large' },
          },
        });
        void Updates.reloadAsync({
          reloadScreenOptions: {
            backgroundColor: environment.appAccentColor,
            fade: true,
            spinner: { enabled: true, color: '#ffffff', size: 'large' },
          },
        });
      } catch (error) {
        setManualStatus('error');
        setMessage(`Failed to restart with downloaded update: ${getErrorMessage(error)}`);
      }
    },
    [currentUpdateId, environment.appAccentColor, updatesEnabled],
  );

  const reloadDownloadedUpdate = useCallback(async () => {
    if (!updatesState.downloadedUpdate) {
      setManualStatus('idle');
      setMessage('No downloaded update is ready to install.');
      return;
    }
    await restartWithUpdate(downloadedUpdateId);
  }, [downloadedUpdateId, restartWithUpdate, updatesState.downloadedUpdate]);

  const checkUpdates = useCallback(
    async (options: CheckUpdatesOptions = {}) => {
      if (!updatesEnabled) {
        setManualStatus('disabled');
        if (!options.silent) setMessage('OTA updates are disabled for this runtime.');
        return;
      }
      if (status === 'checking' || status === 'downloading' || status === 'restarting') return;

      setManualStatus('checking');
      if (!options.silent) setMessage('Checking for OTA updates…');
      try {
        const result = await Updates.checkForUpdateAsync();
        if (!result.isAvailable) {
          setManualStatus('idle');
          if (!options.silent)
            setMessage(`Already up to date on ${Updates.channel ?? 'this channel'}.`);
          return;
        }

        setManualStatus('downloading');
        setMessage('Downloading OTA update…');
        const fetchResult = await Updates.fetchUpdateAsync();
        if (fetchResult.isNew || fetchResult.isRollBackToEmbedded) {
          setManualStatus('downloaded');
          setMessage('Update downloaded. Restarting Farmslot…');
          if (options.reloadWhenDownloaded) {
            await restartWithUpdate(
              fetchResult.isNew && 'id' in fetchResult.manifest
                ? String(fetchResult.manifest.id)
                : undefined,
            );
          }
          return;
        }

        setManualStatus('idle');
        setMessage('No newer OTA bundle was downloaded.');
      } catch (error) {
        setManualStatus('error');
        setMessage(`Update check failed: ${getErrorMessage(error)}`);
      }
    },
    [restartWithUpdate, status, updatesEnabled],
  );

  return {
    status,
    message,
    currentUpdateId,
    channel: updatesState.currentlyRunning.channel ?? Updates.channel ?? undefined,
    runtimeVersion:
      updatesState.currentlyRunning.runtimeVersion ?? Updates.runtimeVersion ?? undefined,
    isEmbeddedLaunch: updatesState.currentlyRunning.isEmbeddedLaunch,
    isEmergencyLaunch: updatesState.currentlyRunning.isEmergencyLaunch,
    checkUpdates,
    reloadDownloadedUpdate,
  };
}
