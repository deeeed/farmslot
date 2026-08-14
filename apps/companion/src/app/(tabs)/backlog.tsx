import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  type BacklogEnqueueResult,
  type BacklogItem,
  type BacklogListResult,
  type BacklogMarkReadyResult,
  type BacklogStatus,
  Methods,
} from '@farmslot/protocol';

import { runWorkspacePathnameForStatus } from '../../lib/legacy-run-route';
import { colors, floatingCopilotGutter, fonts, radii, spacing } from '../../lib/theme';
import { useConnectionStore } from '../../store/connection';
import { useFilterStore } from '../../store/filters';

const STATUS_ORDER: Record<BacklogStatus, number> = {
  ready: 0,
  candidate: 1,
  'needs-attention': 2,
  failed: 3,
  running: 4,
  dispatching: 5,
  queued: 6,
  done: 7,
  archived: 8,
};

export default function BacklogScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const client = useConnectionStore((state) => state.client);
  const connectionStatus = useConnectionStore((state) => state.status);
  const selectedProjects = useFilterStore((state) => state.filters.projects);
  const [items, setItems] = useState<BacklogItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyItemId, setBusyItemId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!client || connectionStatus !== 'connected') {
      setError('Connect to the gateway to load backlog work.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await client.request<BacklogListResult>(Methods.BACKLOG_LIST, {});
      setItems(result.items);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [client, connectionStatus]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const visibleItems = useMemo(
    () =>
      items
        .filter((item) => item.status !== 'archived' && item.status !== 'done')
        .filter((item) => selectedProjects.length === 0 || selectedProjects.includes(item.project))
        .sort(
          (left, right) =>
            STATUS_ORDER[left.status] - STATUS_ORDER[right.status] ||
            Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
        ),
    [items, selectedProjects],
  );

  const runAction = useCallback(
    async (item: BacklogItem, action: 'ready' | 'enqueue') => {
      if (!client || connectionStatus !== 'connected') return;
      setBusyItemId(item.id);
      setError(null);
      try {
        let updatedItem: BacklogItem;
        if (action === 'ready') {
          const result = await client.request<BacklogMarkReadyResult>(Methods.BACKLOG_MARK_READY, {
            itemId: item.id,
          });
          updatedItem = result.item;
        } else {
          const result = await client.request<BacklogEnqueueResult>(Methods.BACKLOG_ENQUEUE, {
            itemId: item.id,
          });
          updatedItem = result.item;
        }
        setItems((current) =>
          current.map((candidate) => (candidate.id === updatedItem.id ? updatedItem : candidate)),
        );
      } catch (actionError) {
        setError(actionError instanceof Error ? actionError.message : String(actionError));
      } finally {
        setBusyItemId(null);
      }
    },
    [client, connectionStatus],
  );

  const enqueue = useCallback(
    (item: BacklogItem) => {
      Alert.alert('Launch this job?', `${item.sourceRef || item.title}\n${item.project}`, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Launch', onPress: () => void runAction(item, 'enqueue') },
      ]);
    },
    [runAction],
  );

  return (
    <View style={styles.container}>
      <View style={styles.toolbar}>
        <View>
          <Text style={styles.title}>Backlog</Text>
          <Text style={styles.count}>{visibleItems.length} active items</Text>
        </View>
        <Pressable style={styles.createButton} onPress={() => router.push('/backlog/create')}>
          <Ionicons name="add" size={18} color={colors.bgBase} />
          <Text style={styles.createText}>New</Text>
        </Pressable>
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <FlatList
        data={visibleItems}
        keyExtractor={(item) => item.id}
        contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + spacing.xl }]}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void load()} />}
        ListEmptyComponent={
          loading ? (
            <ActivityIndicator color={colors.accent} />
          ) : (
            <Text style={styles.empty}>No active backlog items in this project scope.</Text>
          )
        }
        renderItem={({ item }) => (
          <BacklogRow
            item={item}
            busy={busyItemId === item.id}
            onOpen={() => router.push({ pathname: '/backlog/[id]', params: { id: item.id } })}
            onMarkReady={() => void runAction(item, 'ready')}
            onEnqueue={() => enqueue(item)}
            onOpenRun={
              item.runId
                ? () =>
                    router.push({
                      pathname: runWorkspacePathnameForStatus(item.lastObservedRunStatus),
                      params: { runId: item.runId! },
                    })
                : undefined
            }
          />
        )}
      />
    </View>
  );
}

function BacklogRow({
  item,
  busy,
  onMarkReady,
  onEnqueue,
  onOpenRun,
  onOpen,
}: {
  item: BacklogItem;
  busy: boolean;
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
            disabled={busy}
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
            disabled={busy}
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
