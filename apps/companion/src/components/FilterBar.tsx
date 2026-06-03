import React, { useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, fonts, radii, spacing } from '../lib/theme';
import { useFilterStore } from '../store/filters';

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
    <Pressable style={[styles.optionRow, active && styles.optionRowActive]} onPress={onPress}>
      <View style={[styles.optionCheck, active && styles.optionCheckActive]}>
        <Text style={[styles.optionCheckText, active && styles.optionCheckTextActive]}>
          {active ? '✓' : ''}
        </Text>
      </View>
      <Text style={[styles.optionText, active && styles.optionTextActive]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

export function FilterBar() {
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState('');
  const {
    filters,
    availableProjects,
    availableMachines,
    editorExpanded,
    toggleProject,
    toggleMachine,
    clearAll,
    setEditorExpanded,
    initialized,
    lastPersistenceError,
  } = useFilterStore();

  const hasFilters = filters.projects.length > 0 || filters.machines.length > 0;
  const filterCount = filters.projects.length + filters.machines.length;
  const hasOptions = availableProjects.length > 0 || availableMachines.length > 0;
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
  const summary = useMemo(() => {
    if (!hasFilters) return 'All projects and machines';
    const selected = [...filters.projects, ...filters.machines];
    const visible = selected.slice(0, 2).join(', ');
    const hiddenCount = Math.max(0, selected.length - 2);
    return hiddenCount > 0 ? `${visible} +${hiddenCount}` : visible;
  }, [filters.machines, filters.projects, hasFilters]);

  if (!initialized && !hasFilters) {
    return null;
  }
  if (!hasFilters && !lastPersistenceError && !hasOptions) {
    return null;
  }

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <View style={styles.summaryBlock}>
          <Text
            style={[styles.activeSummary, hasFilters && styles.activeSummaryOn]}
            numberOfLines={1}
          >
            <Text style={styles.title}>Filters</Text>
            <Text> · {summary}</Text>
          </Text>
        </View>
        <View style={styles.headerActions}>
          {hasFilters && (
            <Pressable style={styles.headerClearButton} onPress={clearAll}>
              <Text style={styles.clearText}>Clear</Text>
            </Pressable>
          )}
          <Pressable
            style={[styles.expandButton, editorExpanded && styles.expandButtonOn]}
            onPress={() => setEditorExpanded(true)}
          >
            <Text style={[styles.expandText, editorExpanded && styles.expandTextOn]}>
              {hasFilters ? `${filterCount} active` : 'Edit'}
            </Text>
          </Pressable>
        </View>
      </View>
      {lastPersistenceError ? <Text style={styles.errorText}>{lastPersistenceError}</Text> : null}
      <Modal
        animationType="slide"
        transparent
        visible={editorExpanded}
        onRequestClose={() => setEditorExpanded(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={[styles.modalSheet, { paddingBottom: spacing.lg + insets.bottom }]}>
            <View style={styles.modalHandle} />
            <View style={styles.modalHeader}>
              <View style={styles.modalTitleBlock}>
                <Text style={styles.modalTitle}>Workspace filters</Text>
                <Text style={styles.modalSubtitle}>
                  Persistent project and machine scope for fleet, runs, PRs, and inbox.
                </Text>
              </View>
              <Pressable style={styles.doneButton} onPress={() => setEditorExpanded(false)}>
                <Text style={styles.doneText}>Done</Text>
              </Pressable>
            </View>
            <TextInput
              style={styles.searchInput}
              value={query}
              onChangeText={setQuery}
              placeholder="Search projects or machines"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <View style={styles.modalSummaryRow}>
              <Text style={styles.modalSummaryText} numberOfLines={1}>
                {summary}
              </Text>
              {hasFilters ? (
                <Pressable style={styles.modalClearButton} onPress={clearAll}>
                  <Text style={styles.modalClearText}>Clear all</Text>
                </Pressable>
              ) : null}
            </View>
            <ScrollView contentContainerStyle={styles.modalScrollContent}>
              {!hasOptions ? (
                <Text style={styles.emptyText}>Waiting for fleet filter options…</Text>
              ) : null}
              <FilterSection
                title="Projects"
                selectedCount={filters.projects.length}
                totalCount={availableProjects.length}
              >
                {visibleProjects.map((project) => (
                  <FilterOptionRow
                    key={`project:${project}`}
                    label={project}
                    active={filters.projects.includes(project)}
                    onPress={() => toggleProject(project)}
                  />
                ))}
                {availableProjects.length > 0 && visibleProjects.length === 0 ? (
                  <Text style={styles.emptyText}>No projects match “{query.trim()}”.</Text>
                ) : null}
              </FilterSection>
              <FilterSection
                title="Machines / nodes"
                selectedCount={filters.machines.length}
                totalCount={availableMachines.length}
              >
                {visibleMachines.map((machine) => (
                  <FilterOptionRow
                    key={`machine:${machine}`}
                    label={machine}
                    active={filters.machines.includes(machine)}
                    onPress={() => toggleMachine(machine)}
                  />
                ))}
                {availableMachines.length > 0 && visibleMachines.length === 0 ? (
                  <Text style={styles.emptyText}>No machines match “{query.trim()}”.</Text>
                ) : null}
              </FilterSection>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
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
    <View style={styles.filterSection}>
      <View style={styles.filterSectionHeader}>
        <Text style={styles.filterSectionTitle}>{title}</Text>
        <Text style={styles.filterSectionCount}>
          {selectedCount}/{totalCount}
        </Text>
      </View>
      <View style={styles.filterSectionBody}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.bgSurface,
    borderBottomWidth: 1,
    borderBottomColor: colors.bgCard,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xs,
  },
  summaryBlock: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    color: colors.textSecondary,
    fontSize: fonts.sizeXs,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  activeSummary: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    lineHeight: 18,
  },
  activeSummaryOn: {
    color: colors.accent,
  },
  headerActions: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    flexShrink: 1,
  },
  headerClearButton: {
    paddingHorizontal: spacing.xs,
    paddingVertical: spacing.xs,
  },
  expandButton: {
    backgroundColor: colors.bgCard,
    borderColor: colors.bgCardHover,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  expandButtonOn: {
    backgroundColor: colors.accent + '22',
    borderColor: colors.accent,
  },
  expandText: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '800',
  },
  expandTextOn: {
    color: colors.accent,
  },
  errorText: {
    color: colors.statusWarn,
    fontSize: fonts.sizeXs,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xs,
  },
  clearText: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '800',
  },
  modalBackdrop: {
    backgroundColor: '#00000099',
    flex: 1,
    justifyContent: 'flex-end',
  },
  modalSheet: {
    backgroundColor: colors.bgSurface,
    borderColor: colors.bgCardHover,
    borderTopLeftRadius: radii.lg,
    borderTopRightRadius: radii.lg,
    borderWidth: 1,
    maxHeight: '88%',
    padding: spacing.lg,
  },
  modalHandle: {
    alignSelf: 'center',
    backgroundColor: colors.bgCardHover,
    borderRadius: 999,
    height: 4,
    marginBottom: spacing.lg,
    width: 44,
  },
  modalHeader: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: spacing.md,
    justifyContent: 'space-between',
  },
  modalTitleBlock: {
    flex: 1,
    minWidth: 0,
  },
  modalTitle: {
    color: colors.textPrimary,
    fontSize: fonts.sizeLg,
    fontWeight: '900',
  },
  modalSubtitle: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    lineHeight: 17,
    marginTop: spacing.xs,
  },
  doneButton: {
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
  searchInput: {
    backgroundColor: colors.bgInput,
    borderColor: colors.bgCardHover,
    borderRadius: radii.md,
    borderWidth: 1,
    color: colors.textPrimary,
    fontSize: fonts.sizeMd,
    marginTop: spacing.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  modalSummaryRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    justifyContent: 'space-between',
    marginTop: spacing.md,
  },
  modalSummaryText: {
    color: colors.textSecondary,
    flex: 1,
    fontSize: fonts.sizeSm,
    fontWeight: '800',
  },
  modalClearButton: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  modalClearText: {
    color: colors.statusWarn,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  modalScrollContent: {
    gap: spacing.lg,
    paddingTop: spacing.lg,
  },
  filterSection: {
    backgroundColor: colors.bgCard,
    borderColor: colors.bgCardHover,
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.md,
    padding: spacing.md,
  },
  filterSectionHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  filterSectionTitle: {
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  filterSectionCount: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  filterSectionBody: {
    gap: spacing.sm,
  },
  optionRow: {
    alignItems: 'center',
    backgroundColor: colors.bgInput,
    borderColor: colors.bgInput,
    borderRadius: radii.md,
    borderWidth: 1,
    flexDirection: 'row',
    gap: spacing.md,
    minHeight: 44,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  optionRowActive: {
    backgroundColor: colors.accent + '20',
    borderColor: colors.accent + '66',
  },
  optionCheck: {
    alignItems: 'center',
    borderColor: colors.textMuted,
    borderRadius: 6,
    borderWidth: 1,
    height: 22,
    justifyContent: 'center',
    width: 22,
  },
  optionCheckActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  optionCheckText: {
    color: colors.bgBase,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  optionCheckTextActive: {
    color: colors.bgBase,
  },
  optionText: {
    color: colors.textSecondary,
    flex: 1,
    fontSize: fonts.sizeSm,
    fontWeight: '800',
  },
  optionTextActive: {
    color: colors.textPrimary,
  },
  emptyText: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    lineHeight: 17,
  },
});
