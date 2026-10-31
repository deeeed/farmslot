import React, { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { type ResourceQueryState } from '@farmslot/protocol/client-cache';

import {
  type LabelledReadObservation,
  resourceReadMessages,
  savedForDisplay,
  visibleReadError,
} from '../lib/resource-read-status';
import { baseStyles, colors, spacing } from '../lib/theme';
import { useHeldConnection } from '../store/held-connection';

type ResourceReadStatusProps = {
  /** A persistent condition of the view itself, shown in the same fixed slot. */
  notice?: string | null;
  onRetry?: () => void;
  retryDisabled?: boolean;
  retryLabel?: string;
} & (
  | { observation: ResourceQueryState; label: string; observations?: never }
  | { observations: readonly LabelledReadObservation[]; observation?: never; label?: never }
);

/** One fixed status slot. Full messages open out of flow; commands remain with their owner. */
export function ResourceReadStatus({
  observation,
  label,
  observations,
  notice = null,
  onRetry,
  retryDisabled = false,
  retryLabel,
}: ResourceReadStatusProps) {
  const [now, setNow] = useState(Date.now());
  const [details, setDetails] = useState(false);
  const connected = useHeldConnection();
  const reads = observations ?? (observation && label ? [{ observation, label }] : []);
  const stale = reads.some((read) => read.observation.status === 'stale' && read.observation.data);
  useEffect(() => {
    if (!stale) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [stale]);
  const messages = [...resourceReadMessages(reads, now, connected), ...(notice ? [notice] : [])];
  const text = messages.join(' · ');
  useEffect(() => {
    if (!text) setDetails(false);
  }, [text]);
  return (
    <View style={styles.slot} testID="resource-read-status-slot">
      {text ? (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={text}
            onPress={() => setDetails(true)}
            style={styles.message}
          >
            <Text style={baseStyles.textSecondary} numberOfLines={1}>
              {text}
            </Text>
          </Pressable>
          {onRetry &&
          connected &&
          reads.some((read) =>
            visibleReadError(read.observation, savedForDisplay(read.observation, connected, now)),
          ) ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={retryLabel ?? `Retry reading ${label ?? 'this view'}`}
              disabled={retryDisabled}
              onPress={onRetry}
              style={styles.retry}
            >
              <Text style={[baseStyles.textSecondary, { color: colors.accent }]}>Retry</Text>
            </Pressable>
          ) : null}
        </>
      ) : null}
      <Modal
        visible={details && Boolean(text)}
        transparent
        animationType="none"
        onRequestClose={() => setDetails(false)}
      >
        <View style={styles.backdrop}>
          <View style={styles.details}>
            <ScrollView>
              {messages.map((message, index) => (
                <Text key={index} style={[baseStyles.textSecondary, styles.detailText]}>
                  {message}
                </Text>
              ))}
            </ScrollView>
            <Pressable
              accessibilityRole="button"
              onPress={() => setDetails(false)}
              style={styles.retry}
            >
              <Text style={baseStyles.textPrimary}>Close</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}
const styles = StyleSheet.create({
  slot: {
    height: 44,
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
  },
  message: { flex: 1, minWidth: 0, minHeight: 44, justifyContent: 'center' },
  retry: { minHeight: 44, justifyContent: 'center', paddingHorizontal: spacing.md },
  backdrop: { flex: 1, justifyContent: 'center', backgroundColor: '#0009', padding: spacing.lg },
  details: {
    maxHeight: '70%',
    backgroundColor: colors.bgCard,
    borderRadius: 8,
    padding: spacing.md,
  },
  detailText: { marginBottom: spacing.md },
});
