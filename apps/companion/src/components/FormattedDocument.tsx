import { ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import type { DocumentBlock } from '../lib/document-format';
import { colors, fonts, radii, spacing } from '../lib/theme';

/** Markdown as `formatDocument` blocks; code, JSON and tables scroll sideways instead of wrapping. */
export function FormattedDocument({ blocks, empty }: { blocks: DocumentBlock[]; empty?: string }) {
  const { width } = useWindowDimensions();
  const minCodeWidth = Math.max(320, width - spacing.xl * 2);
  if (!blocks.length) return empty ? <Text style={styles.documentText}>{empty}</Text> : null;
  return (
    <>
      {blocks.map((block, index) =>
        block.kind === 'separator' ? (
          <View key={`${block.kind}-${index}`} style={styles.separator} />
        ) : block.kind === 'code' || block.kind === 'json' || block.kind === 'table' ? (
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
      )}
    </>
  );
}

const styles = StyleSheet.create({
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
  numbered: {
    color: colors.textSecondary,
    paddingLeft: spacing.md,
  },
  quote: {
    borderLeftColor: colors.accent + '66',
    borderLeftWidth: 3,
    color: colors.textSecondary,
    paddingLeft: spacing.md,
  },
  separator: {
    backgroundColor: colors.bgCard,
    height: 1,
    marginBottom: spacing.md,
    marginTop: spacing.sm,
  },
  table: {
    color: colors.textPrimary,
    fontFamily: 'Menlo',
    backgroundColor: colors.bgInput,
    borderRadius: radii.md,
    padding: spacing.md,
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
});
