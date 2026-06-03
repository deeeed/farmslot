import { useVideoPlayer, VideoView } from 'expo-video';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Image,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';

import {
  type ArtifactHttpHeaders,
  type ArtifactManifestEntry,
  artifactSource,
  artifactUrlForEntry,
  classifyArtifact,
  formatBytes,
  formatVisualArtifactPairLabel,
  type VisualArtifactPair,
} from '../lib/artifact-url';
import {
  type ArtifactWorkspaceFilter,
  buildArtifactWorkspaceCounts,
  filterArtifactWorkspace,
} from '../lib/artifact-workspace';
import { diffArtifactCandidate } from '../lib/diff';
import { colors, fonts, radii, spacing } from '../lib/theme';

interface EvidenceReviewWorkspaceProps {
  runId: string;
  gatewayUrl: string;
  artifacts: ArtifactManifestEntry[];
  pairs: VisualArtifactPair[];
  onOpenVisual: (uri: string) => void;
  onOpenDocument: (artifact: ArtifactManifestEntry) => void;
  onOpenDiff?: (path: string) => void;
  onOpenArtifactWorkspace?: (artifact: ArtifactManifestEntry) => void;
  onOpenCompareArtifactWorkspace?: (artifact: ArtifactManifestEntry) => void;
  authHeaders?: ArtifactHttpHeaders;
}

type ReviewArtifact = ArtifactManifestEntry & { url: string };

const EVIDENCE_FILTERS: Array<{ id: ArtifactWorkspaceFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'visual', label: 'Visual' },
  { id: 'before', label: 'Before' },
  { id: 'after', label: 'After' },
  { id: 'review', label: 'Review' },
  { id: 'diffs', label: 'Diff' },
  { id: 'recipes', label: 'Recipe' },
  { id: 'supporting', label: 'Setup' },
];

