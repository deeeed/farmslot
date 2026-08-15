import { useVideoPlayer, VideoView } from 'expo-video';
import React, { useEffect, useRef, useState } from 'react';
import {
  Image,
  type LayoutChangeEvent,
  Modal,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  type ArtifactHttpHeaders,
  type ArtifactManifestEntry,
  artifactSource,
  classifyArtifact,
  formatVisualArtifactPairLabel,
  type VisualArtifactPair,
} from '../lib/artifact-url';
import { colors, fonts, radii, spacing } from '../lib/theme';

type CompareSide = 'before' | 'after';

interface BeforeAfterPreviewProps<T extends ArtifactManifestEntry = ArtifactManifestEntry> {
  pair: VisualArtifactPair<T>;
  authHeaders?: ArtifactHttpHeaders;
  onOpenArtifact?: (artifactPath: string) => void;
  onOpenBefore?: () => void;
  onOpenAfter?: () => void;
  title?: string;
  eyebrow?: string;
  hint?: string;
  imageHeight?: number;
  allowFullscreen?: boolean;
  initialSide?: CompareSide;
  testIdPrefix?: string;
  playVideo?: boolean;
}

/** Shared Companion renderer for every before/after evidence pair. */
export function BeforeAfterPreview<T extends ArtifactManifestEntry = ArtifactManifestEntry>({
  pair,
  authHeaders,
  onOpenArtifact,
  onOpenBefore,
  onOpenAfter,
  title = 'Before → After delta',
  eyebrow = 'Required comparison',
  hint = 'Swipe to compare',
  imageHeight = 120,
  allowFullscreen = true,
  initialSide = 'before',
  testIdPrefix,
  playVideo = false,
}: BeforeAfterPreviewProps<T>) {
  const { height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const fullscreenTopInset = Math.max(
    insets.top,
    Platform.OS === 'ios' ? 54 : (StatusBar.currentHeight ?? 0),
  );
  const fullscreenBottomInset = Math.max(insets.bottom, Platform.OS === 'ios' ? 10 : 0);
  const scrollRef = useRef<ScrollView>(null);
  const [side, setSide] = useState<CompareSide>(initialSide);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [fullscreenOpen, setFullscreenOpen] = useState(false);
  const comparisonLabel = formatVisualArtifactPairLabel(pair);
  const pairIdentity = `${pair.before.path}:${pair.after.path}`;
  const resolvedTestIdPrefix =
    testIdPrefix ?? `companion-before-after-${stableTestIdSuffix(pairIdentity)}`;

  useEffect(() => {
    setSide(initialSide);
    scrollRef.current?.scrollTo({
      x: initialSide === 'after' ? viewportWidth : 0,
      animated: false,
    });
  }, [initialSide, pairIdentity]);

  const selectSide = (nextSide: CompareSide) => {
    setSide(nextSide);
    scrollRef.current?.scrollTo({
      x: nextSide === 'after' ? viewportWidth : 0,
      animated: true,
    });
  };

  const openSide = (target: CompareSide) => {
    setSide(target);
    if (allowFullscreen) {
      setFullscreenOpen(true);
      return;
    }
    const artifact = target === 'before' ? pair.before : pair.after;
    const callback = target === 'before' ? onOpenBefore : onOpenAfter;
    if (callback) callback();
    else onOpenArtifact?.(artifact.path);
  };

  const handleLayout = (event: LayoutChangeEvent) => {
    const width = event.nativeEvent.layout.width;
    setViewportWidth(width);
    if (side === 'after') {
      requestAnimationFrame(() => scrollRef.current?.scrollTo({ x: width, animated: false }));
    }
  };

  const handleScrollEnd = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (viewportWidth <= 0) return;
    setSide(event.nativeEvent.contentOffset.x >= viewportWidth / 2 ? 'after' : 'before');
  };

  const dismissFullscreenThen = (open?: () => void) => {
    setFullscreenOpen(false);
    if (open) requestAnimationFrame(open);
  };

  return (
    <View style={styles.card} testID={`${resolvedTestIdPrefix}-preview`}>
      <View style={styles.header}>
        <View style={styles.titleBlock}>
          <Text style={styles.eyebrow}>{eyebrow}</Text>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.target} numberOfLines={1}>
            {comparisonLabel}
          </Text>
        </View>
        <Text style={styles.hint}>{hint}</Text>
      </View>

      <View style={styles.segmentedControl} accessibilityRole="tablist">
        <SideTab
          side="before"
          selected={side === 'before'}
          onPress={() => selectSide('before')}
          testIdPrefix={resolvedTestIdPrefix}
        />
        <SideTab
          side="after"
          selected={side === 'after'}
          onPress={() => selectSide('after')}
          testIdPrefix={resolvedTestIdPrefix}
        />
      </View>

      <View style={styles.viewport} onLayout={handleLayout}>
        {viewportWidth > 0 ? (
          <ScrollView
            ref={scrollRef}
            horizontal
            pagingEnabled
            nestedScrollEnabled
            showsHorizontalScrollIndicator={false}
            onMomentumScrollEnd={handleScrollEnd}
            onScrollEndDrag={handleScrollEnd}
          >
            <ComparePage
              side="before"
              artifact={pair.before}
              width={viewportWidth}
              imageHeight={imageHeight}
              authHeaders={authHeaders}
              active={playVideo && side === 'before'}
              onOpen={() => openSide('before')}
              openLabel={allowFullscreen ? 'Fullscreen' : 'Open file'}
              testIdPrefix={resolvedTestIdPrefix}
            />
            <ComparePage
              side="after"
              artifact={pair.after}
              width={viewportWidth}
              imageHeight={imageHeight}
              authHeaders={authHeaders}
              active={playVideo && side === 'after'}
              onOpen={() => openSide('after')}
              openLabel={allowFullscreen ? 'Fullscreen' : 'Open file'}
              testIdPrefix={resolvedTestIdPrefix}
            />
          </ScrollView>
        ) : (
          <View style={{ height: imageHeight }} />
        )}
      </View>

      <View style={styles.swipeHint}>
        <Text style={styles.swipeArrow}>‹</Text>
        <Text style={styles.swipeText}>
          {side === 'before' ? 'Before' : 'After'} · swipe ·{' '}
          {allowFullscreen ? 'tap for fullscreen' : 'tap to open file'}
        </Text>
        <Text style={styles.swipeArrow}>›</Text>
      </View>

      {allowFullscreen && fullscreenOpen ? (
        <Modal
          visible={fullscreenOpen}
          animationType="fade"
          presentationStyle="fullScreen"
          onRequestClose={() => setFullscreenOpen(false)}
        >
          <View
            style={[
              styles.fullscreen,
              { paddingTop: fullscreenTopInset, paddingBottom: fullscreenBottomInset },
            ]}
            testID={`${resolvedTestIdPrefix}-fullscreen`}
          >
            <View style={styles.fullscreenHeader}>
              <View style={styles.fullscreenTitleBlock}>
                <Text style={styles.fullscreenEyebrow}>Before / After comparison</Text>
                <Text style={styles.fullscreenTitle} numberOfLines={1}>
                  {comparisonLabel}
                </Text>
              </View>
              <Pressable
                style={styles.closeButton}
                onPress={() => setFullscreenOpen(false)}
                testID={`${resolvedTestIdPrefix}-close`}
                accessibilityRole="button"
                accessibilityLabel="Close before after comparison"
              >
                <Text style={styles.closeButtonText}>Close</Text>
              </Pressable>
            </View>
            <ScrollView
              style={styles.fullscreenBody}
              contentContainerStyle={styles.fullscreenBodyContent}
            >
              <BeforeAfterPreview
                pair={pair}
                authHeaders={authHeaders}
                onOpenArtifact={(artifactPath) =>
                  dismissFullscreenThen(() => onOpenArtifact?.(artifactPath))
                }
                onOpenBefore={onOpenBefore ? () => dismissFullscreenThen(onOpenBefore) : undefined}
                onOpenAfter={onOpenAfter ? () => dismissFullscreenThen(onOpenAfter) : undefined}
                title={title}
                eyebrow={eyebrow}
                hint="Swipe left or right"
                imageHeight={Math.max(
                  120,
                  windowHeight - fullscreenTopInset - fullscreenBottomInset - 220,
                )}
                allowFullscreen={false}
                playVideo
                initialSide={side}
                testIdPrefix={`${resolvedTestIdPrefix}-fullscreen-page`}
              />
            </ScrollView>
          </View>
        </Modal>
      ) : null}
    </View>
  );
}

