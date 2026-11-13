import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import * as Linking from 'expo-linking';
import React, { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { type Clip, clipLinkUrl, clipTextParts } from '@farmslot/protocol';

import { useShownMarker } from '../../hooks/useShownMarker';
import { baseStyles, colors, fonts, radii, spacing } from '../../lib/theme';

import { useClips } from './use-clips';

/** Links and copy-ready text agents sent with `farmslot clip`, newest first. */
export default function ClipboardScreen() {
  useShownMarker('companion-screen-clipboard');
  const insets = useSafeAreaInsets();
  const state = useClips();
  const [copiedId, setCopiedId] = useState('');
  const [error, setError] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const clips = state.data?.clips ?? [];
  const links = clips.filter((clip) => clip.kind === 'link');
  const texts = clips.filter((clip) => clip.kind !== 'link');

  const copy = (clip: Clip) =>
    Clipboard.setStringAsync(clip.text).then(
      () => {
        setError('');
        setCopiedId(clip.id);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopiedId(''), 1500);
      },
      (reason: unknown) =>
        setError(`Copy failed: ${reason instanceof Error ? reason.message : String(reason)}`),
    );
  const open = (url: string) =>
    Linking.openURL(url).catch((reason: unknown) =>
      setError(`Could not open link: ${reason instanceof Error ? reason.message : String(reason)}`),
    );

  const copyButton = (clip: Clip) => (
    <Pressable
      testID={`clip-copy-${clip.id}`}
      accessibilityRole="button"
      accessibilityLabel={`Copy ${clip.label ?? 'clip'}`}
      style={styles.copy}
      onPress={() => void copy(clip)}
    >
      <Ionicons
        name={copiedId === clip.id ? 'checkmark' : 'copy-outline'}
        size={16}
        color={colors.bgBase}
      />
      <Text style={styles.copyText}>{copiedId === clip.id ? 'Copied' : 'Copy'}</Text>
    </Pressable>
  );

  return (
    <ScrollView
      testID="companion-screen-clipboard"
      style={baseStyles.container}
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xxxl }]}
    >
      {state.error ? <Text style={styles.error}>{state.error.message}</Text> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {state.status === 'loading' && !state.data ? (
        <Text style={styles.hint}>Loading clips…</Text>
      ) : clips.length === 0 ? (
        <Text style={styles.hint}>
          No clips yet. Agents send them with farmslot clip; the last 20 stay here.
        </Text>
      ) : null}

      {links.length ? <Text style={styles.section}>Links</Text> : null}
      {links.map((clip) => (
        <View key={clip.id} style={styles.card} testID={`clip-link-${clip.id}`}>
          <Pressable
            accessibilityRole="link"
            style={styles.linkBody}
            onPress={() => void open(clip.text)}
          >
            <Text style={styles.label} numberOfLines={1}>
              {clip.label ?? clipLinkUrl(clip.text)?.host ?? clip.text}
            </Text>
            <Text style={styles.meta} numberOfLines={1}>
              {clipLinkUrl(clip.text)?.host}
              {clip.source ? ` · ${clip.source}` : ''}
            </Text>
          </Pressable>
          {copyButton(clip)}
        </View>
      ))}

      {texts.length ? <Text style={styles.section}>Clipboard</Text> : null}
      {texts.map((clip) => (
        <View key={clip.id} style={styles.textCard} testID={`clip-text-${clip.id}`}>
          <View style={styles.head}>
            <View style={styles.headText}>
              <Text style={styles.label} numberOfLines={1}>
                {clip.label ?? 'Clip'}
              </Text>
              <Text style={styles.meta} numberOfLines={1}>
                {clip.source ? `${clip.source} · ` : ''}
                {new Date(clip.createdAt).toLocaleString()}
              </Text>
            </View>
            {copyButton(clip)}
          </View>
          <Text style={styles.body} selectable numberOfLines={12}>
            {clipTextParts(clip.text).map((part, index) =>
              part.url ? (
                <Text
                  key={index}
                  style={styles.inlineLink}
                  onPress={() => void open(part.url!)}
                  accessibilityRole="link"
                >
                  {part.text}
                </Text>
              ) : (
                part.text
              ),
            )}
          </Text>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.xl, gap: spacing.lg },
  section: {
    color: colors.textSecondary,
    fontSize: fonts.sizeSm,
    fontWeight: '700',
    textTransform: 'uppercase',
    marginTop: spacing.md,
  },
  hint: { color: colors.textSecondary, fontSize: fonts.sizeMd, lineHeight: 21 },
  error: { color: colors.statusFail, fontSize: fonts.sizeSm },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.bgCard,
    borderRadius: radii.md,
    padding: spacing.lg,
  },
  textCard: {
    backgroundColor: colors.bgCard,
    borderRadius: radii.md,
    padding: spacing.lg,
    gap: spacing.md,
  },
  linkBody: { flex: 1, gap: spacing.xs },
  head: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  headText: { flex: 1, gap: spacing.xs },
  label: { color: colors.textPrimary, fontSize: fonts.sizeMd, fontWeight: '700' },
  meta: { color: colors.textMuted, fontSize: fonts.sizeXs },
  body: { color: colors.textPrimary, fontSize: fonts.sizeSm, lineHeight: 18 },
  inlineLink: { color: colors.accentHover, textDecorationLine: 'underline' },
  copy: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    backgroundColor: colors.accent,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  copyText: { color: colors.bgBase, fontSize: fonts.sizeSm, fontWeight: '700' },
});
