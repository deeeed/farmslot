import { useVideoPlayer, VideoView } from 'expo-video';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  type EvidenceReviewModel,
  type EvidenceReviewPlaybackEffect,
  formatEvidenceReviewVideoTime,
  loadRecordingEvidenceReview,
} from '@farmslot/adapter-sdk/evidence';
import type { SharedRunArtifactSelection } from '@farmslot/protocol/surfaces/view-links';

import { QuickActionsModal as Modal } from '../features/quick-actions/QuickActionsModal';
import {
  type ArtifactHttpHeaders,
  type ArtifactMediaType,
  artifactSource,
  classifyArtifact,
} from '../lib/artifact-url';
import {
  evidenceClaimPlayback,
  evidenceRecordingForPath,
  mediaShareView,
} from '../lib/evidence-media-items';
import { gatewayFetch } from '../lib/gateway-http-auth';
import {
  TEXT_PREVIEW_MAX_BYTES,
  TEXT_PREVIEW_RANGE,
  textPreviewChunks,
  textPreviewTotalBytes,
} from '../lib/text-preview';
import { colors, fonts } from '../lib/theme';
import { videoSourceLoadDurationMs } from '../lib/video-source-load';

import { ArtifactImage } from './ArtifactImage';
import { type EvidenceAcceptanceReview, EvidenceAcOverlay } from './EvidenceAcOverlay';

export interface MediaViewerItem {
  uri: string;
  title?: string;
  /** Second caption line, e.g. the verdict of the criterion this evidence proves. */
  detail?: string;
  /** `document` renders the file as text. */
  mediaType?: ArtifactMediaType;
  authHeaders?: ArtifactHttpHeaders;
  path?: string;
  sha256?: string;
  timelinePath?: string;
  resolveArtifactUrl?: (path: string) => string;
  evidenceModel?: EvidenceReviewModel;
  initialTraceIndex?: number;
  sharedArtifact?: SharedRunArtifactSelection;
}

interface MediaViewerProps {
  visible: boolean;
  uri: string | null;
  items?: MediaViewerItem[];
  initialIndex?: number;
  onClose: () => void;
  authHeaders?: ArtifactHttpHeaders;
  testID?: string;
  /**
   * The run's criteria over a recording, to move between and judge. Read live, unlike the
   * items the viewer keeps while open: verdicts must show, and act on, the current evidence.
   */
  acceptance?: EvidenceAcceptanceReview;
}

