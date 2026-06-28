import AsyncStorage from '@react-native-async-storage/async-storage';
import { FlashList } from '@shopify/flash-list';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { type GestureResponderEvent, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  flattenTmuxWorkers,
  isTmuxWorkerWatched,
  Methods,
  reconcileTmuxWorkerWatchlist,
  removeTmuxWorkerWatchItem,
  type TmuxWorkerNodeResult,
  type TmuxWorkerRef,
  type TmuxWorkerSummary,
  type TmuxWorkerWatchEntry,
  type TmuxWorkerWatchItem,
  upsertTmuxWorkerWatchItem,
} from '@farmslot/protocol';

import { colors, fonts, radii, spacing } from '../../lib/theme';
import {
  buildTmuxWorkerRows,
  filterTmuxWorkerNodes,
  type TmuxWorkerListItem,
  tmuxWorkerNodeSummaryLabel,
  tmuxWorkerRefLabel,
  tmuxWorkerRouteParams,
  tmuxWorkerRouteParamsFromRef,
  tmuxWorkerStateLabel,
  tmuxWorkerStateTone,
  tmuxWorkerSubtitle,
  tmuxWorkerTitle,
  tmuxWorkerWatchEntrySubtitle,
  tmuxWorkerWatchEntryTitle,
} from '../../lib/tmux-workers';
import { useConnectionStore } from '../../store/connection';
import { useFilterStore } from '../../store/filters';

const TERMINAL_WATCHLIST_STORAGE_KEY = 'farmslot:terminal-watchlist:v1';

type WorkerPaneFilter = 'adhoc' | 'all' | 'farmslot';

type TerminalListItem =
  | { type: 'watch-header'; count: number }
  | { type: 'watch-entry'; entry: TmuxWorkerWatchEntry }
  | TmuxWorkerListItem;

function parseWatchItems(raw: string | null): TmuxWorkerWatchItem[] {
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (item): item is TmuxWorkerWatchItem =>
      typeof item === 'object' &&
      item !== null &&
      typeof (item as TmuxWorkerWatchItem).id === 'string' &&
      typeof (item as TmuxWorkerWatchItem).nodeId === 'string' &&
      typeof (item as TmuxWorkerWatchItem).target === 'string' &&
      typeof (item as TmuxWorkerWatchItem).ref?.nodeId === 'string' &&
      typeof (item as TmuxWorkerWatchItem).ref?.target === 'string',
  );
}

function isFarmslotWorker(worker: TmuxWorkerSummary): boolean {
  return Boolean(worker.linkedSlotId || worker.linkedRunId || worker.linkedFamilyId);
}

function isFarmslotWatchEntry(entry: TmuxWorkerWatchEntry): boolean {
  return entry.worker
    ? isFarmslotWorker(entry.worker)
    : Boolean(entry.item.linkedSlotId || entry.item.linkedRunId || entry.item.linkedFamilyId);
}

function workerMatchesFilter(worker: TmuxWorkerSummary, filter: WorkerPaneFilter): boolean {
  if (filter === 'all') return true;
  const farmslot = isFarmslotWorker(worker);
  return filter === 'farmslot' ? farmslot : !farmslot;
}

function watchEntryMatchesFilter(entry: TmuxWorkerWatchEntry, filter: WorkerPaneFilter): boolean {
  if (filter === 'all') return true;
  const farmslot = isFarmslotWatchEntry(entry);
  return filter === 'farmslot' ? farmslot : !farmslot;
}

