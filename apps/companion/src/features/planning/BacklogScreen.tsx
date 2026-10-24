import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import type { BacklogItem, BacklogStatus } from '@farmslot/protocol';

import { ResourceReadStatus } from '../../components/ResourceReadStatus';
import { colors, floatingCopilotGutter, fonts, radii, spacing } from '../../lib/theme';

import type { useBacklogController } from './use-backlog-controller';

export default function BacklogScreen({
  screen,
}: {
  screen: ReturnType<typeof useBacklogController>;
}) {
  const { state, actions } = screen;
  return (
    <View style={styles.container}>
      <View style={styles.toolbar}>
        <View>
          <Text style={styles.title}>Backlog</Text>
          <Text style={styles.count}>{state.visibleItems.length} active items</Text>
        </View>
        <Pressable style={styles.createButton} disabled={!state.ready} onPress={actions.openCreate}>
          <Ionicons name="add" size={18} color={colors.bgBase} />
          <Text style={styles.createText}>New</Text>
        </Pressable>
      </View>
      <ResourceReadStatus observation={state.observation} label="backlog" />
      {state.error ? <Text style={styles.error}>{state.error}</Text> : null}
      <FlatList
        data={state.visibleItems}
        keyExtractor={(item) => item.id}
        contentContainerStyle={[styles.list, { paddingBottom: state.bottomPadding }]}
        refreshControl={
          <RefreshControl refreshing={state.loading} onRefresh={() => void actions.refresh()} />
        }
        ListEmptyComponent={
          state.loading ? (
            <ActivityIndicator color={colors.accent} />
          ) : (
            <Text style={styles.empty}>No active backlog items in this project scope.</Text>
          )
        }
        renderItem={({ item }) => (
          <BacklogRow
            item={item}
            busy={state.busyItemId === item.id}
            onOpen={() => actions.openItem(item.id)}
            onMarkReady={() => void actions.markReady(item)}
            onEnqueue={() => actions.enqueue(item)}
            ready={state.ready}
            onOpenRun={item.runId ? () => actions.openRun(item) : undefined}
          />
        )}
      />
    </View>
  );
}

function BacklogRow({
  item,
  busy,
  ready,
  onMarkReady,
  onEnqueue,
  onOpenRun,
  onOpen,
}: {
  item: BacklogItem;
  busy: boolean;
  ready: boolean;
  onMarkReady: () => void;
  onEnqueue: () => void;
  onOpenRun?: () => void;
  onOpen: () => void;
}) {
  const action = item.status === 'candidate' ? 'ready' : item.status === 'ready' ? 'enqueue' : null;
  const graphManaged = Boolean(item.workGraphId);

  return (
    <Pressable style={styles.card} onPress={onOpen}>
      <View style={styles.metaRow}>
        <Text style={[styles.status, { color: statusColor(item.status) }]}>{item.status}</Text>
        <Text style={styles.flow}>{item.flowType}</Text>
        <Text style={styles.project} numberOfLines={1}>
          {item.project}
        </Text>
      </View>
      <Text style={styles.ref} numberOfLines={1}>
        {item.sourceRef || item.id}
      </Text>
      <Text style={styles.itemTitle} numberOfLines={2}>
        {item.title}
      </Text>
      <View style={styles.actions}>
        {action === 'ready' ? (
          <Pressable
            testID={`companion-backlog-${item.id}-ready`}
            style={styles.secondaryButton}
            disabled={busy || !ready}
            onPress={(event) => {
              event.stopPropagation();
              onMarkReady();
            }}
          >
            <Text style={styles.secondaryText}>{busy ? 'Working…' : 'Mark ready'}</Text>
          </Pressable>
        ) : null}
        {action === 'enqueue' && !graphManaged ? (
          <Pressable
            testID={`companion-backlog-${item.id}-enqueue`}
            style={styles.primaryButton}
            disabled={busy || !ready}
            onPress={(event) => {
              event.stopPropagation();
              onEnqueue();
            }}
          >
            <Text style={styles.primaryText}>{busy ? 'Launching…' : 'Launch'}</Text>
          </Pressable>
        ) : null}
        {action === 'enqueue' && graphManaged ? (
          <Text style={styles.graphManaged}>Graph managed</Text>
        ) : null}
        {onOpenRun ? (
          <Pressable
            style={styles.secondaryButton}
            onPress={(event) => {
              event.stopPropagation();
              onOpenRun();
            }}
          >
            <Text style={styles.secondaryText}>Open run</Text>
          </Pressable>
        ) : null}
      </View>
    </Pressable>
  );
}

function statusColor(status: BacklogStatus): string {
  if (status === 'ready' || status === 'running') return colors.statusOk;
  if (status === 'failed' || status === 'needs-attention') return colors.statusFail;
  if (status === 'queued' || status === 'dispatching') return colors.statusWarn;
  return colors.textMuted;
}

const styles = StyleSheet.create({
  container: { backgroundColor: colors.bgBase, flex: 1 },
  toolbar: {
    alignItems: 'center',
    borderBottomColor: colors.bgCard,
    borderBottomWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    padding: spacing.lg,
  },
  title: { color: colors.textPrimary, fontSize: fonts.sizeXl, fontWeight: '900' },
  count: { color: colors.textMuted, fontSize: fonts.sizeXs, marginTop: 2 },
  createButton: {
    alignItems: 'center',
    backgroundColor: colors.accent,
    borderRadius: radii.md,
    flexDirection: 'row',
    gap: spacing.xs,
    marginRight: floatingCopilotGutter,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  createText: { color: colors.bgBase, fontSize: fonts.sizeSm, fontWeight: '900' },
  error: { color: colors.statusFail, fontSize: fonts.sizeSm, padding: spacing.lg },
  list: { gap: spacing.md, padding: spacing.lg },
  empty: { color: colors.textMuted, fontSize: fonts.sizeSm, paddingVertical: spacing.xl },
  card: {
    backgroundColor: colors.bgSurface,
    borderColor: colors.bgCardHover,
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.sm,
    padding: spacing.lg,
  },
  metaRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm },
  status: { fontFamily: fonts.mono, fontSize: fonts.sizeXs, fontWeight: '900' },
  flow: { color: colors.accent, fontFamily: fonts.mono, fontSize: fonts.sizeXs },
  project: { color: colors.textMuted, flex: 1, fontSize: fonts.sizeXs, textAlign: 'right' },
  ref: { color: colors.textSecondary, fontFamily: fonts.mono, fontSize: fonts.sizeXs },
  itemTitle: {
    color: colors.textPrimary,
    fontSize: fonts.sizeMd,
    fontWeight: '800',
    lineHeight: 20,
  },
  actions: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs },
  primaryButton: {
    backgroundColor: colors.accent,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  primaryText: { color: colors.bgBase, fontSize: fonts.sizeXs, fontWeight: '900' },
  secondaryButton: {
    borderColor: colors.bgCardHover,
    borderRadius: radii.md,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  secondaryText: { color: colors.accent, fontSize: fonts.sizeXs, fontWeight: '900' },
  graphManaged: { color: colors.textMuted, fontSize: fonts.sizeXs },
});
