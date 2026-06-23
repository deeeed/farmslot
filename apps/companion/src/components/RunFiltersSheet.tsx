import React from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { FLOW_COLORS, FLOW_LABELS } from '@farmslot/theme';

import { colors, fonts, radii, spacing } from '../lib/theme';
import {
  type FlowFilter,
  type LaneFilter,
  type SortOption,
  useRunFilterStore,
} from '../store/run-filters';

const FLOW_OPTIONS: { label: string; value: FlowFilter; color: string }[] = [
  { label: 'All', value: '', color: colors.textMuted },
  ...(['fix-bug', 'review-pr', 'dev', 'pr-complete', 'merge-main'] as const).map((flow) => ({
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

export function RunFiltersSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const { filters, setFlow, setLane, setSort, setSearch, setTag, clearAll, activeCount } =
    useRunFilterStore();
  const count = activeCount();

  return (
    <Modal animationType="slide" transparent visible={open} onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={[styles.sheet, { paddingBottom: spacing.lg + insets.bottom }]}>
          <View style={styles.handle} />
          <View style={styles.header}>
            <View style={styles.titleBlock}>
              <Text style={styles.title}>Run filters</Text>
              <Text style={styles.subtitle}>
                Filter and sort runs. Flow, lane, and sort are persistent.
              </Text>
            </View>
            <View style={styles.headerActions}>
              {count > 0 ? (
                <Pressable style={styles.clearBtn} onPress={clearAll}>
                  <Text style={styles.clearText}>Clear</Text>
                </Pressable>
              ) : null}
              <Pressable style={styles.doneBtn} onPress={onClose}>
                <Text style={styles.doneText}>Done</Text>
              </Pressable>
            </View>
          </View>

          <ScrollView contentContainerStyle={styles.content}>
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
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    backgroundColor: '#00000099',
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: colors.bgSurface,
    borderColor: colors.bgCardHover,
    borderTopLeftRadius: radii.lg,
    borderTopRightRadius: radii.lg,
    borderWidth: 1,
    maxHeight: '80%',
    padding: spacing.lg,
  },
  handle: {
    alignSelf: 'center',
    backgroundColor: colors.bgCardHover,
    borderRadius: 999,
    height: 4,
    marginBottom: spacing.lg,
    width: 44,
  },
  header: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: spacing.md,
    justifyContent: 'space-between',
  },
  titleBlock: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    color: colors.textPrimary,
    fontSize: fonts.sizeLg,
    fontWeight: '900',
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    lineHeight: 17,
    marginTop: spacing.xs,
  },
  headerActions: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
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
  doneBtn: {
    backgroundColor: colors.accent + '22',
    borderColor: colors.accent + '66',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  doneText: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  content: {
    gap: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xl,
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
