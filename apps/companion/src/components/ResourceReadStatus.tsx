import React, { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { sourceObservationAge } from '@farmslot/protocol';
import type { ResourceQueryState } from '@farmslot/protocol/client-cache';

import { baseStyles, colors, spacing } from '../lib/theme';

export function ResourceReadStatus({
  observation,
  label,
  onRetry,
  retryDisabled = false,
}: {
  observation: ResourceQueryState;
  label: string;
  onRetry?: () => void;
  retryDisabled?: boolean;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (observation.status !== 'stale' || !observation.data) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [observation.status, observation.data]);
  if (observation.status === 'ready' || observation.status === 'loading') return null;
  const observedAt = observation.sourceObservation
    ? observation.sourceObservation.observedAt
    : observation.observedAt;
  return (
    <View style={{ padding: spacing.md }}>
      {observation.status === 'stale' && observedAt !== undefined ? (
        <Text
          accessibilityLabel={`Saved ${label}, ${sourceObservationAge(observedAt, now)}. Actions wait for a current read.`}
          style={[baseStyles.textSecondary, { color: colors.statusWarn }]}
        >
          Saved {label}, {sourceObservationAge(observedAt, now)}. Actions wait for a current read.
        </Text>
      ) : null}
      {observation.status === 'unsupported' ? (
        <Text style={baseStyles.textSecondary}>
          Live {label} updates are unavailable on this gateway.
        </Text>
      ) : null}
      {observation.error ? (
        <>
          <Text accessibilityRole="alert" style={baseStyles.textSecondary}>
            Could not read {label}: {observation.error.message}
          </Text>
          {onRetry ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Retry reading ${label}`}
              disabled={retryDisabled}
              onPress={onRetry}
              style={{ paddingVertical: spacing.sm }}
            >
              <Text style={[baseStyles.textSecondary, { color: colors.accent }]}>Retry</Text>
            </Pressable>
          ) : null}
        </>
      ) : null}
    </View>
  );
}
