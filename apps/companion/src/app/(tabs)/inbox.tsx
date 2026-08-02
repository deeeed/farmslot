import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import React, { useCallback, useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { PendingDecision } from '@farmslot/protocol';
import { KIND_COLORS } from '@farmslot/theme';

import { FilterEmptyState } from '../../components/FilterEmptyState';
import { RunWorkspaceNav } from '../../components/RunWorkspaceNav';
import {
  DECISION_EVIDENCE_RECIPE_RUN_PARAM,
  groupVisualArtifactPairs,
} from '../../lib/artifact-url';
import { formatDiffStat, presentDecision } from '../../lib/decision-presentation';
import { diffArtifactCandidate } from '../../lib/diff';
import { decisionDisplayTitle } from '../../lib/run-display';
import { baseStyles, colors, fonts, radii, spacing } from '../../lib/theme';
import { decisionWorkspaceNavMeta } from '../../lib/workspace-nav-meta';
import { decisionWorkspaceRouteParams } from '../../lib/workspace-navigation';
import { useConnectionStore } from '../../store/connection';
import { useDecisionStore } from '../../store/decisions';
import { filterDecisions, useFilterStore } from '../../store/filters';
import { useFleetStore } from '../../store/fleet';

function DecisionCard({ decision }: { decision: PendingDecision }) {
  const router = useRouter();
  const presentation = presentDecision(decision);
  const toneColor = TONE_COLORS[presentation.tone];
  const diff = formatDiffStat(presentation.diffStat);
  const workspaceTarget =
    presentation.kind === 'retrospective'
      ? 'retro'
      : presentation.kind === 'ready'
        ? 'ready'
        : 'review';
  const workspaceOpenLabel =
    workspaceTarget === 'retro'
      ? 'Open retrospective workspace'
      : workspaceTarget === 'ready'
        ? 'Open ready workspace'
        : 'Open review workspace';
  const diffArtifactPath = diffArtifactCandidate(presentation.artifactManifest)?.path ?? null;
  const visualPairs = groupVisualArtifactPairs(
    presentation.artifactManifest,
    (artifact) => artifact.path,
  ).pairs;
  const displayTitle = decisionDisplayTitle(decision);
  const decisionMeta = decisionWorkspaceNavMeta({
    statusLabel: 'pending',
    artifactCount: presentation.artifactManifest.length,
    diffValue: diff,
    visualPairCount: visualPairs.length,
  });

  const openReviewWorkspace = useCallback(() => {
    router.push({
      pathname: '/decision/[id]',
      params: {
        id: decision.id,
        ...decisionWorkspaceRouteParams(presentation.kind),
        ...(presentation.runId ? { runId: presentation.runId } : {}),
      },
    });
  }, [decision.id, presentation.runId, router]);

  return (
    <View style={[styles.decisionCard, { borderLeftColor: toneColor }]}>
      <View style={styles.cardHeader}>
        <View
          style={[
            styles.kindBadge,
            {
              backgroundColor: (KIND_COLORS[presentation.kind] ?? toneColor) + '25',
            },
          ]}
        >
          <Text style={[styles.kindText, { color: KIND_COLORS[presentation.kind] ?? toneColor }]}>
            {presentation.kindLabel}
          </Text>
        </View>
        <Text style={styles.timeText}>{new Date(decision.createdAt).toLocaleTimeString()}</Text>
      </View>
      <Text style={styles.decisionTitle}>{displayTitle.title}</Text>
      {displayTitle.subtitle ? (
        <Text style={styles.decisionSubtitle} numberOfLines={1}>
          {displayTitle.subtitle}
        </Text>
      ) : null}
      <Text style={baseStyles.textSecondary} numberOfLines={3}>
        {presentation.summary || decision.description}
      </Text>
      <View style={styles.metaRow}>
        <Text style={baseStyles.textMuted} numberOfLines={1}>
          {presentation.ticketOrPr ?? presentation.runId ?? 'Standalone decision'}
        </Text>
        {presentation.slotId && <Text style={baseStyles.textMuted}>{presentation.slotId}</Text>}
      </View>
      <View style={styles.signalRow}>
        {presentation.highlights.slice(0, 3).map((item) => (
          <View key={`${item.label}-${item.value}`} style={styles.signalChip}>
            <Text style={styles.signalText}>
              {item.label}: {item.value}
            </Text>
          </View>
        ))}
        {diff && (
          <View style={styles.signalChip}>
            <Text style={styles.signalText}>{diff}</Text>
          </View>
        )}
      </View>
      <View style={styles.actionsRow}>
        {presentation.actions.map((action) => (
          <View key={action.id} style={styles.actionChip}>
            <Text style={styles.actionText}>Action: {action.label}</Text>
          </View>
        ))}
      </View>
      <Pressable style={styles.primaryWorkspaceButton} onPress={openReviewWorkspace}>
        <Text style={styles.primaryWorkspaceText}>{workspaceOpenLabel}</Text>
      </Pressable>
      <View style={styles.workspaceShortcutBlock}>
        <Text style={styles.workspaceShortcutTitle}>Workspace shortcuts</Text>
        <RunWorkspaceNav
          dense
          current={workspaceTarget}
          decisionId={decision.id}
          decisionKind={presentation.kind}
          readyDecisionId={workspaceTarget === 'ready' ? decision.id : null}
          reviewDecisionId={workspaceTarget === 'review' ? decision.id : null}
          retroDecisionId={workspaceTarget === 'retro' ? decision.id : null}
          readyMeta={workspaceTarget === 'ready' ? decisionMeta : null}
          reviewMeta={workspaceTarget === 'review' ? decisionMeta : null}
          retroMeta={workspaceTarget === 'retro' ? decisionMeta : null}
          familyId={presentation.familyId}
          project={presentation.project}
          prNumber={presentation.prNumber}
          prRepo={presentation.repo}
          recipeRunId={presentation.runId ? DECISION_EVIDENCE_RECIPE_RUN_PARAM : null}
          artifactPath={diffArtifactPath}
          slotId={presentation.terminalSlotId ?? presentation.slotId}
          runId={presentation.runId}
          diffAvailable={Boolean(diffArtifactPath || diff)}
          artifactCount={presentation.artifactManifest.length}
          visualPairCount={visualPairs.length}
          compareArtifactPath={visualPairs[0]?.after.path ?? null}
        />
      </View>
    </View>
  );
}

export default function InboxScreen() {
  const insets = useSafeAreaInsets();
  const decisions = useDecisionStore((s) => s.decisions);
  const status = useConnectionStore((s) => s.status);
  const filters = useFilterStore((s) => s.filters);
  const clearFilters = useFilterStore((s) => s.clearAll);
  const fleet = useFleetStore((s) => s.fleet);
  const hasFilters = filters.projects.length > 0 || filters.machines.length > 0;

  const filteredDecisions = useMemo(() => {
    const slotById = new Map(
      (fleet?.slots ?? []).map(
        (slot) => [slot.slot, { project: slot.project, machine: slot.machine }] as const,
      ),
    );
    return filterDecisions(decisions, filters, slotById);
  }, [decisions, filters, fleet]);

  const renderDecision = useCallback(
    ({ item }: { item: PendingDecision }) => <DecisionCard decision={item} />,
    [],
  );

  return (
    <View testID="companion-screen-inbox" collapsable={false} style={baseStyles.container}>
      {filteredDecisions.length === 0 ? (
        status === 'connected' && hasFilters ? (
          <FilterEmptyState
            message="No pending decisions match the active filters."
            onClear={clearFilters}
            style={{ flex: 1, paddingBottom: insets.bottom }}
          />
        ) : (
          <View style={[styles.emptyContainer, { paddingBottom: insets.bottom }]}>
            <Text style={baseStyles.textSecondary}>
              {status === 'connected'
                ? 'No pending decisions'
                : 'Connect to gateway to see decisions'}
            </Text>
          </View>
        )
      ) : (
        // FlashList v2 self-measures items; the current API has no estimatedItemSize prop.
        <FlashList
          data={filteredDecisions}
          keyExtractor={(d) => d.id}
          renderItem={renderDecision}
          contentContainerStyle={[
            styles.listContent,
            { paddingBottom: styles.listContent.paddingBottom + insets.bottom },
          ]}
          ListFooterComponent={
            <View
              testID="companion-screen-inbox-end"
              accessible
              collapsable={false}
              accessibilityLabel="End of Decision inbox"
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
  emptyContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  listContent: { padding: spacing.lg, paddingBottom: spacing.xxxl },
  decisionCard: {
    backgroundColor: colors.bgCard,
    borderRadius: radii.md,
    padding: spacing.xl,
    marginBottom: spacing.md,
    borderLeftWidth: 3,
    borderLeftColor: colors.statusWarn,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  kindBadge: {
    borderRadius: 4,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  kindText: {
    fontSize: fonts.sizeXs,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  timeText: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
  },
  runSummaryTitle: {
    color: colors.textPrimary,
    fontSize: fonts.sizeLg,
    fontWeight: '900',
    marginBottom: spacing.sm,
  },
  decisionTitle: {
    color: colors.textSecondary,
    fontSize: fonts.sizeSm,
    fontWeight: '700',
    marginBottom: spacing.xs,
  },
  decisionSubtitle: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '700',
    marginBottom: spacing.sm,
  },
  metaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing.md,
    marginTop: spacing.sm,
  },
  signalRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.lg,
  },
  signalChip: {
    backgroundColor: colors.bgInput,
    borderRadius: 4,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  signalText: {
    color: colors.textSecondary,
    fontSize: fonts.sizeXs,
    fontWeight: '600',
  },
  actionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
    marginTop: spacing.lg,
  },
  actionChip: {
    backgroundColor: colors.bgInput,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: 999,
  },
  actionText: {
    color: colors.textSecondary,
    fontSize: fonts.sizeXs,
    fontWeight: '700',
  },
  primaryWorkspaceButton: {
    alignItems: 'center',
    backgroundColor: colors.accent,
    borderRadius: radii.md,
    marginTop: spacing.lg,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  primaryWorkspaceText: {
    color: '#fff',
    fontSize: fonts.sizeSm,
    fontWeight: '900',
  },
  workspaceShortcutBlock: {
    backgroundColor: colors.accent + '10',
    borderColor: colors.accent + '33',
    borderRadius: radii.md,
    borderWidth: 1,
    marginTop: spacing.md,
    padding: spacing.md,
  },
  workspaceShortcutTitle: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    marginBottom: spacing.sm,
    textTransform: 'uppercase',
  },
});

const TONE_COLORS = {
  ok: colors.statusOk,
  warn: colors.statusWarn,
  fail: colors.statusFail,
  info: colors.accent,
} as const;