export function EvidenceReviewWorkspace({
  runId,
  gatewayUrl,
  artifacts,
  pairs,
  onOpenVisual,
  onOpenDocument,
  onOpenDiff,
  onOpenArtifactWorkspace,
  onOpenCompareArtifactWorkspace,
  authHeaders,
}: EvidenceReviewWorkspaceProps) {
  const { width } = useWindowDimensions();
  const cardWidth = Math.max(1, Math.min(width - spacing.md * 2, width - spacing.xl * 2));
  const [evidenceFilter, setEvidenceFilter] = useState<ArtifactWorkspaceFilter>('all');
  const artifactCounts = useMemo(() => buildArtifactWorkspaceCounts(artifacts), [artifacts]);
  const filteredArtifacts = useMemo(
    () => filterArtifactWorkspace(artifacts, evidenceFilter, ''),
    [artifacts, evidenceFilter],
  );
  const reviewArtifacts = useMemo(
    () =>
      sortReviewArtifacts(filteredArtifacts).map((artifact) => ({
        ...artifact,
        url: artifactUrlForEntry(gatewayUrl, runId, artifact),
      })),
    [filteredArtifacts, gatewayUrl, runId],
  );
  const visibleEvidenceFilters = useMemo(
    () => EVIDENCE_FILTERS.filter((filter) => filter.id === 'all' || artifactCounts[filter.id] > 0),
    [artifactCounts],
  );

  useEffect(() => {
    if (evidenceFilter !== 'all' && artifactCounts[evidenceFilter] === 0) {
      setEvidenceFilter('all');
    }
  }, [artifactCounts, evidenceFilter]);
  const compareIdentity = useMemo(
    () => pairs.map((pair) => `${pair.before.url}:${pair.after.url}`).join('|'),
    [pairs],
  );
  const [compareIndex, setCompareIndex] = useState(0);
  const compareScrollRef = useRef<ScrollView>(null);
  const compareIndexRef = useRef(compareIndex);

  useEffect(() => {
    compareIndexRef.current = compareIndex;
  }, [compareIndex]);

  useEffect(() => {
    setCompareIndex(0);
    compareIndexRef.current = 0;
    compareScrollRef.current?.scrollTo({ x: 0, animated: false });
  }, [compareIdentity]);

  useEffect(() => {
    const index = Math.min(compareIndexRef.current, Math.max(0, pairs.length - 1));
    compareScrollRef.current?.scrollTo({
      x: index * (cardWidth + spacing.md),
      animated: false,
    });
  }, [cardWidth, pairs.length, compareIdentity]);

  return (
    <View style={styles.workspace}>
      {pairs.length > 0 && (
        <View style={styles.railSection}>
          <RailHeader
            title="Before → After Compare"
            subtitle="Swipe pairs first; tap either side to zoom the exact visual change"
            index={compareIndex}
            total={pairs.length}
          />
          <ScrollView
            ref={compareScrollRef}
            horizontal
            snapToInterval={cardWidth + spacing.md}
            decelerationRate="fast"
            showsHorizontalScrollIndicator={false}
            onMomentumScrollEnd={(event) => {
              setCompareIndex(scrollIndex(event, cardWidth));
            }}
          >
            {pairs.map((pair, index) => (
              <View key={`${pair.before.path}:${pair.after.path}`} style={{ width: cardWidth }}>
                <LargeComparisonCard
                  pair={pair}
                  active={index === compareIndex}
                  onOpenVisual={onOpenVisual}
                  onOpenArtifactWorkspace={
                    onOpenCompareArtifactWorkspace ?? onOpenArtifactWorkspace
                  }
                  authHeaders={authHeaders}
                  style={{ marginRight: spacing.md }}
                />
              </View>
            ))}
          </ScrollView>
        </View>
      )}

      <View style={styles.railSection}>
        <RailHeader
          title="Evidence"
          subtitle="Filter the gate package, then tap a file to inspect it"
          index={0}
          total={reviewArtifacts.length}
          rightLabel={`${reviewArtifacts.length}/${artifacts.length}`}
        />
        <View style={styles.evidenceFilterWrap}>
          {visibleEvidenceFilters.map((filter) => {
            const active = filter.id === evidenceFilter;
            return (
              <Pressable
                key={filter.id}
                style={[styles.evidenceFilterChip, active && styles.evidenceFilterChipActive]}
                onPress={() => setEvidenceFilter(filter.id)}
              >
                <Text
                  style={[styles.evidenceFilterText, active && styles.evidenceFilterTextActive]}
                >
                  {filter.label} {artifactCounts[filter.id]}
                </Text>
              </Pressable>
            );
          })}
        </View>
        <View style={styles.compactEvidenceList}>
          {reviewArtifacts.map((artifact) => (
            <CompactArtifactRow
              key={artifact.path}
              artifact={artifact}
              onOpenVisual={onOpenVisual}
              onOpenDocument={onOpenDocument}
              onOpenDiff={onOpenDiff}
              onOpenArtifactWorkspace={onOpenArtifactWorkspace}
              authHeaders={authHeaders}
            />
          ))}
        </View>
      </View>
    </View>
  );
}

function scrollIndex(event: NativeSyntheticEvent<NativeScrollEvent>, cardWidth: number): number {
  return Math.round(event.nativeEvent.contentOffset.x / (cardWidth + spacing.md));
}

function sortReviewArtifacts(artifacts: ArtifactManifestEntry[]): ArtifactManifestEntry[] {
  const purposeOrder: Record<string, number> = {
    'video-before': 0,
    'video-after': 1,
    screenshot: 2,
    video: 3,
    visual: 4,
    report: 5,
    review: 6,
    recipe: 7,
    learnings: 8,
    script: 9,
  };
  return [...artifacts].sort((a, b) => {
    const purposeDelta = (purposeOrder[a.purpose] ?? 99) - (purposeOrder[b.purpose] ?? 99);
    return purposeDelta !== 0 ? purposeDelta : a.path.localeCompare(b.path);
  });
}

