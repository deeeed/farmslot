import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, fonts, radii, spacing } from '../lib/theme';
import { useFilterStore } from '../store/filters';

import { FormSheetHeader } from './FormSheetHeader';

export function GlobalFiltersScreen() {
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState('');
  const { filters, availableProjects, availableMachines, toggleProject, toggleMachine, clearAll } =
    useFilterStore();
  const normalizedQuery = query.trim().toLowerCase();
  const visibleProjects = useMemo(
    () =>
      normalizedQuery
        ? availableProjects.filter((project) => project.toLowerCase().includes(normalizedQuery))
        : availableProjects,
    [availableProjects, normalizedQuery],
  );
  const visibleMachines = useMemo(
    () =>
      normalizedQuery
        ? availableMachines.filter((machine) => machine.toLowerCase().includes(normalizedQuery))
        : availableMachines,
    [availableMachines, normalizedQuery],
  );
  const hasFilters = filters.projects.length > 0 || filters.machines.length > 0;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xl }]}
      keyboardShouldPersistTaps="handled"
    >
      <FormSheetHeader title="Workspace filters" />
      <View style={styles.searchRow}>
        <TextInput
          testID="companion-filter-search"
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={setQuery}
          placeholder="Search projects or machines"
          placeholderTextColor={colors.textMuted}
          style={styles.searchInput}
          value={query}
        />
        {hasFilters ? (
          <Pressable style={styles.clearButton} onPress={clearAll}>
            <Text style={styles.clearText}>Clear</Text>
          </Pressable>
        ) : null}
      </View>
      <FilterSection
        title="Projects"
        selectedCount={filters.projects.length}
        totalCount={availableProjects.length}
      >
        {visibleProjects.map((project) => (
          <FilterOptionRow
            key={project}
            active={filters.projects.includes(project)}
            label={project}
            onPress={() => toggleProject(project)}
          />
        ))}
        {availableProjects.length > 0 && visibleProjects.length === 0 ? (
          <Text style={styles.emptyText}>No project matches “{query.trim()}”.</Text>
        ) : null}
      </FilterSection>
      <FilterSection
        title="Machines"
        selectedCount={filters.machines.length}
        totalCount={availableMachines.length}
      >
        {visibleMachines.map((machine) => (
          <FilterOptionRow
            key={machine}
            active={filters.machines.includes(machine)}
            label={machine}
            onPress={() => toggleMachine(machine)}
          />
        ))}
        {availableMachines.length > 0 && visibleMachines.length === 0 ? (
          <Text style={styles.emptyText}>No machine matches “{query.trim()}”.</Text>
        ) : null}
      </FilterSection>
    </ScrollView>
  );
}

function FilterSection({
  title,
  selectedCount,
  totalCount,
  children,
}: {
  title: string;
  selectedCount: number;
  totalCount: number;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>{title}</Text>
        <Text style={styles.sectionCount}>
          {selectedCount}/{totalCount}
        </Text>
      </View>
      <View style={styles.options}>{children}</View>
    </View>
  );
}

function FilterOptionRow({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable style={[styles.option, active && styles.optionActive]} onPress={onPress}>
      <View style={[styles.check, active && styles.checkActive]}>
        <Text style={[styles.checkText, active && styles.checkTextActive]}>
          {active ? '✓' : ''}
        </Text>
      </View>
      <Text style={[styles.optionText, active && styles.optionTextActive]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { backgroundColor: colors.bgBase, flex: 1 },
  content: { gap: spacing.lg, padding: spacing.lg },
  searchRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm },
  searchInput: {
    backgroundColor: colors.bgInput,
    borderColor: colors.bgCardHover,
    borderRadius: radii.md,
    borderWidth: 1,
    color: colors.textPrimary,
    flex: 1,
    fontSize: fonts.sizeMd,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  clearButton: { paddingHorizontal: spacing.sm, paddingVertical: spacing.sm },
  clearText: { color: colors.statusWarn, fontSize: fonts.sizeXs, fontWeight: '900' },
  section: {
    backgroundColor: colors.bgCard,
    borderColor: colors.bgCardHover,
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.md,
    padding: spacing.md,
  },
  sectionHeader: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  sectionTitle: {
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  sectionCount: { color: colors.textMuted, fontSize: fonts.sizeXs, fontWeight: '900' },
  options: { gap: spacing.sm },
  option: {
    alignItems: 'center',
    backgroundColor: colors.bgInput,
    borderColor: colors.bgInput,
    borderRadius: radii.md,
    borderWidth: 1,
    flexDirection: 'row',
    gap: spacing.md,
    minHeight: 44,
    paddingHorizontal: spacing.md,
  },
  optionActive: { backgroundColor: colors.accent + '14', borderColor: colors.accent + '66' },
  check: {
    alignItems: 'center',
    borderColor: colors.textMuted,
    borderRadius: 6,
    borderWidth: 1,
    height: 20,
    justifyContent: 'center',
    width: 20,
  },
  checkActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  checkText: { color: colors.textMuted, fontSize: fonts.sizeXs, fontWeight: '900' },
  checkTextActive: { color: colors.bgBase },
  optionText: { color: colors.textSecondary, flex: 1, fontSize: fonts.sizeSm },
  optionTextActive: { color: colors.textPrimary, fontWeight: '800' },
  emptyText: { color: colors.textMuted, fontSize: fonts.sizeSm, paddingVertical: spacing.md },
});