export default function WorkersScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const client = useConnectionStore((s) => s.client);
  const status = useConnectionStore((s) => s.status);
  const filters = useFilterStore((s) => s.filters);
  const [nodes, setNodes] = useState<TmuxWorkerNodeResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(() => new Set());
  const [watchItems, setWatchItems] = useState<TmuxWorkerWatchItem[]>([]);
  const watchItemsRef = useRef<TmuxWorkerWatchItem[]>([]);
  const [workerFilter, setWorkerFilter] = useState<WorkerPaneFilter>('adhoc');

  const saveWatchItems = useCallback((next: TmuxWorkerWatchItem[]) => {
    void AsyncStorage.setItem(TERMINAL_WATCHLIST_STORAGE_KEY, JSON.stringify(next)).catch((err) => {
      setError(
        `Failed to save terminal watchlist: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }, []);

  const persistWatchItems = useCallback(
    (next: TmuxWorkerWatchItem[]) => {
      watchItemsRef.current = next;
      setWatchItems(next);
      saveWatchItems(next);
    },
    [saveWatchItems],
  );

  const loadWatchItems = useCallback(async (): Promise<TmuxWorkerWatchItem[]> => {
    try {
      const loaded = parseWatchItems(await AsyncStorage.getItem(TERMINAL_WATCHLIST_STORAGE_KEY));
      watchItemsRef.current = loaded;
      setWatchItems(loaded);
      return loaded;
    } catch (err) {
      // A corrupt local watchlist is recoverable: reset only this local cache so
      // the terminal page can still load and the operator can rebuild the list.
      console.warn('[terminals] resetting corrupt local watchlist', err);
      await AsyncStorage.removeItem(TERMINAL_WATCHLIST_STORAGE_KEY);
      watchItemsRef.current = [];
      setWatchItems([]);
      return [];
    }
  }, []);

  const toggleSession = useCallback((sessionKey: string) => {
    setExpandedSessions((prev) => {
      const next = new Set(prev);
      if (next.has(sessionKey)) next.delete(sessionKey);
      else next.add(sessionKey);
      return next;
    });
  }, []);

  const refresh = useCallback(
    async (baseWatchItems?: readonly TmuxWorkerWatchItem[]) => {
      if (!client || status !== 'connected') {
        setNodes([]);
        setError(status === 'connected' ? null : 'Connect to the gateway to list tmux workers.');
        return;
      }
      setRefreshing(true);
      try {
        const result = await client.request<{ nodes: TmuxWorkerNodeResult[] }>(
          Methods.TMUX_WORKER_LIST,
          { includeDisconnected: true },
          10_000,
        );
        setNodes(result.nodes);
        const workers = flattenTmuxWorkers(result.nodes);
        const sourceWatchItems = baseWatchItems ?? watchItemsRef.current;
        const refreshed = reconcileTmuxWorkerWatchlist(sourceWatchItems, workers).map(
          (entry) => entry.item,
        );
        persistWatchItems(refreshed);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setRefreshing(false);
      }
    },
    [client, persistWatchItems, status],
  );

  useFocusEffect(
    useCallback(() => {
      void (async () => {
        const loaded = await loadWatchItems();
        await refresh(loaded);
      })();
    }, [loadWatchItems, refresh]),
  );

  const machineFilteredNodes = useMemo(
    () => filterTmuxWorkerNodes(nodes, filters),
    [filters, nodes],
  );
  const machineFilteredWorkers = useMemo(
    () => flattenTmuxWorkers(machineFilteredNodes),
    [machineFilteredNodes],
  );
  const filteredNodes = useMemo(
    () =>
      machineFilteredNodes
        .map((node) => ({
          ...node,
          workers: node.workers.filter((worker) => workerMatchesFilter(worker, workerFilter)),
        }))
        .filter((node) => !node.ok || node.workers.length > 0),
    [machineFilteredNodes, workerFilter],
  );
  const workerFilterCounts = useMemo(() => {
    const farmslot = machineFilteredWorkers.filter(isFarmslotWorker).length;
    return {
      adhoc: machineFilteredWorkers.length - farmslot,
      all: machineFilteredWorkers.length,
      farmslot,
    };
  }, [machineFilteredWorkers]);
  const watchEntries = useMemo(
    () =>
      reconcileTmuxWorkerWatchlist(watchItems, machineFilteredWorkers).filter((entry) =>
        watchEntryMatchesFilter(entry, workerFilter),
      ),
    [machineFilteredWorkers, watchItems, workerFilter],
  );
  const items = useMemo(
    (): TerminalListItem[] => [
      ...(watchEntries.length > 0
        ? [
            { type: 'watch-header' as const, count: watchEntries.length },
            ...watchEntries.map((entry) => ({ type: 'watch-entry' as const, entry })),
          ]
        : []),
      ...buildTmuxWorkerRows(filteredNodes, expandedSessions),
    ],
    [filteredNodes, expandedSessions, watchEntries],
  );

  const openWorkerRef = useCallback(
    (ref: TmuxWorkerRef, title?: string) => {
      router.push({
        pathname: '/terminal/worker',
        params: tmuxWorkerRouteParamsFromRef(ref, title),
      });
    },
    [router],
  );

  const openWorker = useCallback(
    (worker: TmuxWorkerSummary) => {
      router.push({ pathname: '/terminal/worker', params: tmuxWorkerRouteParams(worker) });
    },
    [router],
  );

  const toggleWatchedWorker = useCallback(
    (worker: TmuxWorkerSummary, event?: GestureResponderEvent) => {
      event?.stopPropagation();
      const next = isTmuxWorkerWatched(watchItems, worker.ref)
        ? removeTmuxWorkerWatchItem(watchItems, worker.ref)
        : upsertTmuxWorkerWatchItem(watchItems, worker);
      persistWatchItems(next);
    },
    [persistWatchItems, watchItems],
  );

  const removeWatchedEntry = useCallback(
    (entry: TmuxWorkerWatchEntry, event?: GestureResponderEvent) => {
      event?.stopPropagation();
      persistWatchItems(removeTmuxWorkerWatchItem(watchItems, entry.ref));
    },
    [persistWatchItems, watchItems],
  );

  const renderItem = useCallback(
    ({ item }: { item: TerminalListItem }) => {
      if (item.type === 'watch-header') {
        return (
          <View style={styles.watchHeader}>
            <View>
              <Text style={styles.watchTitle}>Watchlist</Text>
              <Text style={styles.watchHint}>Local only. Pin tmux panes you want on mobile.</Text>
            </View>
            <Text style={styles.watchCount}>{item.count}</Text>
          </View>
        );
      }
      if (item.type === 'watch-entry') {
        const { entry } = item;
        const title = tmuxWorkerWatchEntryTitle(entry);
        const subtitle = tmuxWorkerWatchEntrySubtitle(entry);
        return (
          <Pressable
            style={[styles.watchCard, !entry.live && styles.watchCardStale]}
            onPress={() => openWorkerRef(entry.ref, title)}
          >
            <View style={styles.workerTopRow}>
              <Text style={styles.workerTitle} numberOfLines={1}>
                {title}
              </Text>
              <View
                style={[
                  styles.statusBadge,
                  entry.live ? styles.statusBadgeOk : styles.statusBadgeMuted,
                ]}
              >
                <Text
                  style={[
                    styles.statusText,
                    entry.live ? styles.statusTextOk : styles.statusTextMuted,
                  ]}
                >
                  {entry.live ? 'live' : 'stale'}
                </Text>
              </View>
              <Pressable
                style={[styles.watchButton, styles.watchButtonActive]}
                onPress={(event) => removeWatchedEntry(entry, event)}
                hitSlop={8}
              >
                <Text style={styles.watchButtonText}>★</Text>
              </Pressable>
            </View>
            <Text style={styles.workerRef} numberOfLines={1}>
              {entry.ref.nodeId} · {entry.ref.session} · {entry.ref.target}
            </Text>
            <Text style={styles.workerStatus} numberOfLines={1}>
              {entry.worker?.status.label ?? entry.item.statusLabel ?? 'last seen terminal'}
            </Text>
            {subtitle ? (
              <Text style={styles.workerSubtitle} numberOfLines={2}>
                {subtitle}
              </Text>
            ) : null}
          </Pressable>
        );
      }
      if (item.type === 'header') {
        return (
          <View style={styles.headerRow}>
            <Text style={styles.headerTitle}>{item.node.nodeId}</Text>
            <Text
              style={[styles.headerMeta, !item.node.ok && styles.headerError]}
              numberOfLines={1}
            >
              {tmuxWorkerNodeSummaryLabel(item.node)}
            </Text>
          </View>
        );
      }
      if (item.type === 'window') {
        const nameSuffix = item.windowName ? ` · ${item.windowName}` : '';
        return (
          <View style={styles.windowRow}>
            <Text style={styles.windowLabel} numberOfLines={1}>
              window {item.window}
              {nameSuffix}
            </Text>
            <Text style={styles.windowMeta} numberOfLines={1}>
              {item.paneCount} pane{item.paneCount === 1 ? '' : 's'}
            </Text>
          </View>
        );
      }
      const worker = item.worker;
      const watched = isTmuxWorkerWatched(watchItems, worker.ref);
      const stateTone = tmuxWorkerStateTone(worker);
      const isSiblingRole = item.role !== 'primary';
      const isShell = item.isShell;
      const hasSiblings = item.siblingCount > 0;
      const window = worker.ref.window ?? '0';
      const pane = worker.ref.pane ?? '0';
      const paneLabel = `${window}:${pane}`;
      const windowName = worker.ref.windowName;
      const command = worker.command;
      const title = isSiblingRole
        ? windowName
          ? `${windowName} · ${command ?? `pane ${paneLabel}`}`
          : worker.title || command || `pane ${paneLabel}`
        : tmuxWorkerTitle(worker);
      return (
        <Pressable
          style={[
            styles.workerCard,
            isSiblingRole && styles.workerCardSibling,
            isShell && styles.workerCardShell,
            item.isActive && styles.workerCardActive,
          ]}
          onPress={() => openWorker(worker)}
        >
          {item.isActive ? <View style={styles.activeAccentBar} /> : null}
          <View style={styles.workerTopRow}>
            {item.isActive ? <View style={styles.activeDot} /> : null}
            <Text style={styles.workerTitle} numberOfLines={1}>
              {title}
            </Text>
            <Pressable
              style={[styles.watchButton, watched && styles.watchButtonActive]}
              onPress={(event) => toggleWatchedWorker(worker, event)}
              hitSlop={8}
            >
              <Text style={styles.watchButtonText}>{watched ? '★' : '☆'}</Text>
            </Pressable>
            <View
              style={[
                styles.statusBadge,
                stateTone === 'ok'
                  ? styles.statusBadgeOk
                  : stateTone === 'warn'
                    ? styles.statusBadgeWarn
                    : styles.statusBadgeMuted,
              ]}
            >
              <Text
                style={[
                  styles.statusText,
                  stateTone === 'ok'
                    ? styles.statusTextOk
                    : stateTone === 'warn'
                      ? styles.statusTextWarn
                      : styles.statusTextMuted,
                ]}
              >
                {tmuxWorkerStateLabel(worker)}
              </Text>
            </View>
          </View>
          <Text style={styles.workerRef} numberOfLines={1}>
            {tmuxWorkerRefLabel(worker, item.sessionPaneCount)}
          </Text>
          <Text style={styles.workerStatus} numberOfLines={1}>
            {worker.status.label}
            {worker.status.stale ? ' · stale' : ''}
          </Text>
          <Text style={styles.workerSubtitle} numberOfLines={2}>
            {tmuxWorkerSubtitle(worker)}
          </Text>
          {isShell ? (
            <View style={styles.shellBadge}>
              <Text style={styles.shellBadgeText}>shell</Text>
            </View>
          ) : null}
          {!isSiblingRole && hasSiblings ? (
            <Pressable
              style={styles.expandRow}
              onPress={() => toggleSession(item.sessionKey)}
              hitSlop={8}
            >
              <Text style={styles.expandText}>
                {item.expanded
                  ? `Hide ${item.siblingCount} other pane${item.siblingCount === 1 ? '' : 's'}`
                  : `Show ${item.siblingCount} other pane${item.siblingCount === 1 ? '' : 's'}`}
              </Text>
              <Text style={styles.expandChevron}>{item.expanded ? '▾' : '▸'}</Text>
            </Pressable>
          ) : null}
        </Pressable>
      );
    },
    [openWorker, openWorkerRef, removeWatchedEntry, toggleSession, toggleWatchedWorker, watchItems],
  );

  const empty =
    status === 'connected'
      ? nodes.length > 0 && filteredNodes.length === 0
        ? 'No tmux terminals match the current filters.'
        : workerFilter === 'adhoc'
          ? 'No non-Farmslot tmux panes reported by registered nodes.'
          : 'No tmux panes reported by registered nodes.'
      : 'Not connected.';

  return (
    <View style={[styles.container, { paddingBottom: insets.bottom + spacing.sm }]}>
      <View style={styles.summaryRow}>
        <Text style={styles.summaryTitle}>Terminals</Text>
        <Pressable
          style={styles.refreshButton}
          onPress={() => void refresh()}
          disabled={refreshing}
        >
          <Text style={styles.refreshText}>{refreshing ? 'Refreshing…' : 'Refresh'}</Text>
        </Pressable>
      </View>
      <View style={styles.filterRow}>
        {(['adhoc', 'farmslot', 'all'] as WorkerPaneFilter[]).map((filter) => (
          <Pressable
            key={filter}
            style={[styles.filterButton, workerFilter === filter && styles.filterButtonActive]}
            onPress={() => setWorkerFilter(filter)}
          >
            <Text
              style={[
                styles.filterButtonText,
                workerFilter === filter && styles.filterButtonTextActive,
              ]}
            >
              {filter === 'adhoc'
                ? `Non-Farmslot ${workerFilterCounts.adhoc}`
                : filter === 'farmslot'
                  ? `Farmslot ${workerFilterCounts.farmslot}`
                  : `All ${workerFilterCounts.all}`}
            </Text>
          </Pressable>
        ))}
      </View>
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
      <FlashList
        data={items}
        keyExtractor={(item, index) => {
          if (item.type === 'watch-header') return 'watch-header';
          if (item.type === 'watch-entry') return `watch:${item.entry.id}`;
          if (item.type === 'header') return `node:${item.node.nodeId}`;
          if (item.type === 'window') return `window:${item.windowKey}`;
          return `worker:${item.worker.ref.nodeId}:${item.worker.ref.target}:${index}`;
        }}
        renderItem={renderItem}
        ListEmptyComponent={<Text style={styles.emptyText}>{empty}</Text>}
        contentContainerStyle={styles.listContent}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgBase },
  summaryRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  summaryTitle: { color: colors.textPrimary, fontWeight: '600', fontSize: 18 },
  refreshButton: {
    backgroundColor: colors.bgCard,
    borderRadius: radii.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  refreshText: { color: colors.accent, fontWeight: '600', fontSize: 12 },
  filterRow: {
    flexDirection: 'row',
    gap: spacing.xs,
    paddingBottom: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  filterButton: {
    backgroundColor: colors.bgCard,
    borderColor: colors.bgCard,
    borderRadius: radii.lg,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  filterButtonActive: {
    backgroundColor: colors.accent + '18',
    borderColor: colors.accent,
  },
  filterButtonText: {
    color: colors.textSecondary,
    fontFamily: fonts.mono,
    fontSize: 11,
    fontWeight: '600',
  },
  filterButtonTextActive: { color: colors.accent },
  errorText: { color: colors.statusFail, paddingHorizontal: spacing.md, paddingBottom: spacing.sm },
  listContent: { paddingHorizontal: spacing.md, paddingBottom: spacing.lg },
  emptyText: { color: colors.textMuted, padding: spacing.lg, textAlign: 'center' },
  watchHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingBottom: spacing.xs,
    paddingTop: spacing.sm,
  },
  watchTitle: { color: colors.textPrimary, fontWeight: '600', fontSize: 14 },
  watchHint: { color: colors.textMuted, fontSize: 11, marginTop: 2 },
  watchCount: {
    color: colors.textMuted,
    fontFamily: fonts.mono,
    fontSize: 12,
  },
  watchCard: {
    backgroundColor: colors.bgCard,
    borderColor: colors.accent,
    borderRadius: radii.lg,
    borderWidth: 1,
    marginBottom: spacing.sm,
    padding: spacing.md,
  },
  watchCardStale: {
    borderColor: colors.bgCard,
    opacity: 0.78,
  },
  watchButton: {
    alignItems: 'center',
    borderColor: colors.bgCard,
    borderRadius: radii.lg,
    borderWidth: 1,
    height: 28,
    justifyContent: 'center',
    width: 28,
  },
  watchButtonActive: {
    borderColor: colors.statusWarn,
    backgroundColor: colors.statusWarn + '18',
  },
  watchButtonText: {
    color: colors.statusWarn,
    fontSize: 14,
    fontWeight: '700',
  },
  headerRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    justifyContent: 'space-between',
    paddingHorizontal: spacing.xs,
    paddingTop: spacing.md,
    paddingBottom: spacing.xs,
  },
  headerTitle: { color: colors.textPrimary, fontWeight: '600', fontSize: 13 },
  headerMeta: {
    color: colors.textMuted,
    flex: 1,
    fontFamily: fonts.mono,
    fontSize: 11,
    textAlign: 'right',
  },
  headerError: { color: colors.statusWarn },
  workerCard: {
    backgroundColor: colors.bgSurface,
    borderColor: colors.bgCard,
    borderRadius: radii.lg,
    borderWidth: 1,
    marginBottom: spacing.sm,
    padding: spacing.md,
    paddingLeft: spacing.md,
    position: 'relative',
    overflow: 'hidden',
  },
  workerCardSibling: {
    marginLeft: spacing.md,
    backgroundColor: colors.bgBase,
    borderStyle: 'dashed',
  },
  workerCardShell: {
    opacity: 0.55,
  },
  workerCardActive: {
    borderColor: colors.statusOk,
  },
  windowRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    marginLeft: spacing.md,
    marginBottom: spacing.xs,
  },
  windowLabel: {
    color: colors.textSecondary,
    fontFamily: fonts.mono,
    fontSize: 11,
    fontWeight: '600',
  },
  windowMeta: {
    color: colors.textMuted,
    fontFamily: fonts.mono,
    fontSize: 10,
  },
  shellBadge: {
    alignSelf: 'flex-start',
    backgroundColor: colors.bgCard,
    borderColor: colors.textMuted,
    borderRadius: radii.lg,
    borderWidth: 1,
    marginTop: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: 1,
  },
  shellBadgeText: {
    color: colors.textMuted,
    fontFamily: fonts.mono,
    fontSize: 9,
    textTransform: 'uppercase',
  },
  activeAccentBar: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: 3,
    backgroundColor: colors.statusOk,
  },
  activeDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.statusOk,
  },
  expandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.sm,
    paddingTop: spacing.xs,
    borderTopWidth: 1,
    borderTopColor: colors.bgCard,
  },
  expandText: {
    color: colors.accent,
    fontFamily: fonts.mono,
    fontSize: 11,
  },
  expandChevron: {
    color: colors.accent,
    fontSize: 12,
  },
  workerTopRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm },
  workerTitle: { color: colors.textPrimary, flex: 1, fontWeight: '600', fontSize: 15 },
  statusBadge: {
    backgroundColor: colors.accent + '22',
    borderColor: colors.accent,
    borderRadius: radii.lg,
    borderWidth: 1,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  statusBadgeOk: { borderColor: colors.statusOk, backgroundColor: colors.statusOk + '18' },
  statusBadgeWarn: { borderColor: colors.statusWarn, backgroundColor: colors.statusWarn + '18' },
  statusBadgeMuted: { borderColor: colors.accent, backgroundColor: colors.accent + '22' },
  statusText: {
    color: colors.accent,
    fontFamily: fonts.mono,
    fontSize: 10,
    textTransform: 'uppercase',
  },
  statusTextOk: { color: colors.statusOk },
  statusTextWarn: { color: colors.statusWarn },
  statusTextMuted: { color: colors.accent },
  workerRef: {
    color: colors.textSecondary,
    fontFamily: fonts.mono,
    fontSize: 11,
    marginTop: 2,
  },
  workerStatus: { color: colors.textSecondary, fontSize: 12, marginTop: spacing.xs },
  workerSubtitle: {
    color: colors.textMuted,
    fontFamily: fonts.mono,
    fontSize: 11,
    marginTop: spacing.xs,
  },
});