export function MediaViewer({
  visible,
  uri,
  items,
  initialIndex = 0,
  onClose,
  authHeaders,
  testID,
  acceptance,
}: MediaViewerProps) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const topInset = Math.max(
    insets.top,
    Platform.OS === 'ios' ? 54 : (StatusBar.currentHeight ?? 0),
  );
  const bottomInset = Math.max(insets.bottom, Platform.OS === 'ios' ? 10 : 0);
  const scrollRef = useRef<ScrollView>(null);
  const suppliedItems: MediaViewerItem[] = items?.length
    ? items
    : uri
      ? [{ uri, authHeaders }]
      : [];
  const proof = suppliedItems.find((item) => item.uri === uri)?.evidenceModel?.selection;
  const proofPaths = proof ? new Set(proof.artifacts.map((file) => file.artifactPath)) : null;
  const openingItems = proofPaths
    ? suppliedItems.filter((item) => item.path && proofPaths.has(item.path))
    : suppliedItems;
  const session = useRef({ visible: false, uri, items: openingItems });
  // Background metadata refreshes cannot replace the package being reviewed.
  if (visible && (!session.current.visible || session.current.uri !== uri))
    session.current = { visible, uri, items: openingItems };
  session.current.visible = visible;
  const viewerItems = visible ? session.current.items : suppliedItems;
  const requestedIndex = uri ? viewerItems.findIndex((item) => item.uri === uri) : initialIndex;
  const clampedInitialIndex = Math.max(
    0,
    Math.min(requestedIndex >= 0 ? requestedIndex : initialIndex, viewerItems.length - 1),
  );
  const [currentIndex, setCurrentIndex] = useState(clampedInitialIndex);
  const [zoomedUri, setZoomedUri] = useState<string | null>(null);
  const [changedVideoItems, setChangedVideoItems] = useState<ReadonlySet<string>>(() => new Set());
  const markVideoSelectionChanged = useCallback((uri: string) => {
    setChangedVideoItems((previous) => (previous.has(uri) ? previous : new Set(previous).add(uri)));
  }, []);
  useEffect(() => {
    if (!visible) setChangedVideoItems(new Set());
  }, [visible]);

  useEffect(() => {
    if (!visible || viewerItems.length === 0) return;
    setCurrentIndex(clampedInitialIndex);
    setZoomedUri(null);
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ x: clampedInitialIndex * width, animated: false });
    });
  }, [clampedInitialIndex, visible, viewerItems.length, width]);

  if (!visible || viewerItems.length === 0) return null;

  const goToIndex = (nextIndex: number) => {
    const next = Math.max(0, Math.min(nextIndex, viewerItems.length - 1));
    setCurrentIndex(next);
    setZoomedUri(null);
    scrollRef.current?.scrollTo({ x: next * width, animated: true });
  };

  const current = viewerItems[currentIndex];
  const mediaHeight = Math.max(180, height - topInset - bottomInset - 140);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      sharedView={mediaShareView(
        current?.sharedArtifact,
        Boolean(current && changedVideoItems.has(current.uri)),
      )}
    >
      <GestureHandlerRootView style={styles.modalRoot}>
        <SafeAreaView style={styles.backdrop} testID={testID}>
          <ScrollView
            ref={scrollRef}
            horizontal
            pagingEnabled
            scrollEnabled={!zoomedUri}
            showsHorizontalScrollIndicator={false}
            onMomentumScrollEnd={(event) => {
              setCurrentIndex(Math.round(event.nativeEvent.contentOffset.x / width));
              setZoomedUri(null);
            }}
          >
            {viewerItems.map((item, index) => (
              <View key={item.uri} style={[styles.slide, { width }]}>
                <MediaSlide
                  isActive={currentIndex === index}
                  item={{ ...item, authHeaders: item.authHeaders ?? authHeaders }}
                  width={width}
                  height={mediaHeight}
                  panEnabled={zoomedUri === item.uri}
                  onZoomChange={(zoomed) => setZoomedUri(zoomed ? item.uri : null)}
                  onViewSelectionChange={markVideoSelectionChanged}
                  acceptance={acceptance}
                />
              </View>
            ))}
          </ScrollView>
          <View style={[styles.captionBar, { top: topInset + 12 }]} pointerEvents="box-none">
            <Text
              style={styles.captionText}
              numberOfLines={current?.evidenceModel?.selection?.claimId ? undefined : 1}
              testID={testID ? `${testID}-title` : undefined}
            >
              {current?.title ?? 'Evidence'}
            </Text>
            {current?.detail ? (
              <Text
                style={styles.detailText}
                numberOfLines={2}
                testID={testID ? `${testID}-detail` : undefined}
              >
                {current.detail}
              </Text>
            ) : null}
            <Text style={styles.indexText} testID={testID ? `${testID}-index` : undefined}>
              {currentIndex + 1}/{viewerItems.length}
            </Text>
          </View>
          {viewerItems.length > 1 && (
            <View style={[styles.navBar, { bottom: bottomInset + 28 }]} pointerEvents="box-none">
              <Pressable
                style={[styles.navButton, currentIndex === 0 && styles.navButtonDisabled]}
                disabled={currentIndex === 0}
                onPress={() => goToIndex(currentIndex - 1)}
              >
                <Text style={styles.navText}>Prev</Text>
              </Pressable>
              <Pressable
                style={[
                  styles.navButton,
                  currentIndex === viewerItems.length - 1 && styles.navButtonDisabled,
                ]}
                disabled={currentIndex === viewerItems.length - 1}
                onPress={() => goToIndex(currentIndex + 1)}
              >
                <Text style={styles.navText}>Next</Text>
              </Pressable>
            </View>
          )}
          <Pressable
            style={[styles.closeButton, { top: topInset + 12 }]}
            onPress={onClose}
            testID={testID ? `${testID}-close` : undefined}
          >
            <Text style={styles.closeText}>Close</Text>
          </Pressable>
        </SafeAreaView>
      </GestureHandlerRootView>
    </Modal>
  );
}

