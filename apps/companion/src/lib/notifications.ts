import * as Haptics from 'expo-haptics';
import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { AppState } from 'react-native';

import type { PendingDecision, Run } from '@farmslot/protocol';

import { useAttentionPrefsStore } from '../store/attention-prefs';

import {
  monitorViolationBody,
  monitorViolationDedupeKey,
  type MonitorViolationInput,
  monitorViolationTitle,
  normalizeMonitorViolation,
} from './notification-format';

let initialized = false;
const MONITOR_NOTIFICATION_DEDUPE_MS = 10 * 60 * 1000;
const recentMonitorNotificationAt = new Map<string, number>();
const recentDecisionNotificationAt = new Map<string, number>();
let currentAppState = AppState.currentState;

function shouldNotifyMonitorViolation(
  violation: NonNullable<ReturnType<typeof normalizeMonitorViolation>>,
  now = Date.now(),
): boolean {
  const key = monitorViolationDedupeKey(violation);
  const previous = recentMonitorNotificationAt.get(key);
  if (previous && now - previous < MONITOR_NOTIFICATION_DEDUPE_MS) return false;
  recentMonitorNotificationAt.set(key, now);
  return true;
}

export async function initNotifications() {
  if (initialized) return;
  initialized = true;

  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge: true,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });

  const { status } = await Notifications.requestPermissionsAsync();
  if (status !== 'granted') return;

  AppState.addEventListener('change', (state) => {
    currentAppState = state;
  });

  // Handle notification tap → navigate
  Notifications.addNotificationResponseReceivedListener((response) => {
    const data = response.notification.request.content.data;
    if (data?.route) {
      router.push(data.route as string);
    }
  });
}

export async function notifyDecision(decision: PendingDecision) {
  const preferences = useAttentionPrefsStore.getState();
  if (!preferences.enabled) return;
  const previous = recentDecisionNotificationAt.get(decision.id);
  if (previous && Date.now() - previous < MONITOR_NOTIFICATION_DEDUPE_MS) return;
  recentDecisionNotificationAt.set(decision.id, Date.now());
  if (preferences.haptics && currentAppState === 'active') {
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
  }
  await Notifications.scheduleNotificationAsync({
    content: {
      title: 'Decision Required',
      body: decision.title,
      data: { route: '/(tabs)/inbox' },
      sound: preferences.sound,
    },
    trigger: null,
  });
}

export async function notifyViolation(payload: MonitorViolationInput) {
  const violation = normalizeMonitorViolation(payload);
  const preferences = useAttentionPrefsStore.getState();
  if (!preferences.enabled || !violation || !shouldNotifyMonitorViolation(violation)) return;
  if (preferences.haptics && currentAppState === 'active') {
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
  }
  if (currentAppState === 'active') return;

  await Notifications.scheduleNotificationAsync({
    content: {
      title: monitorViolationTitle(violation),
      body: monitorViolationBody(violation),
      data: { route: `/slot/${violation.slotId}` },
      sound: preferences.sound,
    },
    trigger: null,
  });
}

export async function notifyRunCompleted(run: Run) {
  // Completion is informational, not an operator-attention alert. It keeps the
  // existing notification behavior independently of decision/violation prefs.
  await Notifications.scheduleNotificationAsync({
    content: {
      title: 'Run Completed',
      body: `${run.flowType}: ${run.ticketOrPr} — ${run.metrics?.outcome ?? run.status}`,
      data: { route: `/run/${run.id}` },
    },
    trigger: null,
  });
}
