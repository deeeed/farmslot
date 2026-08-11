import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { FLOW_COLORS, FLOW_LABELS } from '@farmslot/theme';

import { colors, fonts, radii, spacing } from '../lib/theme';
import {
  type FlowFilter,
  type LaneFilter,
  type SortOption,
  useRunFilterStore,
} from '../store/run-filters';

import { FormSheetHeader } from './FormSheetHeader';

const FLOW_OPTIONS: { label: string; value: FlowFilter; color: string }[] = [
  { label: 'All', value: '', color: colors.textMuted },
  ...(['fix-bug', 'review-pr', 'dev', 'pr-complete', 'update-branch'] as const).map((flow) => ({
    label: FLOW_LABELS[flow] ?? flow,
    value: flow as FlowFilter,
    color: FLOW_COLORS[flow] ?? colors.textMuted,
  })),
];

const LANE_OPTIONS: { label: string; value: LaneFilter; color: string }[] = [
  { label: 'All', value: '', color: colors.textMuted },
  { label: 'Production', value: 'production', color: colors.statusOk },
  { label: 'Validation', value: 'validation', color: '#06b6d4' },
  { label: 'Comparison', value: 'comparison', color: '#f59e0b' },
];

const SORT_OPTIONS: { label: string; value: SortOption }[] = [
  { label: 'Newest', value: 'newest' },
  { label: 'Oldest', value: 'oldest' },
  { label: 'Duration', value: 'duration' },
];

function ChipRow<T extends string>({
  options,
  selected,
  onSelect,
}: {
  options: { label: string; value: T; color?: string }[];
  selected: T;
  onSelect: (value: T) => void;
}) {
  return (
    <View style={styles.chipRow}>
      {options.map((opt) => {
        const active = selected === opt.value;
        const accentColor = opt.color ?? colors.textMuted;
        return (
          <Pressable
            key={opt.value}
            style={[
              styles.chip,
              active
                ? { backgroundColor: accentColor + '30', borderColor: accentColor }
                : { backgroundColor: colors.bgInput, borderColor: colors.bgCardHover },
            ]}
            onPress={() => onSelect(opt.value)}
          >
            <Text style={[styles.chipText, { color: active ? accentColor : colors.textSecondary }]}>
              {opt.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function RunFiltersScreen() {
  const insets = useSafeAreaInsets();
  const { filters, setFlow, setLane, setSort, setSearch, setTag, clearAll, activeCount } =
    useRunFilterStore();
  const count = activeCount();

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={[styles.content, { paddingBottom: spacing.xl + insets.bottom }]}
      keyboardShouldPersistTaps="handled"
    >
      <FormSheetHeader title="Run filters" />
      <View style={styles.introRow}>
        <Text style={styles.subtitle}>
          Search, refine, and sort the globally filtered run list.
        </Text>
        {count > 0 ? (
          <Pressable style={styles.clearBtn} onPress={clearAll}>
            <Text style={styles.clearText}>Clear</Text>
          </Pressable>
        ) : null}
      </View>
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Search</Text>
        <TextInput
          style={styles.searchInput}
          value={filters.search}
          onChangeText={setSearch}
          placeholder="Ticket, PR, summary, or tag..."
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Tag</Text>
        <TextInput
          style={styles.searchInput}
          value={filters.tag}
          onChangeText={setTag}
          placeholder="demo, launch, regression..."
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Flow type</Text>
        <ChipRow options={FLOW_OPTIONS} selected={filters.flow} onSelect={setFlow} />
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Lane</Text>
        <ChipRow options={LANE_OPTIONS} selected={filters.lane} onSelect={setLane} />
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Sort</Text>
        <ChipRow
          options={SORT_OPTIONS.map((o) => ({ ...o, color: colors.accent }))}
          selected={filters.sort}
          onSelect={setSort}
        />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { backgroundColor: colors.bgBase, flex: 1 },
  introRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.md },
  subtitle: {
    color: colors.textMuted,
    flex: 1,
    fontSize: fonts.sizeXs,
    lineHeight: 17,
  },
  clearBtn: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
  },
  clearText: {
    color: colors.statusWarn,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  content: {
    gap: spacing.lg,
    padding: spacing.lg,
  },
  section: {
    gap: spacing.sm,
  },
  sectionTitle: {
    color: colors.textSecondary,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  searchInput: {
    backgroundColor: colors.bgInput,
    borderColor: colors.bgCardHover,
    borderRadius: radii.md,
    borderWidth: 1,
    color: colors.textPrimary,
    fontSize: fonts.sizeMd,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  chip: {
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  chipText: {
    fontSize: fonts.sizeXs,
    fontWeight: '800',
  },
});