function MediaSlide({
  isActive,
  item,
  width,
  height,
  panEnabled,
  onZoomChange,
  onViewSelectionChange,
  acceptance,
}: {
  isActive: boolean;
  item: MediaViewerItem;
  width: number;
  height: number;
  panEnabled?: boolean;
  onZoomChange?: (zoomed: boolean) => void;
  onViewSelectionChange: (uri: string) => void;
  acceptance?: EvidenceAcceptanceReview;
}) {
  const mediaType = item.mediaType ?? classifyArtifact(item.title ?? item.uri);
  if (mediaType === 'document') {
    return (
      <TextSlide
        uri={item.uri}
        width={width}
        height={height}
        authHeaders={item.authHeaders}
        isActive={isActive}
      />
    );
  }
  if (mediaType === 'video') {
    if (!isActive) return <View style={[styles.media, { width, height }]} />;
    return (
      <FullscreenVideo
        item={item}
        width={width}
        height={height}
        onViewSelectionChange={onViewSelectionChange}
        acceptance={acceptance}
      />
    );
  }
  return (
    <ZoomableImage
      uri={item.uri}
      artifact={{ path: item.path ?? '', sha256: item.sha256 }}
      width={width}
      height={height}
      authHeaders={item.authHeaders}
      isActive={isActive}
      panEnabled={Boolean(panEnabled)}
      onZoomChange={onZoomChange}
    />
  );
}

function ZoomableImage({
  uri,
  artifact,
  width,
  height,
  authHeaders,
  isActive,
  panEnabled,
  onZoomChange,
}: {
  uri: string;
  artifact: { path: string; sha256?: string };
  width: number;
  height: number;
  authHeaders?: ArtifactHttpHeaders;
  isActive: boolean;
  panEnabled: boolean;
  onZoomChange?: (zoomed: boolean) => void;
}) {
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const savedTranslateX = useSharedValue(0);
  const savedTranslateY = useSharedValue(0);
  const onZoomChangeRef = useRef(onZoomChange);

  useEffect(() => {
    onZoomChangeRef.current = onZoomChange;
  }, [onZoomChange]);

  const notifyZoomChange = useCallback((zoomed: boolean) => {
    onZoomChangeRef.current?.(zoomed);
  }, []);

  useEffect(() => {
    scale.value = 1;
    savedScale.value = 1;
    translateX.value = 0;
    translateY.value = 0;
    savedTranslateX.value = 0;
    savedTranslateY.value = 0;
    notifyZoomChange(false);
  }, [height, isActive, notifyZoomChange, uri, width]);

  const clampTranslation = (value: number, scaledSize: number) => {
    'worklet';
    const limit = Math.max(0, (scaledSize * (scale.value - 1)) / 2);
    return Math.max(-limit, Math.min(limit, value));
  };

  const pinch = Gesture.Pinch()
    .onBegin(() => {
      savedScale.value = scale.value;
    })
    .onUpdate((event) => {
      scale.value = Math.max(1, Math.min(savedScale.value * event.scale, 4));
      translateX.value = clampTranslation(translateX.value, width);
      translateY.value = clampTranslation(translateY.value, height);
    })
    .onEnd(() => {
      if (scale.value <= 1.02) {
        scale.value = withTiming(1);
        translateX.value = withTiming(0);
        translateY.value = withTiming(0);
        savedScale.value = 1;
        savedTranslateX.value = 0;
        savedTranslateY.value = 0;
        runOnJS(notifyZoomChange)(false);
        return;
      }
      savedScale.value = scale.value;
      runOnJS(notifyZoomChange)(true);
    });

  const pan = Gesture.Pan()
    .enabled(panEnabled)
    .minDistance(2)
    .onBegin(() => {
      savedTranslateX.value = translateX.value;
      savedTranslateY.value = translateY.value;
    })
    .onUpdate((event) => {
      if (scale.value <= 1.02) return;
      translateX.value = clampTranslation(savedTranslateX.value + event.translationX, width);
      translateY.value = clampTranslation(savedTranslateY.value + event.translationY, height);
    })
    .onEnd(() => {
      savedTranslateX.value = translateX.value;
      savedTranslateY.value = translateY.value;
    });

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      const nextScale = scale.value > 1.02 ? 1 : 2;
      scale.value = withTiming(nextScale);
      savedScale.value = nextScale;
      translateX.value = withTiming(0);
      translateY.value = withTiming(0);
      savedTranslateX.value = 0;
      savedTranslateY.value = 0;
      runOnJS(notifyZoomChange)(nextScale > 1);
    });

  const gesture = Gesture.Simultaneous(doubleTap, pinch, pan);
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { scale: scale.value },
    ],
  }));

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View style={[styles.media, { width, height }, animatedStyle]}>
        <ArtifactImage
          artifact={artifact}
          uri={uri}
          authHeaders={authHeaders}
          style={[styles.media, { width, height }]}
          resizeMode="contain"
        />
      </Animated.View>
    </GestureDetector>
  );
}

