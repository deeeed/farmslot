import { useVideoPlayer, VideoView } from 'expo-video';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Image,
  Modal,
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
  type ArtifactHttpHeaders,
  type ArtifactMediaType,
  artifactSource,
  classifyArtifact,
} from '../lib/artifact-url';

export interface MediaViewerItem {
  uri: string;
  title?: string;
  mediaType?: ArtifactMediaType;
  authHeaders?: ArtifactHttpHeaders;
}

interface MediaViewerProps {
  visible: boolean;
  uri: string | null;
  items?: MediaViewerItem[];
  initialIndex?: number;
  onClose: () => void;
  authHeaders?: ArtifactHttpHeaders;
  testID?: string;
}

export function MediaViewer({
  visible,
  uri,
  items,
  initialIndex = 0,
  onClose,
  authHeaders,
  testID,
}: MediaViewerProps) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const topInset = Math.max(
    insets.top,
    Platform.OS === 'ios' ? 54 : (StatusBar.currentHeight ?? 0),
  );
  const bottomInset = Math.max(insets.bottom, Platform.OS === 'ios' ? 10 : 0);
  const scrollRef = useRef<ScrollView>(null);
  const viewerItems = items?.length ? items : uri ? [{ uri, authHeaders }] : [];
  const clampedInitialIndex = Math.max(0, Math.min(initialIndex, viewerItems.length - 1));
  const [currentIndex, setCurrentIndex] = useState(clampedInitialIndex);
  const [zoomedUri, setZoomedUri] = useState<string | null>(null);

  useEffect(() => {
    if (!visible || viewerItems.length === 0) return;
    setCurrentIndex(clampedInitialIndex);
    setZoomedUri(null);
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ x: clampedInitialIndex * width, animated: false });
    });
  }, [clampedInitialIndex, visible, viewerItems.length, width]);

  if (viewerItems.length === 0) return null;

  const goToIndex = (nextIndex: number) => {
    const next = Math.max(0, Math.min(nextIndex, viewerItems.length - 1));
    setCurrentIndex(next);
    setZoomedUri(null);
    scrollRef.current?.scrollTo({ x: next * width, animated: true });
  };

  const current = viewerItems[currentIndex];
  const mediaHeight = Math.max(180, height - topInset - bottomInset - 140);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
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
                />
              </View>
            ))}
          </ScrollView>
          <View style={[styles.captionBar, { top: topInset + 12 }]} pointerEvents="box-none">
            <Text style={styles.captionText} numberOfLines={1}>
              {current?.title ?? 'Evidence'}
            </Text>
            <Text style={styles.indexText}>
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
}: {
  isActive: boolean;
  item: MediaViewerItem;
  width: number;
  height: number;
  panEnabled?: boolean;
  onZoomChange?: (zoomed: boolean) => void;
}) {
  const mediaType = item.mediaType ?? classifyArtifact(item.title ?? item.uri);
  if (mediaType === 'video') {
    return (
      <FullscreenVideo
        uri={item.uri}
        width={width}
        height={height}
        authHeaders={item.authHeaders}
      />
    );
  }
  return (
    <ZoomableImage
      uri={item.uri}
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
  width,
  height,
  authHeaders,
  isActive,
  panEnabled,
  onZoomChange,
}: {
  uri: string;
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
        <Image
          source={artifactSource(uri, authHeaders)}
          style={[styles.media, { width, height }]}
          resizeMode="contain"
        />
      </Animated.View>
    </GestureDetector>
  );
}

function FullscreenVideo({
  uri,
  width,
  height,
  authHeaders,
}: {
  uri: string;
  width: number;
  height: number;
  authHeaders?: ArtifactHttpHeaders;
}) {
  const source = React.useMemo(() => artifactSource(uri, authHeaders), [authHeaders, uri]);
  const player = useVideoPlayer(source);
  return (
    <VideoView
      player={player}
      style={[styles.media, { width, height }]}
      nativeControls
      fullscreenOptions={{ enable: true }}
      allowsPictureInPicture={false}
      contentFit="contain"
    />
  );
}

const styles = StyleSheet.create({
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
  indexText: {
    color: 'rgba(255,255,255,0.65)',
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