function RailHeader({
  title,
  subtitle,
  index,
  total,
  rightLabel,
}: {
  title: string;
  subtitle: string;
  index: number;
  total: number;
  rightLabel?: string;
}) {
  return (
    <View style={styles.railHeader}>
      <View>
        <Text style={styles.railTitle}>{title}</Text>
        <Text style={styles.railSubtitle}>{subtitle}</Text>
      </View>
      <Text style={styles.railIndex}>
        {rightLabel ?? (total > 0 ? `${Math.min(index + 1, total)}/${total}` : '—')}
      </Text>
    </View>
  );
}

function LargeComparisonCard({
  pair,
  active,
  onOpenVisual,
  onOpenArtifactWorkspace,
  style,
  authHeaders,
}: {
  pair: VisualArtifactPair;
  active: boolean;
  onOpenVisual: (uri: string) => void;
  onOpenArtifactWorkspace?: (artifact: ArtifactManifestEntry) => void;
  style?: object;
  authHeaders?: ArtifactHttpHeaders;
}) {
  const beforeName = artifactDisplayName(pair.before);
  const afterName = artifactDisplayName(pair.after);
  return (
    <View style={[styles.largeCard, style]}>
      <View style={styles.compareCardHeader}>
        <View style={styles.compareTitleBlock}>
          <Text style={styles.compareEyebrow}>Visual difference</Text>
          <Text style={styles.largeCardTitle} numberOfLines={1}>
            {comparisonStem(pair)}
          </Text>
        </View>
        <View style={styles.compareArrowBadge}>
          <Text style={styles.compareArrowText}>BEFORE → AFTER</Text>
        </View>
      </View>
      <View style={styles.compareRow}>
        <ComparePane
          label="Before"
          item={pair.before}
          active={active}
          onOpenVisual={onOpenVisual}
          onOpenArtifactWorkspace={onOpenArtifactWorkspace}
          authHeaders={authHeaders}
        />
        <ComparePane
          label="After"
          item={pair.after}
          active={active}
          onOpenVisual={onOpenVisual}
          onOpenArtifactWorkspace={onOpenArtifactWorkspace}
          authHeaders={authHeaders}
        />
      </View>
      <View style={styles.deltaChecklist}>
        <Text style={styles.deltaChecklistLabel}>Identify before vs after</Text>
        <Text style={styles.deltaChecklistText} numberOfLines={1}>
          {beforeName} → {afterName}
        </Text>
        <Text style={styles.deltaChecklistHint}>
          Confirm the visible delta before approving, retrying, or dispatching follow-up work.
        </Text>
      </View>
    </View>
  );
}