function FullscreenVideo({
  item,
  width,
  height,
  onViewSelectionChange,
  acceptance,
}: {
  item: MediaViewerItem;
  width: number;
  height: number;
  onViewSelectionChange: (uri: string) => void;
  acceptance?: EvidenceAcceptanceReview;
}) {
  const [model, setModel] = useState<EvidenceReviewModel | null>(item.evidenceModel ?? null);
  const [openGroups, setOpenGroups] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const groupScrolls = useRef(new Map<string, ScrollView>());
  const focusedFailures = useRef(new Set<string>());
  const [error, setError] = useState<string | null>(null);
  const [uri, setUri] = useState(item.uri);
  const resumePlayback = useRef(Boolean(item.evidenceModel?.selection?.clips.length));
  const [videoPath, setVideoPath] = useState('');
  const [durationMs, setDurationMs] = useState(0);
  const [, updateSelection] = useState(0);
  const source = useMemo(() => artifactSource(uri, item.authHeaders), [item.authHeaders, uri]);
  const player = useVideoPlayer(source, (value) => {
    value.timeUpdateEventInterval = 0.1;
    value.bufferOptions = { preferredForwardBufferDuration: 2, maxBufferBytes: 4 * 1024 * 1024 };
  });

  useEffect(() => {
    const abort = new AbortController();
    let active = true;
    setError(null);
    setUri(item.uri);
    const load = async () => {
      const read =
        item.evidenceModel ??
        (item.path && item.sha256 && item.timelinePath && item.resolveArtifactUrl
          ? await loadRecordingEvidenceReview({
              videoPath: item.path,
              videoDigest: item.sha256,
              timelinePath: item.timelinePath,
              readJson: async (path) => {
                const response = await gatewayFetch(
                  item.resolveArtifactUrl!(path),
                  item.authHeaders,
                  { signal: abort.signal },
                );
                if (!response.ok)
                  throw new Error(`Recording evidence could not be read (${response.status}).`);
                return response.json();
              },
            })
          : null);
      if (!active) return;
      if (read && item.initialTraceIndex !== undefined && !read.selection?.claimId)
        read.selectOccurrence(item.initialTraceIndex);
      const recording = read ? evidenceRecordingForPath(read, item.path) : undefined;
      if (read?.selection?.clips.length && recording) {
        const index = read.selection.clips.findIndex(
          (clip) => clip.videoPath === recording.videoPath,
        );
        if (index >= 0 && read.playback.clip?.videoPath !== recording.videoPath)
          read.cueClip(index);
      }
      setDurationMs(0);
      setVideoPath(recording?.videoPath ?? '');
      setModel(read);
    };
    void load().catch((failure: unknown) => {
      // Unmount cancels owned metadata reads; active failures remain visible in the viewer.
      if (active) setError(failure instanceof Error ? failure.message : String(failure));
    });
    return () => {
      active = false;
      abort.abort();
    };
  }, [
    item.uri,
    item.path,
    item.sha256,
    item.timelinePath,
    item.evidenceModel,
    item.initialTraceIndex,
    item.resolveArtifactUrl,
    item.authHeaders,
  ]);

  const applyPlayback = useCallback(
    (effect: EvidenceReviewPlaybackEffect) => {
      if (effect.sourceChanged && effect.clip && effect.clip.videoPath !== videoPath) {
        onViewSelectionChange(item.uri);
        if (!item.resolveArtifactUrl || !model) {
          setError('The recording source has no artifact URL resolver.');
          player.pause();
          return;
        }
        resumePlayback.current = resumePlayback.current || player.playing;
        setUri(item.resolveArtifactUrl(model.artifactPath(effect.clip.videoPath)));
        setVideoPath(effect.clip.videoPath);
        return;
      }
      if (effect.pause) {
        resumePlayback.current = false;
        player.pause();
      }
      if (effect.seekMs !== null && player.status === 'readyToPlay')
        player.currentTime = effect.seekMs / 1000;
    },
    [item.resolveArtifactUrl, item.uri, model, onViewSelectionChange, player, videoPath],
  );

  useEffect(() => {
    let active = true;
    const cue = () => {
      if (!active || !model?.selection?.clips.length) return;
      const clip = model.playback.clip;
      if (!clip || clip.videoPath !== videoPath) return;
      applyPlayback({
        ...model.playback,
        seekMs:
          item.initialTraceIndex === clip.traceIndex
            ? (model.markerSeekMs(videoPath ?? clip.videoPath, item.initialTraceIndex, 'start') ??
              clip.startMs)
            : clip.startMs,
      });
      if (resumePlayback.current) {
        resumePlayback.current = false;
        player.play();
      }
    };
    let sourceReady = false;
    const syncReady = () => {
      if (!active || player.status !== 'readyToPlay') return;
      setDurationMs(player.duration * 1000);
      // Buffering can return to ready without restarting the selected clip.
      if (sourceReady) return;
      sourceReady = true;
      cue();
    };
    syncReady();
    const ready = player.addListener('sourceLoad', (event) => {
      const loadedDurationMs = videoSourceLoadDurationMs(source.uri, event);
      if (active && loadedDurationMs !== null) {
        setDurationMs(loadedDurationMs);
        syncReady();
      }
    });
    const status = player.addListener('statusChange', syncReady);
    const ended = player.addListener('playToEnd', () => {
      if (!active || !model || !videoPath) return;
      const effect = model.playbackAt(videoPath, player.currentTime * 1000, player.duration * 1000);
      if (effect.sourceChanged) resumePlayback.current = true;
      applyPlayback(effect);
    });
    const updates = player.addListener('timeUpdate', ({ currentTime }) => {
      if (active && model && videoPath)
        applyPlayback(model.playbackAt(videoPath, currentTime * 1000, player.duration * 1000));
    });
    return () => {
      active = false;
      ready.remove();
      status.remove();
      ended.remove();
      updates.remove();
    };
  }, [applyPlayback, model, player, source.uri, uri, videoPath]);

  /** A criterion from the overlay: select it, cue its clip here and play from its moment. */
  const chooseClaim = useCallback(
    (claimId: string, startMs: number | null) => {
      const chosen = model ? evidenceClaimPlayback(model, claimId, videoPath, startMs) : undefined;
      if (!chosen) return;
      onViewSelectionChange(item.uri);
      updateSelection((value) => value + 1);
      if (!chosen.effect) return;
      resumePlayback.current = true;
      applyPlayback(chosen.effect);
      player.play();
    },
    [applyPlayback, item.uri, model, onViewSelectionChange, player, videoPath],
  );

  const timeline = model?.recordings.find((recording) => recording.videoPath === videoPath);
  const groups = model?.timelineGroups(videoPath, undefined, durationMs) ?? [];
  return (
    <View style={[styles.media, { width, height }]}>
      <VideoView
        testID="companion-evidence-video"
        player={player}
        style={[styles.media, { width, height }]}
        nativeControls
        surfaceType={Platform.OS === 'android' ? 'textureView' : undefined}
        fullscreenOptions={{ enable: true }}
        allowsPictureInPicture={false}
        contentFit="contain"
      />
      <View style={{ position: 'absolute', bottom: 16, left: 12, right: 12 }}>
        {error ? <Text style={styles.detailText}>{error}</Text> : null}
        {model?.selection?.caption ? (
          <Text style={styles.detailText}>{model.selection.caption}</Text>
        ) : null}
        {model?.selection?.message ? (
          <Text style={styles.detailText}>{model.selection.message}</Text>
        ) : null}
        {model && timeline && acceptance ? (
          <EvidenceAcOverlay
            model={model}
            videoPath={videoPath}
            durationMs={durationMs}
            review={acceptance}
            maxListHeight={height * 0.28}
            onChoose={chooseClaim}
          />
        ) : null}
        {timeline ? (
          <ScrollView
            horizontal
            nestedScrollEnabled
            contentContainerStyle={{ gap: 8, alignItems: 'flex-start' }}
          >
            {groups.map((group) => {
              const expanded = openGroups.get(group.id) ?? group.defaultOpen;
              return (
                <View key={group.id} style={styles.timelineGroup}>
                  <Pressable
                    style={[styles.navButton, group.failed > 0 && styles.failedMarker]}
                    disabled={group.startMs === null}
                    testID="evidence-timeline-group"
                    onPress={() => {
                      if (!model) return;
                      const effect = model.selectTimelineGroup(videoPath, group.id, durationMs);
                      if (effect.seekMs === null) return;
                      onViewSelectionChange(item.uri);
                      resumePlayback.current = true;
                      applyPlayback(effect);
                      updateSelection((value) => value + 1);
                      player.play();
                    }}
                  >
                    <Text style={styles.detailText}>{group.summary}</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ expanded }}
                    onPress={() =>
                      setOpenGroups((previous) => new Map(previous).set(group.id, !expanded))
                    }
                  >
                    <Text style={styles.detailText}>{expanded ? 'Hide nodes' : 'Show nodes'}</Text>
                  </Pressable>
                  {expanded ? (
                    <ScrollView
                      nestedScrollEnabled
                      style={{ maxHeight: height * 0.32 }}
                      ref={(scroll) => {
                        if (scroll) groupScrolls.current.set(group.id, scroll);
                        else groupScrolls.current.delete(group.id);
                      }}
                    >
                      {group.markers.map((marker) => {
                        const seek = model?.markerSeekMs(
                          videoPath,
                          marker.traceIndex,
                          'start',
                          durationMs,
                        );
                        return (
                          <View
                            key={marker.traceIndex}
                            onLayout={
                              marker.traceIndex === group.firstFailureTraceIndex
                                ? (event) => {
                                    const scroll = groupScrolls.current.get(group.id);
                                    if (scroll && !focusedFailures.current.has(group.id)) {
                                      focusedFailures.current.add(group.id);
                                      scroll.scrollTo({
                                        y: event.nativeEvent.layout.y,
                                        animated: false,
                                      });
                                    }
                                  }
                                : undefined
                            }
                          >
                            <Pressable
                              style={[styles.navButton, !marker.ok && styles.failedMarker]}
                              disabled={seek === null || seek === undefined}
                              testID={`evidence-marker-${marker.traceIndex}`}
                              onPress={() => {
                                if (
                                  !model?.selectOccurrence(marker.traceIndex, {
                                    videoPath,
                                    mediaDurationMs: durationMs,
                                  })
                                )
                                  return;
                                onViewSelectionChange(item.uri);
                                resumePlayback.current = true;
                                applyPlayback(model.cueClip(0));
                                updateSelection((value) => value + 1);
                                player.play();
                              }}
                            >
                              <Text style={styles.detailText}>
                                {seek == null
                                  ? 'Unrecorded'
                                  : formatEvidenceReviewVideoTime(seek / 1000)}{' '}
                                · {marker.intent ?? marker.nodeId}
                              </Text>
                            </Pressable>
                          </View>
                        );
                      })}
                    </ScrollView>
                  ) : null}
                </View>
              );
            })}
          </ScrollView>
        ) : null}
      </View>
    </View>
  );
}

