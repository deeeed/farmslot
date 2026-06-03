import React from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

import {
  type ArtifactHttpHeaders,
  type ArtifactManifestEntry,
  artifactSource,
  classifyArtifact,
  formatVisualArtifactPairLabel,
  type VisualArtifactPair,
} from '../lib/artifact-url';
import { colors, fonts, radii, spacing } from '../lib/theme';

interface BeforeAfterPreviewProps<T extends ArtifactManifestEntry = ArtifactManifestEntry> {
  pair: VisualArtifactPair<T>;
  authHeaders: ArtifactHttpHeaders;
  onOpenArtifact: (artifactPath: string) => void;
  title?: string;
  eyebrow?: string;
  hint?: string;
  imageHeight?: number;
}

export function BeforeAfterPreview<T extends ArtifactManifestEntry = ArtifactManifestEntry>({
  pair,
  authHeaders,
  onOpenArtifact,
  title = 'Before → After delta',
  eyebrow = 'Required comparison',
  hint = 'Tap to inspect',
  imageHeight = 78,
}: BeforeAfterPreviewProps<T>) {
  const comparisonLabel = formatVisualArtifactPairLabel(pair);
  const beforeName = artifactDisplayName(pair.before);
  const afterName = artifactDisplayName(pair.after);
  return (
    <View style={styles.card}>
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
      <View style={styles.row}>
        <ComparePane
          label="Before"
          artifact={pair.before}
          tone={colors.statusWarn}
          authHeaders={authHeaders}
          imageHeight={imageHeight}
          onOpenArtifact={onOpenArtifact}
        />
        <View style={styles.arrow}>
          <Text style={styles.arrowText}>→</Text>
          <Text style={styles.arrowLabel}>Changed</Text>
        </View>
        <ComparePane
          label="After"
          artifact={pair.after}
          tone={colors.statusOk}
          authHeaders={authHeaders}
          imageHeight={imageHeight}
          onOpenArtifact={onOpenArtifact}
        />
      </View>
      <View style={styles.deltaStrip}>
        <Text style={styles.deltaLabel}>Find what changed</Text>
        <Text style={styles.deltaText} numberOfLines={1}>
          {beforeName} → {afterName}
        </Text>
      </View>
    </View>
  );
}

function ComparePane<T extends ArtifactManifestEntry>({
  label,
  artifact,
  tone,
  authHeaders,
  imageHeight,
  onOpenArtifact,
}: {
  label: 'Before' | 'After';
  artifact: T & { url: string };
  tone: string;
  authHeaders: ArtifactHttpHeaders;
  imageHeight: number;
  onOpenArtifact: (artifactPath: string) => void;
}) {
  const mediaType = classifyArtifact(artifact);
  return (
    <Pressable
      style={[styles.pane, { borderColor: tone + '66' }]}
      onPress={() => onOpenArtifact(artifact.path)}
      accessibilityRole="button"
      accessibilityLabel={`${label} artifact ${artifact.path}`}
    >
      <Text style={[styles.label, { color: tone }]}>{label}</Text>
      {mediaType === 'image' ? (
        <Image
          source={artifactSource(artifact.url, authHeaders)}
          style={[styles.image, { height: imageHeight }]}
          resizeMode="cover"
        />
      ) : (
        <View style={[styles.document, { height: imageHeight }]}>
          <Text style={[styles.documentKind, { color: tone }]}>{mediaType.toUpperCase()}</Text>
        </View>
      )}
      <Text style={styles.path} numberOfLines={1}>
        {artifact.path.split('/').pop() ?? artifact.path}
      </Text>
    </Pressable>
  );
}

function artifactDisplayName(artifact: ArtifactManifestEntry): string {
  return artifact.label?.trim() || artifact.path.split('/').pop() || artifact.path;
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.bgInput,
    borderColor: colors.accent + '33',
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.sm,
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
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xs,
  },
  deltaStrip: {
    alignItems: 'center',
    backgroundColor: colors.bgCard,
    borderColor: colors.accent + '2b',
    borderRadius: radii.md,
    borderWidth: 1,
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  deltaLabel: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  deltaText: {
    color: colors.textPrimary,
    flex: 1,
    fontSize: fonts.sizeXs,
    fontWeight: '800',
  },
  pane: {
    backgroundColor: colors.bgCard,
    borderRadius: radii.md,
    borderWidth: 1,
    flex: 1,
    padding: spacing.xs,
  },
  label: {
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    marginBottom: spacing.xs,
    textTransform: 'uppercase',
  },
  image: {
    backgroundColor: colors.bgInput,
    borderRadius: radii.sm,
    width: '100%',
  },
  document: {
    alignItems: 'center',
    backgroundColor: colors.bgInput,
    borderRadius: radii.sm,
    justifyContent: 'center',
    width: '100%',
  },
  documentKind: {
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  path: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    marginTop: spacing.xs,
  },
  arrow: {
    alignItems: 'center',
    backgroundColor: colors.accent + '22',
    borderColor: colors.accent + '55',
    borderRadius: radii.md,
    borderWidth: 1,
    gap: 1,
    minHeight: 34,
    paddingHorizontal: spacing.xs,
    paddingVertical: 2,
    justifyContent: 'center',
    minWidth: 38,
  },
  arrowText: {
    color: colors.accent,
    fontSize: fonts.sizeSm,
    fontWeight: '900',
    lineHeight: 16,
  },
  arrowLabel: {
    color: colors.accent,
    fontSize: 8,
    fontWeight: '900',
    letterSpacing: 0.3,
    lineHeight: 10,
    textTransform: 'uppercase',
  },
});
