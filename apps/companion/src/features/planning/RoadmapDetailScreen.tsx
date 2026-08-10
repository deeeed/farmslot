import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { DocumentViewer } from '../../components/DocumentViewer';
import { baseStyles, colors, fonts, radii, spacing } from '../../lib/theme';

import type { useRoadmapDetailController } from './use-roadmap-detail-controller';

type RoadmapDetailScreenModel = ReturnType<typeof useRoadmapDetailController>;

export default function RoadmapDetailScreen({ screen }: { screen: RoadmapDetailScreenModel }) {
  const { actions, state } = screen;

  if (!state.result) {
    return (
      <View style={[baseStyles.container, styles.center]}>
        {!state.error ? <ActivityIndicator color={colors.accent} /> : null}
        <Text style={state.error ? styles.error : baseStyles.textSecondary}>
          {state.error ?? 'Loading roadmap item…'}
        </Text>
        {state.error ? (
          <Pressable style={styles.retry} onPress={() => void actions.refresh()}>
            <Text style={styles.view}>Retry</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }

  const { item, delivery, planningContext } = state.result;
  return (
    <ScrollView
      style={baseStyles.container}
      contentContainerStyle={[styles.content, { paddingBottom: state.bottomPadding }]}
    >
      <View style={styles.hero}>
        <View style={styles.badges}>
          <Text style={styles.stage}>{item.stage}</Text>
          <Text style={styles.project}>{item.project}</Text>
          {delivery ? <Text style={styles.delivery}>{delivery.status}</Text> : null}
        </View>
        <Text style={styles.ref}>{item.id}</Text>
        <Text style={styles.title}>{item.title}</Text>
        {item.targetProjects?.length ? (
          <Text style={styles.muted}>Targets: {item.targetProjects.join(', ')}</Text>
        ) : null}
        {item.tags?.length ? <Text style={styles.muted}>{item.tags.join(' · ')}</Text> : null}
      </View>

      {state.error ? (
        <View style={styles.refreshError}>
          <Text style={styles.error}>{state.error}</Text>
          <Pressable style={styles.retry} onPress={() => void actions.refresh()}>
            <Text style={styles.view}>Retry</Text>
          </Pressable>
        </View>
      ) : null}

      <Pressable style={styles.documentCard} onPress={actions.openDocument}>
        <Ionicons name="document-text-outline" size={23} color={colors.accent} />
        <View style={styles.grow}>
          <Text style={styles.sectionTitle}>Roadmap document</Text>
          <Text style={styles.muted}>{item.filePath}</Text>
        </View>
        <Text style={styles.view}>View</Text>
      </Pressable>

      {delivery ? (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Delivery lineage</Text>
          <Text style={styles.summary}>
            {delivery.backlogItems.length} backlog items · {delivery.runFamilies.length} run
            families · {delivery.prs.length} PRs
          </Text>
          {delivery.backlogItems.map((entry) => (
            <Pressable
              key={entry.backlogItemId}
              style={styles.lineageRow}
              onPress={() => entry.resolved && actions.openBacklogItem(entry.backlogItemId)}
            >
              <View style={styles.grow}>
                <Text style={styles.lineageTitle}>{entry.ref || entry.backlogItemId}</Text>
                <Text style={styles.muted}>
                  {entry.title || 'Missing backlog item'} · {entry.status || 'unresolved'}
                </Text>
              </View>
              <Text
                style={[
                  styles.lineageStatus,
                  { color: entry.delivered ? colors.statusOk : colors.statusWarn },
                ]}
              >
                {entry.delivered ? 'delivered' : 'open'}
              </Text>
            </Pressable>
          ))}
          {delivery.prs.map((pr) => (
            <Pressable
              key={pr.ref}
              style={styles.lineageRow}
              onPress={() => pr.url && void actions.openPr(pr.url)}
            >
              <Ionicons name="git-pull-request-outline" size={17} color={colors.accent} />
              <Text style={styles.lineageTitle}>{pr.ref}</Text>
            </Pressable>
          ))}
          {delivery.findings.map((finding) => (
            <View key={`${finding.code}:${finding.backlogItemId ?? ''}`} style={styles.finding}>
              <Text style={styles.findingTitle}>{finding.code}</Text>
              <Text style={styles.summary}>{finding.detail}</Text>
              <Text style={styles.muted}>{finding.remediation}</Text>
            </View>
          ))}
        </View>
      ) : null}

      {planningContext?.relations.length ? (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Related work</Text>
          {planningContext.relations.map((relation) => (
            <View key={`${relation.label}:${relation.targetId}`} style={styles.relationRow}>
              <Text style={styles.relationLabel}>{relation.label}</Text>
              <View style={styles.grow}>
                <Text style={styles.lineageTitle}>{relation.targetRef || relation.targetId}</Text>
                <Text style={styles.muted}>{relation.targetTitle || relation.reason}</Text>
              </View>
            </View>
          ))}
        </View>
      ) : null}

      <DocumentViewer
        visible={state.documentOpen}
        title={item.title}
        body={item.body}
        onClose={actions.closeDocument}
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
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  stage: {
    color: colors.accent,
    fontFamily: fonts.mono,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  project: { color: colors.textSecondary, fontFamily: fonts.mono, fontSize: fonts.sizeXs },
  delivery: {
    color: colors.statusWarn,
    fontFamily: fonts.mono,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  ref: { color: colors.textMuted, fontFamily: fonts.mono, fontSize: fonts.sizeXs },
  title: { color: colors.textPrimary, fontSize: fonts.sizeXl, fontWeight: '900', lineHeight: 25 },
  muted: { color: colors.textMuted, fontSize: fonts.sizeXs, lineHeight: 16 },
  documentCard: {
    alignItems: 'center',
    backgroundColor: colors.bgSurface,
    borderColor: colors.accent + '55',
    borderRadius: radii.lg,
    borderWidth: 1,
    flexDirection: 'row',
    gap: spacing.md,
    padding: spacing.lg,
  },
  grow: { flex: 1, gap: spacing.xs },
  view: { color: colors.accent, fontSize: fonts.sizeSm, fontWeight: '900' },
  card: {
    backgroundColor: colors.bgSurface,
    borderRadius: radii.lg,
    gap: spacing.md,
    padding: spacing.lg,
  },
  sectionTitle: { color: colors.textPrimary, fontSize: fonts.sizeMd, fontWeight: '900' },
  summary: { color: colors.textSecondary, fontSize: fonts.sizeSm, lineHeight: 18 },
  lineageRow: {
    alignItems: 'center',
    backgroundColor: colors.bgCard,
    borderRadius: radii.md,
    flexDirection: 'row',
    gap: spacing.md,
    padding: spacing.md,
  },
  lineageTitle: { color: colors.textPrimary, flex: 1, fontSize: fonts.sizeSm, fontWeight: '800' },
  lineageStatus: { fontFamily: fonts.mono, fontSize: fonts.sizeXs, fontWeight: '900' },
  finding: {
    borderColor: colors.statusFail + '66',
    borderRadius: radii.md,
    borderWidth: 1,
    gap: spacing.sm,
    padding: spacing.md,
  },
  findingTitle: {
    color: colors.statusFail,
    fontFamily: fonts.mono,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  relationRow: {
    alignItems: 'flex-start',
    borderTopColor: colors.bgCardHover,
    borderTopWidth: 1,
    flexDirection: 'row',
    gap: spacing.md,
    paddingTop: spacing.md,
  },
  relationLabel: {
    color: colors.accent,
    fontFamily: fonts.mono,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    width: 90,
  },
  error: { color: colors.statusFail, fontSize: fonts.sizeSm },
  refreshError: {
    alignItems: 'flex-start',
    backgroundColor: colors.bgSurface,
    borderColor: colors.statusFail + '66',
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.md,
    padding: spacing.lg,
  },
  retry: {
    borderColor: colors.accent,
    borderRadius: radii.md,
    borderWidth: 1,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
});