interface TextSlideProps {
  uri: string;
  width: number;
  height: number;
  authHeaders?: ArtifactHttpHeaders;
  isActive: boolean;
}

type TextSlideContent = { body: string; totalBytes: number } | { error: string };

function TextSlide({ uri, width, height, authHeaders, isActive }: TextSlideProps) {
  const [content, setContent] = useState<TextSlideContent | null>(null);
  useEffect(() => {
    setContent(null);
  }, [authHeaders, uri]);
  // The viewer mounts every slide; only the one on screen downloads.
  const load = isActive && content === null;
  useEffect(() => {
    if (!load) return;
    const controller = new AbortController();
    gatewayFetch(uri, authHeaders, {
      signal: controller.signal,
      headers: { Range: TEXT_PREVIEW_RANGE },
    })
      .then(async (res) => {
        const totalBytes = textPreviewTotalBytes(res.status, res.headers.get('Content-Range'));
        setContent({ body: totalBytes ? await res.text() : '', totalBytes });
      })
      .catch((err: Error) => {
        // Abort is the expected cleanup when the slide leaves the screen mid-fetch.
        if (err.name === 'AbortError') return;
        setContent({ error: err.message });
      });
    return () => controller.abort();
  }, [authHeaders, load, uri]);
  const chunks = useMemo(
    () => (content && 'body' in content ? textPreviewChunks(content.body) : []),
    [content],
  );
  return (
    <FlatList
      style={[styles.textSlide, { width, height }]}
      contentContainerStyle={styles.textContent}
      data={chunks}
      keyExtractor={(_, index) => String(index)}
      ListHeaderComponent={
        content === null ? (
          <Text style={styles.textBody}>Loading…</Text>
        ) : 'error' in content ? (
          <Text style={styles.textError}>Failed to load: {content.error}</Text>
        ) : content.totalBytes > TEXT_PREVIEW_MAX_BYTES ? (
          <Text style={styles.textError}>
            Showing the first {TEXT_PREVIEW_MAX_BYTES.toLocaleString()} of{' '}
            {content.totalBytes.toLocaleString()} bytes.
          </Text>
        ) : null
      }
      renderItem={({ item }) => (
        // Blocks follow one another, so the newline that ends a block is not drawn twice.
        <Text selectable style={styles.textBody}>
          {item.endsWith('\n') ? item.slice(0, -1) : item}
        </Text>
      )}
    />
  );
}

