import { useRouter } from 'expo-router';
import React, { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, fonts, spacing } from '../lib/theme';
import { useFilterStore } from '../store/filters';

export function FilterBar() {
  const router = useRouter();
  const {
    filters,
    availableProjects,
    availableMachines,
    clearAll,
    initialized,
    lastPersistenceError,
  } = useFilterStore();
  const hasFilters = filters.projects.length > 0 || filters.machines.length > 0;
  const filterCount = filters.projects.length + filters.machines.length;
  const hasOptions = availableProjects.length > 0 || availableMachines.length > 0;
  const summary = useMemo(() => {
    if (!hasFilters) return 'All projects and machines';
    const selected = [...filters.projects, ...filters.machines];
    const visible = selected.slice(0, 2).join(', ');
    const hiddenCount = Math.max(0, selected.length - 2);
    return hiddenCount > 0 ? `${visible} +${hiddenCount}` : visible;
  }, [filters.machines, filters.projects, hasFilters]);

  if (!initialized && !hasFilters) return null;
  if (!hasFilters && !lastPersistenceError && !hasOptions) return null;

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <Text style={[styles.summary, hasFilters && styles.summaryActive]} numberOfLines={1}>
          <Text style={styles.title}>Filters</Text>
          <Text> · {summary}</Text>
        </Text>
        <View style={styles.actions}>
          {hasFilters ? (
            <Pressable style={styles.clearButton} onPress={clearAll}>
              <Text style={styles.clearText}>Clear</Text>
            </Pressable>
          ) : null}
          <Pressable style={styles.editButton} onPress={() => router.push('/filters')}>
            <Text style={styles.editText}>{hasFilters ? `${filterCount} active` : 'Edit'}</Text>
          </Pressable>
        </View>
      </View>
      {lastPersistenceError ? <Text style={styles.errorText}>{lastPersistenceError}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.bgSurface,
    borderBottomColor: colors.bgCard,
    borderBottomWidth: 1,
  },
  headerRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xs,
  },
  summary: { color: colors.textMuted, flex: 1, fontSize: fonts.sizeXs, lineHeight: 18 },
  summaryActive: { color: colors.accent },
  title: {
    color: colors.textSecondary,
    fontSize: fonts.sizeXs,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  actions: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm },
  clearButton: { paddingHorizontal: spacing.xs, paddingVertical: spacing.xs },
  clearText: { color: colors.textMuted, fontSize: fonts.sizeXs, fontWeight: '800' },
  editButton: {
    backgroundColor: colors.bgCard,
    borderColor: colors.bgCardHover,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  editText: { color: colors.accent, fontSize: fonts.sizeXs, fontWeight: '800' },
  errorText: {
    color: colors.statusWarn,
    fontSize: fonts.sizeXs,
    paddingBottom: spacing.xs,
    paddingHorizontal: spacing.lg,
  },
});
