import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { ArtifactHttpHeaders } from '../lib/artifact-url';
import {
  type DiffFileEntry,
  type DiffFileFilter,
  type DiffLine,
  filterDiffFiles,
  parseUnifiedDiff,
} from '../lib/diff';
import { gatewayFetch } from '../lib/gateway-http-auth';
import { colors, fonts, radii, spacing } from '../lib/theme';

interface MobileDiffViewerProps {
  title?: string;
  diffUrl?: string | null;
  diffText?: string;
  initialPath?: string | null;
  maxHeight?: number;
  fullHeight?: boolean;
  fetchHeaders?: ArtifactHttpHeaders;
  allowFullscreen?: boolean;
  onOpenEvidence?: () => void;
}

const FILTERS: Array<{ id: DiffFileFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'source', label: 'Source' },
  { id: 'tests', label: 'Tests' },
  { id: 'docs', label: 'Docs' },
  { id: 'config', label: 'Config' },
];

const EMPTY_FETCH_HEADERS: ArtifactHttpHeaders = {};

export function MobileDiffViewer({
  title = 'Diff',
  diffUrl,
  diffText,
  initialPath,
  maxHeight,
  fullHeight = false,
  fetchHeaders = EMPTY_FETCH_HEADERS,
  allowFullscreen = true,
  onOpenEvidence,
}: MobileDiffViewerProps) {
  const insets = useSafeAreaInsets();
  const [loadedText, setLoadedText] = useState(diffText ?? '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<DiffFileFilter>('all');
  const [query, setQuery] = useState('');
  const [selectedPath, setSelectedPath] = useState('');
  const [viewMode, setViewMode] = useState<'unified' | 'compact'>('unified');
  const [fullscreenOpen, setFullscreenOpen] = useState(false);
  const appliedInitialPathRef = useRef('');
  const topInset = Math.max(
    insets.top,
    Platform.OS === 'ios' ? 54 : (StatusBar.currentHeight ?? 0),
  );
  const bottomInset = Math.max(insets.bottom, Platform.OS === 'ios' ? 10 : 0);

  useEffect(() => {
    if (diffText) {
      setLoadedText(diffText);
      setError(null);
      setLoading(false);
      return;
    }
    if (!diffUrl) {
      setLoadedText('');
      setError(null);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    gatewayFetch(diffUrl, fetchHeaders, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.text();
      })
      .then((body) => {
        if (controller.signal.aborted) return;
        setLoadedText(body);
      })
      .catch((err: Error) => {
        if (err.name === 'AbortError') return;
        setLoadedText('');
        setError(err.message);
      })
      .finally(() => {
        if (controller.signal.aborted) return;
        setLoading(false);
      });
    return () => controller.abort();
  }, [diffText, diffUrl, fetchHeaders]);

  const files = useMemo(() => parseUnifiedDiff(loadedText), [loadedText]);
  const filteredFiles = useMemo(
    () => filterDiffFiles(files, filter, query),
    [files, filter, query],
  );
  const normalizedInitialPath = initialPath?.trim() ?? '';
  useEffect(() => {
    if (!normalizedInitialPath) {
      appliedInitialPathRef.current = '';
      return;
    }
    if (appliedInitialPathRef.current === normalizedInitialPath) return;
    const match = findDiffFilePath(files, normalizedInitialPath);
    if (!match) return;
    appliedInitialPathRef.current = normalizedInitialPath;
    setSelectedPath(match);
  }, [files, normalizedInitialPath]);

  const selected =
    filteredFiles.find((file) => file.path === selectedPath) ?? filteredFiles[0] ?? files[0];
  const selectedIndex = selected
    ? filteredFiles.findIndex((file) => file.path === selected.path)
    : -1;
  const selectionFilteredOut = Boolean(
    selectedPath &&
    filteredFiles.length > 0 &&
    !filteredFiles.some((file) => file.path === selectedPath),
  );

  const totals = files.reduce(
    (acc, file) => ({
      additions: acc.additions + file.additions,
      deletions: acc.deletions + file.deletions,
    }),
    { additions: 0, deletions: 0 },
  );
  const filterCounts = useMemo(
    () =>
      FILTERS.reduce<Record<DiffFileFilter, number>>(
        (acc, item) => ({ ...acc, [item.id]: filterDiffFiles(files, item.id, '').length }),
        { all: 0, source: 0, tests: 0, docs: 0, config: 0 },
      ),
    [files],
  );

  const goToFileOffset = (offset: number) => {
    if (filteredFiles.length === 0) return;
    const currentIndex = selectedIndex >= 0 ? selectedIndex : 0;
    const nextIndex = (currentIndex + offset + filteredFiles.length) % filteredFiles.length;
    setSelectedPath(filteredFiles[nextIndex].path);
  };

  if (!diffUrl && !diffText) return null;

  const isInline = !fullHeight && allowFullscreen;

  if (isInline) {
    return (
      <View style={[styles.container, maxHeight ? { maxHeight } : undefined]}>
        <View style={styles.inlineHeader}>
          <View style={styles.headerText}>
            <Text style={styles.title}>{title}</Text>
            <Text style={styles.subtitle}>
              {files.length} file{files.length !== 1 ? 's' : ''} ·{' '}
              <Text style={styles.addText}>+{totals.additions}</Text> ·{' '}
              <Text style={styles.delText}>-{totals.deletions}</Text>
            </Text>
          </View>
          <Pressable style={styles.reviewButton} onPress={() => setFullscreenOpen(true)}>
            <Text style={styles.reviewButtonText}>Review diff</Text>
          </Pressable>
          {onOpenEvidence ? (
            <Pressable style={styles.evidenceButton} onPress={onOpenEvidence}>
              <Text style={styles.evidenceButtonText}>Evidence</Text>
            </Pressable>
          ) : null}
        </View>

        {loading ? (
          <Text style={styles.emptyText}>Loading diff…</Text>
        ) : error ? (
          <Text style={styles.errorText}>Failed to load diff: {error}</Text>
        ) : files.length === 0 ? (
          <Text style={styles.emptyText}>No diff content available.</Text>
        ) : (
          <View style={styles.diffBody}>
            {filteredFiles.length > 0 && selected ? (
              <View style={styles.fileNavigator}>
                <Pressable
                  style={[styles.navButton, filteredFiles.length <= 1 && styles.navButtonDisabled]}
                  disabled={filteredFiles.length <= 1}
                  onPress={() => goToFileOffset(-1)}
                >
                  <Text style={styles.navButtonText}>‹</Text>
                </Pressable>
                <Pressable style={styles.navCenter} onPress={() => setFullscreenOpen(true)}>
                  <Text style={styles.navCount}>
                    {Math.max(1, selectedIndex + 1)}/{filteredFiles.length}
                  </Text>
                  <Text style={styles.navPath} numberOfLines={1}>
                    {selected.path}
                  </Text>
                </Pressable>
                <Pressable
                  style={[styles.navButton, filteredFiles.length <= 1 && styles.navButtonDisabled]}
                  disabled={filteredFiles.length <= 1}
                  onPress={() => goToFileOffset(1)}
                >
                  <Text style={styles.navButtonText}>›</Text>
                </Pressable>
              </View>
            ) : null}
            {selected ? (
              <Pressable onPress={() => setFullscreenOpen(true)}>
                <DiffFileView file={selected} viewMode="compact" fullHeight={false} />
              </Pressable>
            ) : null}
          </View>
        )}

        <Modal
          visible={fullscreenOpen}
          animationType="slide"
          presentationStyle="fullScreen"
          onRequestClose={() => setFullscreenOpen(false)}
        >
          <View
            style={[
              styles.fullscreenContainer,
              { paddingTop: topInset, paddingBottom: bottomInset },
            ]}
          >
            <View style={styles.fullscreenHeader}>
              <View style={styles.fullscreenTitleBlock}>
                <Text style={styles.fullscreenEyebrow}>File diff</Text>
                <Text style={styles.fullscreenTitle} numberOfLines={1}>
                  {selected?.path ?? title}
                </Text>
              </View>
              <Pressable
                style={styles.fullscreenCloseButton}
                onPress={() => setFullscreenOpen(false)}
              >
                <Text style={styles.fullscreenCloseText}>Close</Text>
              </Pressable>
            </View>
            <MobileDiffViewer
              title={title}
              diffUrl={diffUrl}
              diffText={loadedText || diffText}
              initialPath={selected?.path ?? initialPath}
              fullHeight
              fetchHeaders={fetchHeaders}
              allowFullscreen={false}
              onOpenEvidence={onOpenEvidence}
            />
          </View>
        </Modal>
      </View>
    );
  }

  return (
    <View
      style={[
        styles.container,
        fullHeight && styles.containerFull,
        maxHeight ? { maxHeight } : undefined,
      ]}
    >
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.subtitle}>
            {files.length} files · <Text style={styles.addText}>+{totals.additions}</Text> ·{' '}
            <Text style={styles.delText}>-{totals.deletions}</Text>
          </Text>
        </View>
        {onOpenEvidence ? (
          <Pressable style={styles.evidenceButton} onPress={onOpenEvidence}>
            <Text style={styles.evidenceButtonText}>Evidence</Text>
          </Pressable>
        ) : null}
        <View style={styles.modeToggle}>
          {(['unified', 'compact'] as const).map((mode) => (
            <Pressable
              key={mode}
              style={[styles.modeButton, viewMode === mode && styles.modeButtonActive]}
              onPress={() => setViewMode(mode)}
            >
              <Text style={[styles.modeText, viewMode === mode && styles.modeTextActive]}>
                {mode === 'unified' ? 'Unified' : 'Compact'}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View style={styles.filterWrap}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          {FILTERS.map((item) => (
            <Pressable
              key={item.id}
              style={[styles.filterChip, filter === item.id && styles.filterChipActive]}
              onPress={() => setFilter(item.id)}
            >
              <Text style={[styles.filterText, filter === item.id && styles.filterTextActive]}>
                {item.label} {filterCounts[item.id]}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Filter files"
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.searchInput}
        />
      </View>

      {loading ? (
        <Text style={styles.emptyText}>Loading diff…</Text>
      ) : error ? (
        <Text style={styles.errorText}>Failed to load diff: {error}</Text>
      ) : files.length === 0 ? (
        <Text style={styles.emptyText}>No diff content available.</Text>
      ) : (
        <View style={[styles.diffBody, fullHeight && styles.diffBodyFull]}>
          {filteredFiles.length > 0 && selected ? (
            <View style={styles.fileNavigator}>
              <Pressable
                style={[styles.navButton, filteredFiles.length <= 1 && styles.navButtonDisabled]}
                disabled={filteredFiles.length <= 1}
                onPress={() => goToFileOffset(-1)}
              >
                <Text style={styles.navButtonText}>‹ Prev</Text>
              </Pressable>
              <View style={styles.navCenter}>
                <Text style={styles.navCount}>
                  File {Math.max(1, selectedIndex + 1)}/{filteredFiles.length || files.length}
                </Text>
                <Text style={styles.navPath} numberOfLines={1}>
                  {selected.path}
                </Text>
              </View>
              <Pressable
                style={[styles.navButton, filteredFiles.length <= 1 && styles.navButtonDisabled]}
                disabled={filteredFiles.length <= 1}
                onPress={() => goToFileOffset(1)}
              >
                <Text style={styles.navButtonText}>Next ›</Text>
              </Pressable>
            </View>
          ) : null}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.fileRail}>
            {filteredFiles.map((file) => (
              <Pressable
                key={file.path}
                style={[styles.fileChip, selected?.path === file.path && styles.fileChipActive]}
                onPress={() => setSelectedPath(file.path)}
              >
                <Text style={styles.fileName} numberOfLines={1}>
                  {file.path.split('/').pop() ?? file.path}
                </Text>
                <Text style={styles.fileStats} numberOfLines={1}>
                  +{file.additions} -{file.deletions}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
          {filteredFiles.length === 0 ? (
            <Text style={styles.emptyText}>No files match this filter.</Text>
          ) : selected ? (
            <>
              {selectionFilteredOut && (
                <Text style={styles.selectionNotice}>
                  Selected file is hidden by filters; previewing first match.
                </Text>
              )}
              <DiffFileView file={selected} viewMode={viewMode} fullHeight={fullHeight} />
            </>
          ) : null}
        </View>
      )}
    </View>
  );
}

function findDiffFilePath(files: DiffFileEntry[], requestedPath: string): string | null {
  const normalized = requestedPath.trim();
  if (!normalized) return null;
  return (
    files.find((file) => file.path === normalized)?.path ??
    files.find((file) => file.path.endsWith(`/${normalized}`))?.path ??
    files.find((file) => normalized.endsWith(`/${file.path}`))?.path ??
    null
  );
}

function DiffFileView({
  file,
  viewMode,
  fullHeight,
}: {
  file: DiffFileEntry;
  viewMode: 'unified' | 'compact';
  fullHeight: boolean;
}) {
  const { width } = useWindowDimensions();
  const visibleHunks = useMemo(
    () =>
      file.hunks.map((hunk) => ({
        ...hunk,
        lines: hunk.lines.filter((line) => viewMode === 'unified' || line.type !== 'context'),
      })),
    [file.hunks, viewMode],
  );
  const longestLineLength = visibleHunks.reduce(
    (max, hunk) =>
      Math.max(
        max,
        hunk.header.length,
        ...hunk.lines.map((line) => line.text.length + String(line.oldLine ?? '').length + 6),
      ),
    0,
  );
  const codeMinWidth = Math.max(width - spacing.lg * 2, longestLineLength * 7.2 + 104);

  return (
    <View style={[styles.filePanel, fullHeight && styles.filePanelFull]}>
      <View style={styles.selectedFileHeader}>
        <View style={styles.selectedTitleBlock}>
          <Text style={styles.selectedPath} numberOfLines={2}>
            {file.path}
          </Text>
          <View style={styles.selectedDeltaRow}>
            <Text style={[styles.selectedDeltaBadge, styles.selectedDeltaAdd]}>
              +{file.additions}
            </Text>
            <Text style={[styles.selectedDeltaBadge, styles.selectedDeltaDel]}>
              -{file.deletions}
            </Text>
            <Text style={styles.selectedDeltaMeta}>
              {file.hunks.length} hunk{file.hunks.length === 1 ? '' : 's'}
            </Text>
          </View>
        </View>
      </View>
      <ScrollView
        style={[styles.codeScroll, fullHeight && styles.codeScrollFull]}
        nestedScrollEnabled
      >
        <ScrollView
          horizontal
          nestedScrollEnabled
          showsHorizontalScrollIndicator
          style={styles.codeHorizontalScroll}
          contentContainerStyle={[styles.codeHorizontalContent, { minWidth: codeMinWidth }]}
        >
          <View style={{ minWidth: codeMinWidth }}>
            {visibleHunks.map((hunk, hunkIndex) => (
              <View key={`${hunk.header}-${hunkIndex}`} style={styles.hunkBlock}>
                <Text style={styles.hunkHeader}>{hunk.header}</Text>
                {hunk.lines.map((line, index) => (
                  <DiffLineRow key={`${hunkIndex}-${index}`} line={line} />
                ))}
              </View>
            ))}
          </View>
        </ScrollView>
      </ScrollView>
    </View>
  );
}

function DiffLineRow({ line }: { line: DiffLine }) {
  const toneStyle =
    line.type === 'add'
      ? styles.lineAdd
      : line.type === 'del'
        ? styles.lineDel
        : line.type === 'meta'
          ? styles.lineMeta
          : styles.lineContext;
  const marker =
    line.type === 'add' ? '+' : line.type === 'del' ? '-' : line.type === 'meta' ? '·' : ' ';
  return (
    <View style={[styles.lineRow, toneStyle]}>
      <Text style={styles.lineNumber}>{line.oldLine ?? ''}</Text>
      <Text style={styles.lineNumber}>{line.newLine ?? ''}</Text>
      <Text style={styles.lineMarker}>{marker}</Text>
      <Text style={styles.lineText}>{line.text || ' '}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.bgCard,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.accent + '33',
    overflow: 'hidden',
  },
  containerFull: {
    flex: 1,
  },
  inlineHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    padding: spacing.lg,
    backgroundColor: colors.bgSurface,
  },
  reviewButton: {
    backgroundColor: colors.accent,
    borderRadius: radii.md,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
  },
  reviewButtonText: {
    color: '#fff',
    fontSize: fonts.sizeSm,
    fontWeight: '900',
  },
  evidenceButton: {
    backgroundColor: colors.bgInput,
    borderColor: colors.accent + '66',
    borderRadius: radii.md,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  evidenceButtonText: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    padding: spacing.lg,
    backgroundColor: colors.bgSurface,
  },
  headerText: { flex: 1, minWidth: 0 },
  title: { color: colors.textPrimary, fontSize: fonts.sizeMd, fontWeight: '900' },
  subtitle: { color: colors.textMuted, fontSize: fonts.sizeXs, marginTop: spacing.xs },
  addText: { color: colors.statusOk },
  delText: { color: colors.statusFail },
  modeToggle: { flexDirection: 'row', gap: spacing.xs },
  modeButton: {
    borderWidth: 1,
    borderColor: colors.textMuted + '55',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radii.sm,
  },
  modeButtonActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  modeText: { color: colors.textSecondary, fontSize: fonts.sizeXs, fontWeight: '800' },
  modeTextActive: { color: '#fff' },
  filterWrap: {
    padding: spacing.lg,
    gap: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.bgInput,
  },
  filterChip: {
    borderWidth: 1,
    borderColor: colors.textMuted + '55',
    borderRadius: 999,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    marginRight: spacing.sm,
  },
  filterChipActive: { backgroundColor: colors.accent + '25', borderColor: colors.accent },
  filterText: { color: colors.textMuted, fontSize: fonts.sizeXs, fontWeight: '800' },
  filterTextActive: { color: colors.accent },
  searchInput: {
    backgroundColor: colors.bgInput,
    borderRadius: radii.md,
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  diffBody: { gap: spacing.md, padding: spacing.lg },
  diffBodyFull: { flex: 1 },
  fileNavigator: {
    alignItems: 'center',
    backgroundColor: colors.bgInput,
    borderColor: colors.bgCardHover,
    borderRadius: radii.md,
    borderWidth: 1,
    flexDirection: 'row',
    gap: spacing.sm,
    padding: spacing.sm,
  },
  navButton: {
    backgroundColor: colors.accent + '20',
    borderColor: colors.accent + '55',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  navButtonDisabled: {
    opacity: 0.35,
  },
  navButtonText: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  navCenter: {
    flex: 1,
    minWidth: 0,
  },
  navCount: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  navPath: {
    color: colors.textPrimary,
    fontSize: fonts.sizeXs,
    fontWeight: '800',
    marginTop: 2,
  },
  fileRail: { flexGrow: 0 },
  fileChip: {
    width: 140,
    backgroundColor: colors.bgInput,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.bgInput,
    padding: spacing.md,
    marginRight: spacing.sm,
  },
  fileChipActive: { borderColor: colors.accent, backgroundColor: colors.accent + '18' },
  fileName: { color: colors.textPrimary, fontSize: fonts.sizeXs, fontWeight: '800' },
  fileStats: { color: colors.textMuted, fontSize: fonts.sizeXs, marginTop: spacing.xs },
  selectionNotice: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    marginBottom: spacing.sm,
  },
  filePanel: { backgroundColor: colors.bgSurface, borderRadius: radii.md, overflow: 'hidden' },
  filePanelFull: { flex: 1 },
  selectedFileHeader: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: spacing.sm,
    padding: spacing.md,
  },
  selectedTitleBlock: {
    flex: 1,
    minWidth: 0,
  },
  selectedPath: {
    color: colors.textSecondary,
    fontSize: fonts.sizeXs,
    fontWeight: '800',
  },
  selectedDeltaRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xs,
    marginTop: spacing.sm,
  },
  selectedDeltaBadge: {
    borderRadius: 999,
    fontFamily: 'Menlo',
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    overflow: 'hidden',
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  selectedDeltaAdd: {
    backgroundColor: 'rgba(0, 255, 136, 0.14)',
    color: colors.statusOk,
  },
  selectedDeltaDel: {
    backgroundColor: 'rgba(255, 68, 68, 0.16)',
    color: colors.statusFail,
  },
  selectedDeltaMeta: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '800',
  },
  codeHorizontalScroll: {
    maxHeight: 420,
  },
  codeHorizontalContent: {
    flexGrow: 1,
  },
  codeScroll: { flexGrow: 1, maxHeight: 420 },
  codeScrollFull: { flex: 1, maxHeight: undefined },
  hunkBlock: {
    flexGrow: 1,
  },
  hunkHeader: {
    color: colors.accent,
    backgroundColor: colors.bgCard,
    fontFamily: 'Menlo',
    fontSize: fonts.sizeXs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  lineRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 1,
    paddingHorizontal: spacing.sm,
  },
  lineContext: { backgroundColor: colors.bgSurface },
  lineAdd: { backgroundColor: 'rgba(0, 255, 136, 0.10)' },
  lineDel: { backgroundColor: 'rgba(255, 68, 68, 0.12)' },
  lineMeta: { backgroundColor: colors.bgInput },
  lineNumber: {
    width: 34,
    color: colors.textMuted,
    fontFamily: 'Menlo',
    fontSize: fonts.sizeXs,
    textAlign: 'right',
  },
  lineMarker: {
    width: 18,
    color: colors.textMuted,
    fontFamily: 'Menlo',
    fontSize: fonts.sizeXs,
    textAlign: 'center',
  },
  lineText: {
    flex: 1,
    color: colors.textPrimary,
    fontFamily: 'Menlo',
    fontSize: fonts.sizeXs,
    lineHeight: 16,
  },
  emptyText: { color: colors.textMuted, padding: spacing.lg, fontSize: fonts.sizeSm },
  errorText: { color: colors.statusFail, padding: spacing.lg, fontSize: fonts.sizeSm },
  fullscreenContainer: {
    flex: 1,
    backgroundColor: colors.bgBase,
    paddingHorizontal: spacing.sm,
  },
  fullscreenHeader: {
    alignItems: 'center',
    backgroundColor: colors.bgSurface,
    borderBottomColor: colors.bgCard,
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: spacing.md,
    justifyContent: 'space-between',
    marginHorizontal: -spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  fullscreenTitleBlock: {
    flex: 1,
    minWidth: 0,
  },
  fullscreenEyebrow: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  fullscreenTitle: {
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
    fontWeight: '900',
    marginTop: spacing.xs,
  },
  fullscreenCloseButton: {
    backgroundColor: colors.accent + '22',
    borderColor: colors.accent + '66',
    borderRadius: radii.md,
    borderWidth: 1,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  fullscreenCloseText: {
    color: colors.accent,
    fontSize: fonts.sizeSm,
    fontWeight: '900',
  },
});
