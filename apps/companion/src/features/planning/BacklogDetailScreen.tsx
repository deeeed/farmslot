import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { DocumentViewer } from '../../components/DocumentViewer';
import { baseStyles, colors, fonts, radii, spacing } from '../../lib/theme';

import type { useBacklogDetailController } from './use-backlog-detail-controller';

function value(value: unknown): string {
  if (Array.isArray(value)) return value.join(', ') || '—';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (value == null || value === '') return 'project default';
  return String(value);
}

function specBody(content: string | undefined): string {
  return (
    content?.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim() ||
    'The attached spec could not be loaded.'
  );
}

type BacklogDetailScreenModel = ReturnType<typeof useBacklogDetailController>;

export default function BacklogDetailScreen({ screen }: { screen: BacklogDetailScreenModel }) {
  const { actions, state } = screen;
  const { item } = state;

  if (!item) {
    return (
      <View style={[baseStyles.container, styles.center]}>
        {state.loading ? <ActivityIndicator color={colors.accent} /> : null}
        <Text style={state.error ? styles.error : baseStyles.textSecondary}>
          {state.error ?? 'Loading backlog item…'}
        </Text>
        {state.error ? (
          <Pressable style={styles.secondaryButton} onPress={() => void actions.refresh()}>
            <Text style={styles.secondaryText}>Retry</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }

  const dispatchRows: Array<[string, unknown]> = [
    ['Flow', item.flowType],
    ['Priority', item.priority],
    ['Allowed slots', item.allowedSlots],
    ['Auto-dispatch', item.autoDispatch],
    ['Multi-PR', item.multiPr],
    ['Mode', item.mode],
    ['Runner', item.runner],
    ['Model', item.model],
    ['Effort', item.effort],
    ['Template', item.taskTemplate?.fileName],
    ['App', item.app],
    ['Prepare profile', item.prepareProfile],
    ['Interactive profile', item.devInteractiveProfile],
    ['Review loops', item.pendingReviewPlan?.length ?? 0],
  ];
  const editable =
    (item.status === 'candidate' || item.status === 'ready') &&
    !item.runId &&
    !item.queuedQueueItemId;

  return (
    <ScrollView
      style={baseStyles.container}
      contentContainerStyle={[styles.content, { paddingBottom: state.bottomPadding }]}
    >
      <View style={styles.hero}>
        <View style={styles.badges}>
          <Text style={styles.status}>{item.status}</Text>
          <Text style={styles.project}>{item.project}</Text>
        </View>
        <Text style={styles.ref}>{item.sourceRef || item.id}</Text>
        <Text style={styles.title}>{item.title}</Text>
        {item.notes ? <Text style={styles.notes}>{item.notes}</Text> : null}
        <View style={styles.sourceRow}>
          <Text style={styles.muted}>{item.sourceKind}</Text>
          {item.roadmapItemId ? (
            <Text style={styles.muted}>Roadmap {item.roadmapItemId}</Text>
          ) : null}
        </View>
      </View>

      {state.error ? (
        <View style={styles.errorBanner}>
          <Text style={styles.error}>{state.error}</Text>
          <Pressable onPress={() => void actions.refresh()}>
            <Text style={styles.secondaryText}>Retry</Text>
          </Pressable>
        </View>
      ) : null}

      {item.specPath ? (
        <Pressable style={styles.specCard} onPress={actions.openSpec}>
          <View style={styles.specIcon}>
            <Ionicons name="document-text-outline" size={22} color={colors.accent} />
          </View>
          <View style={styles.specCopy}>
            <Text style={styles.sectionTitle}>Task spec</Text>
            <Text style={styles.specPath} numberOfLines={2}>
              {item.specPath}
            </Text>
            <Text style={styles.muted}>
              {state.spec ? `hash ${state.spec.hash.slice(0, 8)}` : 'Unavailable'}
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={19} color={colors.textMuted} />
        </Pressable>
      ) : (
        <View style={styles.emptySpec}>
          <Text style={styles.sectionTitle}>No task spec attached</Text>
          <Text style={styles.muted}>This item relies on its source and notes only.</Text>
        </View>
      )}

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Dispatch configuration</Text>
        {dispatchRows.map(([label, rowValue]) => (
          <View key={label} style={styles.dataRow}>
            <Text style={styles.dataLabel}>{label}</Text>
            <Text style={styles.dataValue}>{value(rowValue)}</Text>
          </View>
        ))}
        {item.pendingReviewPlan?.map((review) => (
          <View key={review.order} style={styles.reviewRow}>
            <Text style={styles.reviewOrder}>{review.order}</Text>
            <Text style={styles.reviewValue}>
              {review.runner} · {review.model || 'default model'} ·{' '}
              {review.validationDepth || 'static-code'}
            </Text>
          </View>
        ))}
      </View>

      <View style={styles.actions}>
        {editable ? (
          <Pressable style={styles.primaryButton} onPress={() => actions.openEdit(item.id)}>
            <Text style={styles.primaryText}>Edit before dispatch</Text>
          </Pressable>
        ) : null}
        {item.runId ? (
          <Pressable style={styles.primaryButton} onPress={() => actions.openRun(item.runId!)}>
            <Text style={styles.primaryText}>Open active run</Text>
          </Pressable>
        ) : null}
        <Pressable style={styles.secondaryButton} onPress={() => void actions.refresh()}>
          <Text style={styles.secondaryText}>{state.loading ? 'Refreshing…' : 'Refresh'}</Text>
        </Pressable>
      </View>

      <DocumentViewer
        visible={state.specOpen}
        title={item.specPath ?? item.title}
        body={specBody(state.spec?.content)}
        onClose={actions.closeSpec}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', gap: spacing.md, justifyContent: 'center', padding: spacing.xl },
  content: { gap: spacing.lg, padding: spacing.lg },
  hero: {
    backgroundColor: colors.bgSurface,
    borderRadius: radii.lg,
    gap: spacing.md,
    padding: spacing.xl,
  },
  badges: { flexDirection: 'row', gap: spacing.sm },
  status: {
    color: colors.statusWarn,
    fontFamily: fonts.mono,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  project: { color: colors.accent, fontFamily: fonts.mono, fontSize: fonts.sizeXs },
  ref: { color: colors.textSecondary, fontFamily: fonts.mono, fontSize: fonts.sizeXs },
  title: { color: colors.textPrimary, fontSize: fonts.sizeXl, fontWeight: '900', lineHeight: 25 },
  notes: { color: colors.textSecondary, fontSize: fonts.sizeSm, lineHeight: 19 },
  sourceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  muted: { color: colors.textMuted, fontSize: fonts.sizeXs },
  specCard: {
    alignItems: 'center',
    backgroundColor: colors.bgSurface,
    borderColor: colors.accent + '55',
    borderRadius: radii.lg,
    borderWidth: 1,
    flexDirection: 'row',
    gap: spacing.md,
    padding: spacing.lg,
  },
  specIcon: {
    alignItems: 'center',
    backgroundColor: colors.accent + '20',
    borderRadius: 999,
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  specCopy: { flex: 1, gap: spacing.xs },
  specPath: {
    color: colors.textSecondary,
    fontFamily: fonts.mono,
    fontSize: fonts.sizeXs,
    lineHeight: 16,
  },
  emptySpec: {
    backgroundColor: colors.bgSurface,
    borderRadius: radii.lg,
    gap: spacing.sm,
    padding: spacing.lg,
  },
  card: {
    backgroundColor: colors.bgSurface,
    borderRadius: radii.lg,
    gap: spacing.sm,
    padding: spacing.lg,
  },
  sectionTitle: { color: colors.textPrimary, fontSize: fonts.sizeMd, fontWeight: '900' },
  dataRow: {
    borderTopColor: colors.bgCardHover,
    borderTopWidth: 1,
    flexDirection: 'row',
    gap: spacing.md,
    justifyContent: 'space-between',
    paddingTop: spacing.sm,
  },
  dataLabel: { color: colors.textMuted, flex: 1, fontSize: fonts.sizeXs },
  dataValue: { color: colors.textPrimary, flex: 1.6, fontSize: fonts.sizeXs, textAlign: 'right' },
  reviewRow: {
    backgroundColor: colors.bgCard,
    borderRadius: radii.md,
    flexDirection: 'row',
    gap: spacing.md,
    padding: spacing.md,
  },
  reviewOrder: {
    color: colors.accent,
    fontFamily: fonts.mono,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  reviewValue: { color: colors.textSecondary, flex: 1, fontSize: fonts.sizeXs },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  primaryButton: {
    backgroundColor: colors.accent,
    borderRadius: radii.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  primaryText: { color: colors.bgBase, fontSize: fonts.sizeSm, fontWeight: '900' },
  secondaryButton: {
    borderColor: colors.bgCardHover,
    borderRadius: radii.md,
    borderWidth: 1,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  secondaryText: { color: colors.accent, fontSize: fonts.sizeSm, fontWeight: '900' },
  error: { color: colors.statusFail, fontSize: fonts.sizeSm },
  errorBanner: {
    backgroundColor: colors.statusFail + '18',
    borderColor: colors.statusFail + '55',
    borderRadius: radii.md,
    borderWidth: 1,
    gap: spacing.sm,
    padding: spacing.md,
  },
});