const styles = StyleSheet.create({
  timelineGroup: { maxWidth: 340, gap: 6 },
  failedMarker: { borderLeftWidth: 3, borderLeftColor: colors.statusFail },
  modalRoot: {
    flex: 1,
  },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.95)',
  },
  slide: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  media: {
    flexShrink: 0,
    backgroundColor: '#000',
  },
  captionBar: {
    position: 'absolute',
    left: 20,
    right: 96,
    top: 20,
    gap: 4,
  },
  captionText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },
  detailText: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 12,
    fontWeight: '600',
  },
  indexText: {
    color: 'rgba(255,255,255,0.65)',
    fontSize: 12,
  },
  textSlide: {
    flexGrow: 0,
    backgroundColor: '#0b0b10',
  },
  textContent: {
    padding: 16,
  },
  textBody: {
    color: '#e6e6f0',
    fontSize: 12,
    fontFamily: fonts.mono,
  },
  textError: {
    color: '#ff6b6b',
    fontSize: 12,
  },
  navBar: {
    position: 'absolute',
    left: 20,
    right: 20,
    bottom: 28,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  navButton: {
    backgroundColor: 'rgba(255,255,255,0.15)',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 999,
  },
  navButtonDisabled: {
    opacity: 0.35,
  },
  navText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
  },
  closeButton: {
    position: 'absolute',
    top: 20,
    right: 20,
    backgroundColor: 'rgba(255,255,255,0.15)',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 6,
  },
  closeText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
});
