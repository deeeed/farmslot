import React from 'react';
import {
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
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, fonts, radii, spacing } from '../lib/theme';

export function DocumentViewer({
  visible,
  title,
  body,
  onClose,
}: {
  visible: boolean;
  title: string;
  body: string;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const topInset = Math.max(
    insets.top,
    Platform.OS === 'ios' ? 54 : (StatusBar.currentHeight ?? 0),
  );
  const bottomInset = Math.max(insets.bottom, Platform.OS === 'ios' ? 10 : 0);
  const formatted = formatDocument(title, body);
  const minCodeWidth = Math.max(320, width - spacing.xl * 2);
  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={onClose}
    >
      <View
        style={[
          styles.container,
          {
            paddingTop: topInset,
            paddingBottom: bottomInset,
          },
        ]}
      >
        <View style={styles.header}>
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
          <Pressable style={styles.closeButton} onPress={onClose}>
            <Text style={styles.closeText}>Close</Text>
          </Pressable>
        </View>
        <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
          {formatted.length > 0 ? (
            formatted.map((block, index) =>
              block.kind === 'code' || block.kind === 'json' ? (
                <ScrollView
                  key={`${block.kind}-${index}`}
                  horizontal
                  showsHorizontalScrollIndicator
                  style={styles.codeScroller}
                  contentContainerStyle={styles.codeScrollerContent}
                >
                  <Text
                    selectable
                    style={[styles.documentText, styles[block.kind], { minWidth: minCodeWidth }]}
                  >
                    {block.text}
                  </Text>
                </ScrollView>
              ) : (
                <Text
                  key={`${block.kind}-${index}`}
                  selectable
                  style={[styles.documentText, styles[block.kind]]}
                >
                  {block.text}
                </Text>
              ),
            )
          ) : (
            <Text style={styles.documentText}>No document content</Text>
          )}
          <Pressable style={styles.footerCloseButton} onPress={onClose}>
            <Text style={styles.closeText}>Close document</Text>
          </Pressable>
        </ScrollView>
      </View>
    </Modal>
  );
}

type DocumentBlockKind = 'paragraph' | 'heading' | 'bullet' | 'code' | 'json';

function formatDocument(
  title: string,
  body: string,
): Array<{ kind: DocumentBlockKind; text: string }> {
  if (!body.trim()) return [];
  if (/\.json$/i.test(title)) {
    return [{ kind: 'json', text: formatJson(body) }];
  }

  const blocks: Array<{ kind: DocumentBlockKind; text: string }> = [];
  let inFence = false;
  let codeBuffer: string[] = [];

  const flushCode = () => {
    if (!codeBuffer.length) return;
    blocks.push({ kind: 'code', text: codeBuffer.join('\n') });
    codeBuffer = [];
  };

  for (const rawLine of body.replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.trimEnd();
    if (line.trim().startsWith('```')) {
      if (inFence) flushCode();
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      codeBuffer.push(line);
      continue;
    }
    if (!line.trim()) {
      flushCode();
      blocks.push({ kind: 'paragraph', text: '' });
    } else if (/^#{1,6}\s+/.test(line)) {
      blocks.push({ kind: 'heading', text: line.replace(/^#{1,6}\s+/, '') });
    } else if (/^\s*[-*]\s+/.test(line)) {
      blocks.push({ kind: 'bullet', text: `• ${line.replace(/^\s*[-*]\s+/, '')}` });
    } else {
      blocks.push({ kind: 'paragraph', text: line });
    }
  }
  if (inFence || codeBuffer.length) flushCode();
  return blocks;
}

function formatJson(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    // Invalid JSON artifacts are still useful evidence; show the raw body instead of failing.
    return body;
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.lg,
    backgroundColor: colors.bgSurface,
    borderBottomWidth: 1,
    borderBottomColor: colors.bgCard,
  },
  title: {
    color: colors.textPrimary,
    fontSize: fonts.sizeLg,
    fontWeight: '700',
    flex: 1,
    marginRight: spacing.lg,
  },
  closeButton: {
    borderRadius: radii.md,
    backgroundColor: colors.accent + '25',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  closeText: {
    color: colors.accent,
    fontSize: fonts.sizeSm,
    fontWeight: '700',
  },
  body: {
    flex: 1,
  },
  bodyContent: {
    padding: spacing.xl,
    paddingBottom: spacing.xxxl,
  },
  documentText: {
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
    lineHeight: 20,
    marginBottom: spacing.sm,
  },
  paragraph: {
    color: colors.textPrimary,
  },
  heading: {
    color: colors.accent,
    fontSize: fonts.sizeMd,
    fontWeight: '900',
    marginTop: spacing.lg,
  },
  bullet: {
    color: colors.textSecondary,
    paddingLeft: spacing.md,
  },
  code: {
    color: colors.textPrimary,
    fontFamily: 'Menlo',
    backgroundColor: colors.bgInput,
    borderRadius: radii.md,
    padding: spacing.md,
  },
  json: {
    color: colors.textPrimary,
    fontFamily: 'Menlo',
    backgroundColor: colors.bgInput,
    borderRadius: radii.md,
    padding: spacing.md,
    lineHeight: 18,
  },
  codeScroller: {
    marginBottom: spacing.sm,
  },
  codeScrollerContent: {
    paddingRight: spacing.lg,
  },
  footerCloseButton: {
    alignItems: 'center',
    alignSelf: 'stretch',
    backgroundColor: colors.accent + '25',
    borderColor: colors.accent + '55',
    borderRadius: radii.md,
    borderWidth: 1,
    marginTop: spacing.xl,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
});
