import { useRouter, useSegments } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { Clip } from '@farmslot/protocol';

import { colors, fonts, radii, spacing } from '../../lib/theme';

import { useClips } from './use-clips';

const SHOWN_MS = 4000;

/** A short banner when a clip arrives while the app is open; tap opens the Clipboard. */
export function ClipBanner() {
  const state = useClips();
  const router = useRouter();
  const segments = useSegments();
  const insets = useSafeAreaInsets();
  const seen = useRef<Set<string> | undefined>(undefined);
  const [clip, setClip] = useState<Clip>();

  useEffect(() => {
    // Only a current gateway answer counts: saved clips from an earlier session are not news.
    if (state.status !== 'ready' || !state.data) return;
    const clips = state.data.clips;
    if (!seen.current) {
      seen.current = new Set(clips.map(({ id }) => id));
      return;
    }
    const fresh = clips.find(({ id }) => !seen.current!.has(id));
    for (const { id } of clips) seen.current.add(id);
    if (fresh) setClip(fresh);
  }, [state]);

  useEffect(() => {
    if (!clip) return;
    const timer = setTimeout(() => setClip(undefined), SHOWN_MS);
    return () => clearTimeout(timer);
  }, [clip]);

  if (!clip || segments.at(-1) === 'clipboard') return null;
  return (
    <Pressable
      testID="clip-banner"
      accessibilityRole="button"
      accessibilityLabel={`New clip: ${clip.label ?? 'clip'}. Open Clipboard`}
      style={[styles.banner, { top: insets.top + spacing.md }]}
      onPress={() => {
        setClip(undefined);
        router.push('/clipboard');
      }}
    >
      <Text style={styles.title}>New {clip.kind === 'link' ? 'link' : 'clip'}</Text>
      <Text style={styles.label} numberOfLines={1}>
        {clip.label ?? clip.text}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  banner: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.lg,
    zIndex: 300,
    backgroundColor: colors.bgCard,
    borderColor: colors.accent,
    borderWidth: 1,
    borderRadius: radii.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  title: { color: colors.accentHover, fontSize: fonts.sizeXs, fontWeight: '700' },
  label: { color: colors.textPrimary, fontSize: fonts.sizeMd },
});
