import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import React, { useCallback, useMemo } from 'react';
import { type GestureResponderEvent, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { Run, SlotStatus } from '@farmslot/protocol';

import { FilterEmptyState } from '../../components/FilterEmptyState';
import { DECISION_EVIDENCE_RECIPE_RUN_PARAM } from '../../lib/artifact-url';
import { runDisplayTitle } from '../../lib/run-display';
import { baseStyles, colors, fonts, lifecycleColor, spacing } from '../../lib/theme';
import { useConnectionStore } from '../../store/connection';
import { filterSlots, useFilterStore } from '../../store/filters';
import { useFleetStore } from '../../store/fleet';
import { useRunStore } from '../../store/runs';

function SlotCard({
  slot,
  contextRun,
  contextRunId,
}: {
  slot: SlotStatus;
  contextRun: Run | null;
  contextRunId: string | null;
}) {
  const router = useRouter();
  const openTerminal = (event: GestureResponderEvent) => {
    event.stopPropagation();
    router.push({
      pathname: '/terminal/[slotId]',
      params: {
        slotId: slot.slot,
        details: '1',
        ...(contextRunId
          ? {
              runId: contextRunId,
              recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
            }
          : {}),
      },
    });
  };
  const showTerminalAction = Boolean(contextRunId || slot.lifecycle === 'busy');
  const displayTitle = contextRun
    ? runDisplayTitle(contextRun)
    : { title: slot.currentTicketOrPr ?? slot.branch, subtitle: slot.branch };
  return (
    <Pressable
      style={styles.slotCard}
      onPress={() =>
        router.push({
          pathname: '/slot/[id]',
          params: {
            id: slot.slot,
            ...(contextRunId
              ? {
                  runId: contextRunId,
                  recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                }
              : {}),
          },
        })
      }
    >
      <View style={styles.slotHeader}>
        <View style={{ flex: 1 }}>
          <Text style={styles.slotId}>{slot.slot}</Text>
          {displayTitle.title && displayTitle.title !== slot.slot ? (
            <Text style={baseStyles.textSecondary} numberOfLines={1}>
              {displayTitle.title}
            </Text>
          ) : null}
          {displayTitle.subtitle && displayTitle.subtitle !== displayTitle.title ? (
            <Text style={styles.slotSubtitle} numberOfLines={1}>
              {displayTitle.subtitle}
            </Text>
          ) : null}
        </View>
        <View style={styles.slotRight}>
          {slot.taskPhase && (
            <Text style={styles.taskPhase} numberOfLines={1}>
              {slot.taskPhase}
            </Text>
          )}
          <View
            style={[
              styles.lifecycleBadge,
              { backgroundColor: lifecycleColor(slot.lifecycle) + '30' },
            ]}
          >
            <Text style={[styles.lifecycleText, { color: lifecycleColor(slot.lifecycle) }]}>
              {slot.lifecycle}
            </Text>
          </View>
          {showTerminalAction ? (
            <Pressable style={styles.terminalChip} onPress={openTerminal} hitSlop={8}>
              <Text style={styles.terminalChipText}>Terminal</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
      {slot.taskStepProgress != null && slot.taskStepProgress > 0 && (
        <View style={styles.progressTrack}>
          <View
            style={[styles.progressFill, { width: `${Math.round(slot.taskStepProgress * 100)}%` }]}
          />
        </View>
      )}
    </Pressable>
  );
}

type FleetListItem =
  | { type: 'header'; title: string; count: number }
  | { type: 'slot'; slot: SlotStatus; contextRun: Run | null; contextRunId: string | null };

function latestRunBySlot(runs: Run[]): Map<string, Run> {
  const bySlot = new Map<string, Run>();
  for (const run of runs) {
    if (!run.slotId) continue;
    const existing = bySlot.get(run.slotId);
    if (!existing || runTimestamp(run) > runTimestamp(existing)) bySlot.set(run.slotId, run);
  }
  return bySlot;
}

function runTimestamp(run: Run): number {
  return Date.parse(run.updatedAt || run.completedAt || run.createdAt || '') || 0;
}

export default function FleetScreen() {
  const insets = useSafeAreaInsets();
  const fleet = useFleetStore((s) => s.fleet);
  const runs = useRunStore((s) => s.runs);
  const status = useConnectionStore((s) => s.status);
  const filters = useFilterStore((s) => s.filters);
  const clearFilters = useFilterStore((s) => s.clearAll);
  const hasFilters = filters.projects.length > 0 || filters.machines.length > 0;

  const filteredSlots = useMemo(() => {
    if (!fleet) return [];
    return filterSlots(fleet.slots, filters);
  }, [fleet, filters]);

  const sections = useMemo(() => {
    const grouped = new Map<string, SlotStatus[]>();
    for (const slot of filteredSlots) {
      const machine = slot.machine || 'unknown';
      if (!grouped.has(machine)) grouped.set(machine, []);
      grouped.get(machine)!.push(slot);
    }
    return Array.from(grouped.entries()).map(([title, data]) => ({ title, data }));
  }, [filteredSlots]);

  const runBySlot = useMemo(() => latestRunBySlot(runs), [runs]);
  const runById = useMemo(() => new Map(runs.map((run) => [run.id, run] as const)), [runs]);

  const listItems = useMemo((): FleetListItem[] => {
    return sections.flatMap((section) => [
      { type: 'header' as const, title: section.title, count: section.data.length },
      ...section.data.map((slot) => ({
        type: 'slot' as const,
        slot,
        contextRun: slot.currentRunId
          ? (runById.get(slot.currentRunId) ?? runBySlot.get(slot.slot) ?? null)
          : (runBySlot.get(slot.slot) ?? null),
        contextRunId: slot.currentRunId ?? runBySlot.get(slot.slot)?.id ?? null,
      })),
    ]);
  }, [runById, runBySlot, sections]);

  const stickyHeaderIndices = useMemo(
    () =>
      listItems
        .map((item, index) => (item.type === 'header' ? index : -1))
        .filter((index) => index >= 0),
    [listItems],
  );

  const summaryText = useMemo(() => {
    if (!fleet) return status === 'connected' ? 'Loading fleet...' : 'Not connected';
    // "busy" is the current protocol lifecycle for slots doing active worker work.
    const working = filteredSlots.filter((s) => s.lifecycle === 'busy').length;
    const ready = filteredSlots.filter((s) => s.lifecycle === 'ready').length;
    const suffix = hasFilters ? ` (filtered from ${fleet.slots.length})` : '';
    return `${working} working | ${ready} ready | ${filteredSlots.length} total${suffix}`;
  }, [fleet, filteredSlots, hasFilters, status]);

  const renderItem = useCallback(({ item }: { item: FleetListItem }) => {
    if (item.type === 'header') {
      return (
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>{item.title}</Text>
          <Text style={styles.sectionCount}>{item.count}</Text>
        </View>
      );
    }
    return (
      <SlotCard slot={item.slot} contextRun={item.contextRun} contextRunId={item.contextRunId} />
    );
  }, []);

  return (
    <View testID="companion-screen-fleet" style={baseStyles.container}>
      <View style={styles.summaryBar}>
        <Text style={styles.summaryText}>{summaryText}</Text>
      </View>
      {!fleet ? (
        <View style={[styles.content, { paddingBottom: spacing.lg + insets.bottom }]}>
          <Text style={baseStyles.textSecondary}>
            {status === 'connected'
              ? 'Fetching fleet status...'
              : 'Connect to gateway to see fleet'}
          </Text>
        </View>
      ) : (
        // FlashList v2 self-measures rows; the current API has no estimatedItemSize prop.
        <FlashList
          data={listItems}
          keyExtractor={(item) =>
            item.type === 'header' ? `header:${item.title}` : `slot:${item.slot.slot}`
          }
          renderItem={renderItem}
          stickyHeaderIndices={stickyHeaderIndices}
          contentContainerStyle={[
            styles.listContent,
            { paddingBottom: styles.listContent.paddingBottom + insets.bottom },
          ]}
          ListEmptyComponent={
            hasFilters ? (
              <FilterEmptyState
                message="No slots match the active filters."
                onClear={clearFilters}
              />
            ) : (
              <Text style={baseStyles.textSecondary}>No slots found</Text>
            )
          }
          ListFooterComponent={
            <View
              testID="companion-screen-fleet-end"
              accessible
              accessibilityLabel="End of Fleet"
              style={styles.captureEndMarker}
            />
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  captureEndMarker: { height: 1 },
  summaryBar: {
    backgroundColor: colors.bgSurface,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xl,
    borderBottomWidth: 1,
    borderBottomColor: colors.bgCard,
  },
  summaryText: {
    color: colors.textSecondary,
    fontSize: fonts.sizeSm,
    textAlign: 'center',
  },
  content: {
    flex: 1,
    padding: spacing.lg,
    justifyContent: 'center',
    alignItems: 'center',
  },
  listContent: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xxl,
  },
  sectionHeader: {
    backgroundColor: colors.bgBase,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.sm,
  },
  sectionTitle: {
    color: colors.textSecondary,
    fontSize: fonts.sizeSm,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  sectionCount: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
  },
  slotCard: {
    backgroundColor: colors.bgCard,
    borderRadius: 6,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  slotHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  slotRight: {
    alignItems: 'flex-end',
    gap: spacing.xs,
  },
  slotId: {
    color: colors.textPrimary,
    fontSize: fonts.sizeMd,
    fontWeight: '600',
  },
  slotSubtitle: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    marginTop: 2,
  },
  taskPhase: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
  },
  lifecycleBadge: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: 4,
  },
  lifecycleText: {
    fontSize: fonts.sizeXs,
    fontWeight: '600',
  },
  terminalChip: {
    backgroundColor: colors.accent + '22',
    borderColor: colors.accent + '70',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  terminalChipText: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '800',
  },
  progressTrack: {
    height: 3,
    backgroundColor: colors.bgInput,
    borderRadius: 2,
    marginTop: spacing.md,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: colors.accent,
    borderRadius: 2,
  },
});
