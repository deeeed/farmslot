import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { BacklogCreateForm } from '../../components/BacklogCreateForm';
import { baseStyles, colors, radii, spacing } from '../../lib/theme';

import type { BacklogEditState } from './use-backlog-edit-controller';

export function BacklogEditScreen({
  state,
  onSaved,
  onRefresh,
}: {
  state: BacklogEditState;
  onSaved: () => void;
  onRefresh: () => void;
}) {
  if (state.status !== 'ready') {
    return (
      <View style={[baseStyles.container, styles.center]}>
        {state.status === 'loading' ? <ActivityIndicator color={colors.accent} /> : null}
        <Text style={state.status === 'error' ? styles.error : baseStyles.textSecondary}>
          {state.status === 'error' ? state.error : 'Loading backlog parameters…'}
        </Text>
        {state.status === 'error' ? (
          <Pressable style={styles.retry} onPress={onRefresh}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }

  return <BacklogCreateForm item={state.item} onSaved={onSaved} />;
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', gap: spacing.md, justifyContent: 'center', padding: spacing.xl },
  error: { color: colors.statusFail },
  retry: {
    borderColor: colors.accent,
    borderRadius: radii.md,
    borderWidth: 1,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  retryText: { color: colors.accent, fontWeight: '900' },
});
