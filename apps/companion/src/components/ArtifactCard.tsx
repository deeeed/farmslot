import { useVideoPlayer, VideoView } from 'expo-video';
import React from 'react';
import { Image, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import {
  type ArtifactHttpHeaders,
  type ArtifactManifestEntry,
  artifactSource,
  classifyArtifact,
  formatBytes,
  type VisualArtifactPair,
} from '../lib/artifact-url';
import { colors, fonts, radii, spacing } from '../lib/theme';

import { BeforeAfterPreview } from './BeforeAfterPreview';

interface ArtifactCardProps {
  url: string;
  path: string;
  purpose?: string;
  type?: ArtifactManifestEntry['type'];
  label?: string;
  mimeType?: string;
  sizeBytes?: number;
  onPressImage?: () => void;
  onPressVideo?: () => void;
  onPressDocument?: () => void;
  documentLabel?: string;
  documentHint?: string;
  authHeaders?: ArtifactHttpHeaders;
}

const PURPOSE_COLORS: Record<string, string> = {
  screenshot: colors.accent,
  'video-before': colors.statusWarn,
  'video-after': colors.statusOk,
  report: '#8b5cf6',
  recipe: '#06b6d4',
  review: '#f59e0b',
};

export function ArtifactCard({
  url,
  path,
  purpose,
  type,
  label,
  mimeType,
  sizeBytes,
  onPressImage,
  onPressVideo,
  onPressDocument,
  documentLabel,
  documentHint,
  authHeaders,
}: ArtifactCardProps) {
  const mediaType = classifyArtifact({ path, purpose: purpose ?? '', type, label, mimeType });
  const basename = path.split('/').pop() || path;
  const filename = label ? `${label} · ${basename}` : basename;
  const purposeColor = purpose ? (PURPOSE_COLORS[purpose] ?? colors.textMuted) : colors.textMuted;
  const { width } = useWindowDimensions();
  const thumbSize = (width - spacing.xl * 2 - spacing.md) / 2;

  return (
    <View style={[styles.card, { width: thumbSize }]}>
      {mediaType === 'image' && (
        <Pressable onPress={onPressImage}>
          <Image
            source={artifactSource(url, authHeaders)}
            style={[styles.thumbnail, { height: thumbSize * 0.75 }]}
            resizeMode="cover"
          />
        </Pressable>
      )}
      {mediaType === 'video' && (
        <VideoPlayer
          url={url}
          height={thumbSize * 0.75}
          authHeaders={authHeaders}
          onOpen={onPressVideo}
        />
      )}
      {mediaType === 'document' && (
        <Pressable
          style={[styles.documentThumb, { height: thumbSize * 0.75 }]}
          onPress={onPressDocument}
        >
          <Text style={styles.documentIcon}>{documentLabel ?? 'DOC'}</Text>
          <Text style={styles.documentHint}>{documentHint ?? 'Tap to read'}</Text>
        </Pressable>
      )}
      {mediaType === 'other' && (
        <View style={[styles.documentThumb, { height: thumbSize * 0.75 }]}>
          <Text style={styles.documentIcon}>FILE</Text>
        </View>
      )}
      <View style={styles.meta}>
        <Text style={styles.filename} numberOfLines={1}>
          {filename}
        </Text>
        <View style={styles.badgeRow}>
          {purpose && (
            <View style={[styles.purposeBadge, { backgroundColor: purposeColor + '25' }]}>
              <Text style={[styles.purposeText, { color: purposeColor }]}>{purpose}</Text>
            </View>
          )}
          {sizeBytes != null && sizeBytes > 0 && (
            <Text style={styles.sizeText}>{formatBytes(sizeBytes)}</Text>
          )}
        </View>
      </View>
    </View>
  );
}

function VideoPlayer({
  url,
  height,
  onOpen,
  authHeaders,
}: {
  url: string;
  height: number;
  onOpen?: () => void;
  authHeaders?: ArtifactHttpHeaders;
}) {
  const source = React.useMemo(() => artifactSource(url, authHeaders), [authHeaders, url]);
  const player = useVideoPlayer(source);

  return (
    <View>
      <VideoView
        player={player}
        style={[styles.thumbnail, { height }]}
        nativeControls
        fullscreenOptions={{ enable: true }}
        allowsPictureInPicture={false}
        contentFit="contain"
      />
      {onOpen && (
        <Pressable style={styles.videoOpenButton} onPress={onOpen}>
          <Text style={styles.videoOpenText}>Open</Text>
        </Pressable>
      )}
    </View>
  );
}

export type ArtifactPair = VisualArtifactPair;

export function ComparisonCard({
  pair,
  authHeaders,
  onOpenBefore,
  onOpenAfter,
}: {
  pair: ArtifactPair;
  authHeaders?: ArtifactHttpHeaders;
  onOpenBefore?: () => void;
  onOpenAfter?: () => void;
}) {
  return (
    <BeforeAfterPreview
      pair={pair}
      authHeaders={authHeaders}
      onOpenBefore={onOpenBefore}
      onOpenAfter={onOpenAfter}
      imageHeight={120}
    />
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.bgCard,
    borderRadius: radii.md,
    overflow: 'hidden',
  },
  thumbnail: {
    width: '100%',
    backgroundColor: colors.bgInput,
  },
  documentThumb: {
    width: '100%',
    backgroundColor: colors.bgInput,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  documentIcon: {
    color: colors.textPrimary,
    fontSize: fonts.sizeLg,
    fontWeight: '800',
    letterSpacing: 1,
  },
  documentHint: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
  },
  meta: {
    padding: spacing.md,
  },
  filename: {
    color: colors.textPrimary,
    fontSize: fonts.sizeXs,
    fontWeight: '500',
  },
  badgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  purposeBadge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 1,
    borderRadius: 3,
  },
  purposeText: {
    fontSize: 9,
    fontWeight: '600',
    textTransform: 'uppercase',
  },
  sizeText: {
    color: colors.textMuted,
    fontSize: 9,
  },
  videoOpenButton: {
    position: 'absolute',
    top: spacing.sm,
    right: spacing.sm,
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
});
