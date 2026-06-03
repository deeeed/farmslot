import { useVideoPlayer, VideoView } from 'expo-video';
import React, { useEffect, useRef, useState } from 'react';
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
}

export function MediaViewer({
  visible,
  uri,
  items,
  initialIndex = 0,
  onClose,
  authHeaders,
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

  useEffect(() => {
    if (!visible || viewerItems.length === 0) return;
    setCurrentIndex(clampedInitialIndex);
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ x: clampedInitialIndex * width, animated: false });
    });
  }, [clampedInitialIndex, visible, viewerItems.length, width]);

  if (viewerItems.length === 0) return null;

  const goToIndex = (nextIndex: number) => {
    const next = Math.max(0, Math.min(nextIndex, viewerItems.length - 1));
    setCurrentIndex(next);
    scrollRef.current?.scrollTo({ x: next * width, animated: true });
  };

  const current = viewerItems[currentIndex];
  const mediaHeight = Math.max(180, height - topInset - bottomInset - 140);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <SafeAreaView style={styles.backdrop}>
        <ScrollView
          ref={scrollRef}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          onMomentumScrollEnd={(event) => {
            setCurrentIndex(Math.round(event.nativeEvent.contentOffset.x / width));
          }}
        >
          {viewerItems.map((item) => (
            <View key={item.uri} style={[styles.slide, { width }]}>
              <MediaSlide
                item={{ ...item, authHeaders: item.authHeaders ?? authHeaders }}
                width={width}
                height={mediaHeight}
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
        <Pressable style={[styles.closeButton, { top: topInset + 12 }]} onPress={onClose}>
          <Text style={styles.closeText}>Close</Text>
        </Pressable>
      </SafeAreaView>
    </Modal>
  );
}

function MediaSlide({
  item,
  width,
  height,
}: {
  item: MediaViewerItem;
  width: number;
  height: number;
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
    <Image
      source={artifactSource(item.uri, item.authHeaders)}
      style={[styles.media, { width, height }]}
      resizeMode="contain"
    />
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
