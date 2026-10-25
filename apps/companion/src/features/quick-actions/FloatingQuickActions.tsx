import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Modal, Platform, Pressable, Share, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  type CompanionViewLocation,
  resolveSharedViewLink,
} from '@farmslot/protocol/surfaces/view-links';

import { colors } from '../../lib/theme';
import { buildWorkspaceCopilotDraftForRoute } from '../../lib/workspace-copilot';
import { useConnectionStore } from '../../store/connection';
import { useFilterStore } from '../../store/filters';
import { useRunFilterStore } from '../../store/run-filters';

import { quickActionsStyles as styles } from './quick-actions.styles';
import { useQuickActions } from './QuickActionsProvider';
import { useFloatingActionPosition } from './use-floating-action-position';

export function FloatingQuickActions({
  selection,
  beforeVoice,
}: {
  selection?: CompanionViewLocation;
  beforeVoice?: () => void;
}) {
  const actions = useQuickActions();
  const { pathname, params } = actions.currentRoute;
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const composerHeight =
    actions.composerInset?.scope === actions.scope &&
    actions.composerInset.routeKey === actions.routeKey
      ? actions.composerInset.height
      : 0;
  const position = useFloatingActionPosition(pathname, composerHeight);
  const profileId = useConnectionStore((state) => state.activeProfileId);
  const profiles = useConnectionStore((state) => state.profiles);
  const access = useConnectionStore((state) => state.workspaceAccess);
  const filters = useFilterStore((state) => state.filters);
  const runFilters = useRunFilterStore((state) => state.filters);
  const base = profiles.find((profile) => profile.id === profileId)?.commandCenterUrl;
  const [open, setOpen] = useState(false);
  const [feedback, setFeedback] = useState('');
  const longPressed = useRef(false);
  const identity = JSON.stringify([
    pathname,
    params,
    filters,
    runFilters,
    actions.scope,
    actions.viewSelection?.location,
    selection,
    base,
  ]);
  const currentView =
    actions.viewSelection?.scope === actions.scope && actions.viewSelection.ownerPath === pathname
      ? actions.viewSelection.location
      : { pathname, params };
  const source = selection ?? currentView;
  const voiceSource = selection?.pathname === '/unmapped-overlay' ? currentView : source;
  const selected = useMemo(
    () => ({ ...source, projects: filters.projects, machines: filters.machines, runFilters }),
    [source, filters, runFilters],
  );
  const link = useMemo(
    () => resolveSharedViewLink({ companion: selected }, base),
    [selected, base],
  );
  useEffect(() => {
    setOpen(false);
    setFeedback('');
  }, [identity]);
  const voice = useCallback(() => {
    setOpen(false);
    beforeVoice?.();
    const target = actions.voiceTarget;
    if (target?.scope === actions.scope && target.routeKey === actions.routeKey) {
      target.invoke();
      return;
    }
    if (/terminal/.test(pathname)) {
      Alert.alert('Voice unavailable', 'Open a connected terminal to use voice.');
      return;
    }
    const context = buildWorkspaceCopilotDraftForRoute(voiceSource.pathname, voiceSource.params);
    if (access === 'native') {
      Alert.alert(
        'Voice unavailable',
        `Co-Pilot voice requires a farm gateway.\n\nPending instruction\n${context}`,
      );
      return;
    }
    actions.beginCopilotVoice(context);
  }, [access, actions, beforeVoice, pathname, voiceSource]);
  const copy = async () => {
    if (link.status !== 'available') return;
    try {
      await Clipboard.setStringAsync(link.url);
      setFeedback('Link copied');
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Unable to copy this link.');
    }
  };
  const share = async () => {
    if (link.status !== 'available') return;
    try {
      await Share.share(Platform.OS === 'ios' ? { url: link.url } : { message: link.url });
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Unable to share this link.');
    }
  };
  const available = link.status === 'available';
  return (
    <>
      <View
        {...position.panHandlers}
        pointerEvents={open ? 'none' : 'auto'}
        accessibilityElementsHidden={open}
        importantForAccessibility={open ? 'no-hide-descendants' : 'auto'}
        style={[styles.floating, position.style, open && { opacity: 0 }]}
      >
        <Pressable
          testID="companion-quick-actions"
          accessibilityRole="button"
          accessibilityLabel="Quick actions"
          accessibilityHint="Copy link, share, or use voice. Hold for voice."
          accessibilityActions={[
            { name: 'activate', label: 'Open quick actions' },
            { name: 'longpress', label: 'Voice' },
          ]}
          onAccessibilityAction={(event) =>
            event.nativeEvent.actionName === 'longpress' ? voice() : setOpen(true)
          }
          onPressIn={() => {
            longPressed.current = false;
          }}
          onPress={() => {
            if (!longPressed.current) {
              setFeedback('');
              setOpen(true);
            }
          }}
          onLongPress={() => {
            longPressed.current = true;
            voice();
          }}
          disabled={actions.handoffPending || !pathname}
          style={styles.button}
        >
          <Ionicons name="ellipsis-horizontal" size={24} color={colors.bgBase} />
        </Pressable>
      </View>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable
          style={styles.backdrop}
          onPress={() => setOpen(false)}
          accessibilityLabel="Close quick actions"
        >
          <Pressable
            style={[styles.menu, { paddingBottom: Math.max(20, insets.bottom) }]}
            onPress={() => undefined}
          >
            <Text style={styles.title}>Quick actions</Text>
            <Pressable
              testID="companion-copy-view-link"
              accessibilityRole="button"
              accessibilityState={{ disabled: !available }}
              disabled={!available}
              onPress={() => void copy()}
              style={[styles.row, !available && styles.disabled]}
            >
              <Ionicons name="copy-outline" size={22} color={colors.textPrimary} />
              <Text style={styles.label}>Copy link</Text>
            </Pressable>
            <Pressable
              testID="companion-share-view-link"
              accessibilityRole="button"
              accessibilityState={{ disabled: !available }}
              disabled={!available}
              onPress={() => void share()}
              style={[styles.row, !available && styles.disabled]}
            >
              <Ionicons name="share-outline" size={22} color={colors.textPrimary} />
              <Text style={styles.label}>Share</Text>
            </Pressable>
            <Pressable
              testID="companion-quick-voice"
              accessibilityRole="button"
              onPress={voice}
              style={styles.row}
            >
              <Ionicons name="mic-outline" size={22} color={colors.textPrimary} />
              <Text style={styles.label}>Voice</Text>
            </Pressable>
            {link.status === 'unavailable' ? (
              <Text testID="companion-share-unavailable" style={styles.reason}>
                {link.message}
              </Text>
            ) : null}
            {link.status === 'unavailable' &&
            (link.reason === 'web-url-unset' || link.reason === 'invalid-web-url') ? (
              <Pressable
                testID="companion-share-settings"
                accessibilityRole="button"
                style={styles.row}
                onPress={() => {
                  setOpen(false);
                  router.push('/settings');
                }}
              >
                <Text style={styles.label}>Set Command Center URL</Text>
              </Pressable>
            ) : null}
            {feedback ? (
              <Text
                testID="companion-share-feedback"
                accessibilityLiveRegion="polite"
                style={styles.feedback}
              >
                {feedback}
              </Text>
            ) : null}
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}