function stableTestIdSuffix(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function SideTab({
  side,
  selected,
  onPress,
  testIdPrefix,
}: {
  side: CompareSide;
  selected: boolean;
  onPress: () => void;
  testIdPrefix: string;
}) {
  const before = side === 'before';
  const tone = before ? colors.statusWarn : colors.statusOk;
  return (
    <Pressable
      style={[styles.sideTab, selected && { backgroundColor: tone + '22', borderColor: tone }]}
      onPress={onPress}
      testID={`${testIdPrefix}-tab-${side}`}
      accessibilityRole="tab"
      accessibilityState={{ selected }}
      accessibilityLabel={`Show ${side} evidence`}
    >
      <Text style={[styles.sideTabText, { color: selected ? tone : colors.textMuted }]}>
        {before ? 'Before' : 'After'}
      </Text>
      <View
        style={[styles.sideDot, { backgroundColor: tone }]}
        testID={selected ? `${testIdPrefix}-selected-${side}` : undefined}
      />
    </Pressable>
  );
}

function ComparePage<T extends ArtifactManifestEntry>({
  side,
  artifact,
  width,
  imageHeight,
  authHeaders,
  active,
  onOpen,
  openLabel,
  testIdPrefix,
}: {
  side: CompareSide;
  artifact: T & { url: string };
  width: number;
  imageHeight: number;
  authHeaders?: ArtifactHttpHeaders;
  active: boolean;
  onOpen: () => void;
  openLabel: string;
  testIdPrefix: string;
}) {
  const tone = side === 'before' ? colors.statusWarn : colors.statusOk;
  return (
    <Pressable
      style={[styles.page, { borderColor: tone + '66', width }]}
      onPress={onOpen}
      testID={`${testIdPrefix}-${side}`}
      accessibilityRole="button"
      accessibilityLabel={`Open ${side} artifact ${artifact.path}`}
    >
      <CompareMedia
        artifact={artifact}
        authHeaders={authHeaders}
        height={imageHeight}
        active={active}
      />
      <View style={styles.pageFooter}>
        <Text style={[styles.pageLabel, { color: tone }]}>{side}</Text>
        <Text style={styles.path} numberOfLines={1}>
          {artifact.path.split('/').pop() ?? artifact.path}
        </Text>
        <Text style={styles.openLabel}>{openLabel}</Text>
      </View>
    </Pressable>
  );
}

function CompareMedia<T extends ArtifactManifestEntry>({
  artifact,
  authHeaders,
  height,
  active,
}: {
  artifact: T & { url: string };
  authHeaders?: ArtifactHttpHeaders;
  height: number;
  active: boolean;
}) {
  const mediaType = classifyArtifact(artifact);
  if (mediaType === 'video') {
    return active ? (
      <ComparisonVideo artifact={artifact} authHeaders={authHeaders} height={height} />
    ) : (
      <View style={[styles.document, { height }]}>
        <Text style={styles.documentKind}>VIDEO</Text>
      </View>
    );
  }
  if (mediaType === 'image') {
    return (
      <Image
        source={artifactSource(artifact.url, authHeaders)}
        style={[styles.media, { height }]}
        resizeMode="contain"
      />
    );
  }
  return (
    <View style={[styles.document, { height }]}>
      <Text style={styles.documentKind}>{mediaType.toUpperCase()}</Text>
    </View>
  );
}

function ComparisonVideo<T extends ArtifactManifestEntry>({
  artifact,
  authHeaders,
  height,
}: {
  artifact: T & { url: string };
  authHeaders?: ArtifactHttpHeaders;
  height: number;
}) {
  const source = React.useMemo(
    () => artifactSource(artifact.url, authHeaders),
    [artifact.url, authHeaders],
  );
  const player = useVideoPlayer(source);
  return (
    <VideoView
      player={player}
      style={[styles.media, { height }]}
      nativeControls
      fullscreenOptions={{ enable: true }}
      contentFit="contain"
    />
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.bgInput,
    borderColor: colors.accent + '33',
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.sm,
    overflow: 'hidden',
    padding: spacing.sm,
  },
  header: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: spacing.md,
    justifyContent: 'space-between',
  },
  titleBlock: { flex: 1 },
  eyebrow: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  title: {
    color: colors.textPrimary,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    marginTop: 2,
    textTransform: 'uppercase',
  },
  target: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '800',
    marginTop: 2,
  },
  hint: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '800',
  },
  segmentedControl: {
    backgroundColor: colors.bgCard,
    borderRadius: radii.md,
    flexDirection: 'row',
    padding: 3,
  },
  sideTab: {
    alignItems: 'center',
    borderColor: 'transparent',
    borderRadius: radii.sm,
    borderWidth: 1,
    flex: 1,
    flexDirection: 'row',
    gap: spacing.xs,
    justifyContent: 'center',
    minHeight: 32,
    paddingHorizontal: spacing.sm,
  },
  sideTabText: {
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  sideDot: { borderRadius: 999, height: 5, width: 5 },
  viewport: {
    borderRadius: radii.md,
    overflow: 'hidden',
    width: '100%',
  },
  page: {
    backgroundColor: colors.bgCard,
    borderRadius: radii.md,
    borderWidth: 1,
    overflow: 'hidden',
  },
  media: {
    backgroundColor: colors.bgInput,
    width: '100%',
  },
  document: {
    alignItems: 'center',
    backgroundColor: colors.bgInput,
    justifyContent: 'center',
    width: '100%',
  },
  documentKind: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  pageFooter: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    padding: spacing.sm,
  },
  pageLabel: {
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  path: {
    color: colors.textMuted,
    flex: 1,
    fontSize: fonts.sizeXs,
  },
  openLabel: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  swipeHint: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.sm,
  },
  swipeArrow: {
    color: colors.accent,
    fontSize: fonts.sizeMd,
    fontWeight: '900',
  },
  swipeText: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '800',
  },
  fullscreen: {
    backgroundColor: colors.bgBase,
    flex: 1,
    gap: spacing.md,
    padding: spacing.md,
  },
  fullscreenHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    justifyContent: 'space-between',
  },
  fullscreenBody: { flex: 1 },
  fullscreenBodyContent: { flexGrow: 1 },
  fullscreenTitleBlock: { flex: 1 },
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
    marginTop: 2,
  },
  closeButton: {
    backgroundColor: colors.accent + '22',
    borderColor: colors.accent + '66',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  closeButtonText: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
});