function ComparePane({
  label,
  item,
  active,
  onOpenVisual,
  onOpenArtifactWorkspace,
  authHeaders,
}: {
  label: string;
  item: VisualArtifactPair['before'];
  active: boolean;
  onOpenVisual: (uri: string) => void;
  onOpenArtifactWorkspace?: (artifact: ArtifactManifestEntry) => void;
  authHeaders?: ArtifactHttpHeaders;
}) {
  return (
    <View
      style={[
        styles.comparePane,
        label === 'Before' ? styles.comparePaneBefore : styles.comparePaneAfter,
      ]}
    >
      <Text
        style={[styles.compareLabel, label === 'Before' ? styles.beforeLabel : styles.afterLabel]}
      >
        {label}
      </Text>
      <EvidenceMedia
        artifact={item}
        height={210}
        active={active}
        onOpenVisual={onOpenVisual}
        authHeaders={authHeaders}
      />
      <Text style={styles.pathText} numberOfLines={1}>
        {item.path.split('/').pop() ?? item.path}
      </Text>
      {onOpenArtifactWorkspace ? (
        <Pressable
          style={styles.compareArtifactButton}
          onPress={() => onOpenArtifactWorkspace(item)}
        >
          <Text style={styles.compareArtifactText}>{label} artifacts</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function CompactArtifactRow({
  artifact,
  onOpenVisual,
  onOpenDocument,
  onOpenDiff,
  onOpenArtifactWorkspace,
  authHeaders,
}: {
  artifact: ReviewArtifact;
  onOpenVisual: (uri: string) => void;
  onOpenDocument: (artifact: ArtifactManifestEntry) => void;
  onOpenDiff?: (path: string) => void;
  onOpenArtifactWorkspace?: (artifact: ArtifactManifestEntry) => void;
  authHeaders?: ArtifactHttpHeaders;
}) {
  const mediaType = classifyArtifact(artifact);
  const isDiffArtifact = diffArtifactCandidate([artifact])?.path === artifact.path;
  const typeLabel = isDiffArtifact ? 'diff' : mediaType === 'other' ? artifact.purpose : mediaType;
  const openArtifact = () => {
    if (mediaType === 'image' || mediaType === 'video') {
      onOpenVisual(artifact.url);
      return;
    }
    if (isDiffArtifact && onOpenDiff) {
      onOpenDiff(artifact.path);
      return;
    }
    if (mediaType === 'document') {
      onOpenDocument(artifact);
      return;
    }
    if (onOpenArtifactWorkspace) {
      onOpenArtifactWorkspace(artifact);
      return;
    }
    onOpenDocument(artifact);
  };

  return (
    <Pressable style={styles.compactArtifactRow} onPress={openArtifact}>
      <CompactArtifactPreview
        artifact={artifact}
        mediaType={mediaType}
        isDiffArtifact={isDiffArtifact}
        authHeaders={authHeaders}
      />
      <View style={styles.compactArtifactBody}>
        <View style={styles.compactArtifactTitleRow}>
          <Text style={styles.compactArtifactTitle} numberOfLines={1}>
            {artifactDisplayName(artifact)}
          </Text>
          <Text style={styles.compactArtifactType}>{typeLabel}</Text>
        </View>
        <Text style={styles.compactArtifactPath} numberOfLines={1}>
          {artifact.path}
        </Text>
        <View style={styles.compactArtifactMetaRow}>
          <Text style={styles.compactArtifactMeta} numberOfLines={1}>
            {artifact.sourceLabel ?? artifact.purpose}
          </Text>
          {artifact.sizeBytes != null && artifact.sizeBytes > 0 ? (
            <Text style={styles.compactArtifactMeta}>{formatBytes(artifact.sizeBytes)}</Text>
          ) : null}
        </View>
      </View>
      <Text style={styles.compactArtifactOpen}>Open</Text>
    </Pressable>
  );
}

function CompactArtifactPreview({
  artifact,
  mediaType,
  isDiffArtifact,
  authHeaders,
}: {
  artifact: ReviewArtifact;
  mediaType: ReturnType<typeof classifyArtifact>;
  isDiffArtifact: boolean;
  authHeaders?: ArtifactHttpHeaders;
}) {
  if (mediaType === 'image') {
    return (
      <Image
        source={artifactSource(artifact.url, authHeaders)}
        style={styles.compactArtifactImage}
        resizeMode="cover"
      />
    );
  }
  const label = isDiffArtifact
    ? 'DIFF'
    : mediaType === 'video'
      ? 'VID'
      : mediaType === 'document'
        ? documentArtifactLabel(artifact)
        : 'FILE';
  return (
    <View style={styles.compactArtifactIconBox}>
      <Text style={styles.compactArtifactIconText}>{label}</Text>
    </View>
  );
}

function documentArtifactLabel(artifact: ArtifactManifestEntry): string {
  const lowerPath = artifact.path.toLowerCase();
  if (lowerPath.endsWith('.json')) return 'JSON';
  if (lowerPath.endsWith('.md')) return 'MD';
  if (lowerPath.endsWith('.txt')) return 'TXT';
  return 'DOC';
}

function EvidenceMedia({
  artifact,
  height,
  active,
  onOpenVisual,
  onOpenDocument,
  onOpenDiff,
  authHeaders,
}: {
  artifact: ReviewArtifact;
  height: number;
  active: boolean;
  onOpenVisual: (uri: string) => void;
  onOpenDocument?: (artifact: ReviewArtifact) => void;
  onOpenDiff?: (path: string) => void;
  authHeaders?: ArtifactHttpHeaders;
}) {
  const mediaType = classifyArtifact(artifact);
  const isDiffArtifact = diffArtifactCandidate([artifact])?.path === artifact.path;
  if (mediaType === 'image') {
    return (
      <Pressable onPress={() => onOpenVisual(artifact.url)}>
        <Image
          source={artifactSource(artifact.url, authHeaders)}
          style={[styles.media, { height }]}
          resizeMode="contain"
        />
      </Pressable>
    );
  }
  if (mediaType === 'video') {
    if (!active) {
      return (
        <Pressable
          style={[styles.documentPane, { height }]}
          onPress={() => onOpenVisual(artifact.url)}
        >
          <Text style={styles.documentIcon}>VIDEO</Text>
          <Text style={styles.documentHint}>Swipe here to preview or tap to open</Text>
        </Pressable>
      );
    }
    // Mount the video player only for the active carousel card so background
    // videos do not keep decoding or playing while the operator swipes. The
    // inactive branch above unmounts EvidenceVideo, which is the pause/stop
    // mechanism and intentionally resets playback on swipe; keep it covered by
    // manual device QA when changing carousel/player behavior.
    return (
      <EvidenceVideo
        url={artifact.url}
        height={height}
        authHeaders={authHeaders}
        onOpen={() => onOpenVisual(artifact.url)}
      />
    );
  }
  if (mediaType === 'document') {
    return (
      <Pressable
        style={[styles.documentPane, { height }]}
        onPress={() => (isDiffArtifact ? onOpenDiff?.(artifact.path) : onOpenDocument?.(artifact))}
      >
        <Text style={styles.documentIcon}>{isDiffArtifact ? 'DIFF' : 'DOC'}</Text>
        <Text style={styles.documentHint}>
          {isDiffArtifact ? 'Tap to review diff' : 'Tap to read'}
        </Text>
      </Pressable>
    );
  }
  return (
    <View style={[styles.documentPane, { height }]}>
      <Text style={styles.documentIcon}>FILE</Text>
    </View>
  );
}

function EvidenceVideo({
  url,
  height,
  onOpen,
  authHeaders,
}: {
  url: string;
  height: number;
  onOpen: () => void;
  authHeaders?: ArtifactHttpHeaders;
}) {
  const source = React.useMemo(() => artifactSource(url, authHeaders), [authHeaders, url]);
  const player = useVideoPlayer(source);
  return (
    <View>
      <VideoView
        player={player}
        style={[styles.media, { height }]}
        nativeControls
        fullscreenOptions={{ enable: true }}
        contentFit="contain"
      />
      <Pressable style={styles.videoOpenButton} onPress={onOpen}>
        <Text style={styles.videoOpenText}>Open</Text>
      </Pressable>
    </View>
  );
}

function comparisonStem(pair: VisualArtifactPair): string {
  return formatVisualArtifactPairLabel(pair);
}

function artifactDisplayName(artifact: ArtifactManifestEntry): string {
  return artifact.label?.trim() || artifact.path.split('/').pop() || artifact.path;
}

const styles = StyleSheet.create({
  workspace: {
    gap: spacing.lg,
  },
  railSection: {
    gap: spacing.md,
  },
  railHeader: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  railTitle: {
    color: colors.textPrimary,
    fontSize: fonts.sizeMd,
    fontWeight: '800',
  },
  railSubtitle: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    marginTop: spacing.xs,
  },
  railIndex: {
    color: colors.accent,
    fontSize: fonts.sizeSm,
    fontWeight: '800',
  },
  largeCard: {
    backgroundColor: colors.bgCard,
    borderRadius: radii.lg,
    padding: spacing.lg,
  },
  largeCardTitle: {
    color: colors.textPrimary,
    fontSize: fonts.sizeMd,
    fontWeight: '800',
  },
  compareCardHeader: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: spacing.md,
    justifyContent: 'space-between',
    marginBottom: spacing.md,
  },
  compareTitleBlock: { flex: 1 },
  compareEyebrow: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    letterSpacing: 0.8,
    marginBottom: spacing.xs,
    textTransform: 'uppercase',
  },
  compareArrowBadge: {
    backgroundColor: colors.accent + '18',
    borderColor: colors.accent + '66',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  compareArrowText: {
    color: colors.accent,
    fontSize: 10,
    fontWeight: '900',
  },
  compareRow: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  deltaChecklist: {
    backgroundColor: colors.bgInput,
    borderColor: colors.accent + '33',
    borderRadius: radii.md,
    borderWidth: 1,
    gap: spacing.xs,
    marginTop: spacing.md,
    padding: spacing.sm,
  },
  deltaChecklistLabel: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  deltaChecklistText: {
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
    fontWeight: '900',
  },
  deltaChecklistHint: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    lineHeight: 16,
  },
  comparePane: {
    borderRadius: radii.md,
    borderWidth: 1,
    flex: 1,
    padding: spacing.xs,
  },
  comparePaneBefore: { borderColor: colors.statusWarn + '66' },
  comparePaneAfter: { borderColor: colors.statusOk + '66' },
  compareLabel: {
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    marginBottom: spacing.xs,
    textTransform: 'uppercase',
  },
  beforeLabel: { color: colors.statusWarn },
  afterLabel: { color: colors.statusOk },
  compareArtifactButton: {
    alignItems: 'center',
    backgroundColor: colors.accent + '18',
    borderColor: colors.accent + '55',
    borderRadius: 999,
    borderWidth: 1,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  compareArtifactText: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  media: {
    width: '100%',
    backgroundColor: colors.bgInput,
    borderRadius: radii.md,
  },
  videoOpenButton: {
    position: 'absolute',
    top: spacing.md,
    right: spacing.md,
    backgroundColor: 'rgba(0,0,0,0.62)',
    borderRadius: 999,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  videoOpenText: {
    color: '#fff',
    fontSize: fonts.sizeXs,
    fontWeight: '800',
  },
  documentPane: {
    width: '100%',
    backgroundColor: colors.bgInput,
    borderRadius: radii.md,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  documentIcon: {
    color: colors.textPrimary,
    fontSize: fonts.sizeLg,
    fontWeight: '900',
    letterSpacing: 1,
  },
  documentHint: {
    color: colors.textMuted,
    fontSize: fonts.sizeSm,
  },
  compactEvidenceList: {
    gap: spacing.sm,
  },
  evidenceFilterWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  evidenceFilterChip: {
    backgroundColor: colors.bgInput,
    borderColor: colors.accent + '24',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  evidenceFilterChipActive: {
    backgroundColor: colors.accent + '22',
    borderColor: colors.accent,
  },
  evidenceFilterText: {
    color: colors.textSecondary,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  evidenceFilterTextActive: {
    color: colors.accentHover,
  },
  compactArtifactRow: {
    alignItems: 'center',
    backgroundColor: colors.bgCard,
    borderColor: colors.accent + '24',
    borderRadius: radii.lg,
    borderWidth: 1,
    flexDirection: 'row',
    gap: spacing.md,
    minHeight: 74,
    padding: spacing.md,
  },
  compactArtifactImage: {
    backgroundColor: colors.bgInput,
    borderColor: colors.accent + '24',
    borderRadius: radii.md,
    borderWidth: 1,
    height: 54,
    width: 64,
  },
  compactArtifactIconBox: {
    alignItems: 'center',
    backgroundColor: colors.bgInput,
    borderColor: colors.accent + '24',
    borderRadius: radii.md,
    borderWidth: 1,
    height: 54,
    justifyContent: 'center',
    width: 64,
  },
  compactArtifactIconText: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    letterSpacing: 0.6,
  },
  compactArtifactBody: {
    flex: 1,
    gap: spacing.xs,
    minWidth: 0,
  },
  compactArtifactTitleRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
  },
  compactArtifactTitle: {
    color: colors.textPrimary,
    flex: 1,
    fontSize: fonts.sizeSm,
    fontWeight: '900',
  },
  compactArtifactType: {
    color: colors.accent,
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  compactArtifactPath: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
  },
  compactArtifactMetaRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
  },
  compactArtifactMeta: {
    color: colors.textMuted,
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  compactArtifactOpen: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  pathText: {
    color: colors.textMuted,
    flex: 1,
    fontSize: fonts.sizeXs,
    marginTop: spacing.sm,
  },
});
