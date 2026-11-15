// From T3 Code apps/mobile/src/native/EnrichedMarkdownText.tsx (b8c2cfad). Companion keeps the
// native renderer, its style mapping, file chips and the link menus. Not ported: composer context
// clipboard, skill and model links, Mermaid and math fences, images, and task-list toggles.
// Android shows the link menu as an Alert, since Companion has no native menu module.
import * as Clipboard from 'expo-clipboard';
import { useMemo, useRef, useState } from 'react';
import { Alert, Platform, Share, StyleSheet, useWindowDimensions, View } from 'react-native';
import {
  EnrichedMarkdownText,
  type MarkdownCodeBlock,
  type MarkdownLinkOccurrence,
  type MarkdownStyle,
} from 'react-native-enriched-markdown';

import {
  ENRICHED_INLINE_FILE_LINK_REGEX,
  enrichedLinkVariantPattern,
} from '../lib/enrichedLinkPresentation';
import { markdownWithInlineFileLinks } from '../lib/markdownInlineFileLinks';

import type {
  MarkdownCodeBlockSeen,
  MarkdownFileContextMenu,
  SelectableMarkdownTextProps,
} from './SelectableMarkdownText.types';
import { useEnrichedLinkVariants } from './useEnrichedLinkVariants';

function enrichedStyle(
  style: SelectableMarkdownTextProps['textStyle'],
  dark: boolean,
  fontScale: number,
): MarkdownStyle {
  const monospace = Platform.OS === 'ios' ? 'Menlo' : 'monospace';
  // Keep the radius modest: iOS clips square table-cell borders without stroking the corner arcs.
  const block = {
    marginTop: 4,
    marginBottom: 12,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: style.dividerColor,
  };
  const body = {
    color: style.color,
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    lineHeight: style.lineHeight,
    marginTop: 0,
    marginBottom: 8,
  };
  const heading = (level: number) => {
    const fontSize = style.headingFontSizes?.[level - 1] ?? style.fontSize * (1.6 - level * 0.1);
    return {
      ...body,
      color: style.strongColor,
      fontFamily: style.headingFontFamily,
      fontSize,
      lineHeight: fontSize * 1.35,
      marginTop: 8,
    };
  };
  return {
    paragraph: body,
    h1: heading(1),
    h2: heading(2),
    h3: heading(3),
    h4: heading(4),
    h5: heading(5),
    h6: heading(6),
    strong: { color: style.strongColor, fontFamily: style.boldFontFamily, fontWeight: 'bold' },
    link: { color: style.linkColor, underline: false },
    code: {
      fontFamily: monospace,
      color: style.inlineCodeColor,
      backgroundColor: 'transparent',
      borderColor: 'transparent',
      fontSize: style.fontSize * 0.9,
    },
    codeBlock: {
      ...body,
      color: style.codeColor,
      backgroundColor: style.codeBlockBackgroundColor,
      fontFamily: monospace,
      fontSize: style.fontSize * 0.9,
      ...block,
      padding: 12,
      syntaxColors: dark
        ? {
            keyword: '#ff7b72',
            string: '#a5d6ff',
            number: '#79c0ff',
            constant: '#79c0ff',
            comment: '#8b949e',
            function: '#d2a8ff',
            type: '#ffa657',
            property: '#79c0ff',
            tag: '#7ee787',
            attribute: '#79c0ff',
          }
        : {
            keyword: '#cf222e',
            string: '#0a3069',
            number: '#0550ae',
            constant: '#0550ae',
            comment: '#6e7781',
            function: '#8250df',
            type: '#953800',
            property: '#0550ae',
            tag: '#116329',
            attribute: '#0550ae',
          },
    },
    blockquote: {
      ...body,
      color: style.mutedColor,
      backgroundColor: 'transparent',
      borderColor: style.quoteMarkerColor,
      borderWidth: 2,
      gapWidth: 12,
    },
    list: {
      ...body,
      bulletColor: style.mutedColor,
      markerColor: style.mutedColor,
      // The bullet is centred on the gap's edge and scales with the system text size; the gap must too.
      gapWidth: 12 * fontScale,
    },
    thematicBreak: { color: style.dividerColor, height: 1, marginTop: 8, marginBottom: 8 },
    table: {
      ...body,
      ...block,
      headerFontFamily: style.boldFontFamily,
      headerTextColor: style.strongColor,
      headerBackgroundColor: style.codeBlockBackgroundColor,
      rowEvenBackgroundColor: 'transparent',
      rowOddBackgroundColor: 'transparent',
      cellPaddingHorizontal: 10,
      cellPaddingVertical: 7,
    },
    taskList: {
      checkedColor: style.linkColor,
      checkedTextColor: style.color,
      borderColor: style.mutedColor,
      checkedStrikethrough: false,
    },
  };
}

const DEFAULT_LINK_MENU = (url: string): MarkdownFileContextMenu => ({
  title: url,
  actions: [
    { id: 'enriched-open-link', title: 'Open link' },
    { id: 'enriched-copy-link', title: 'Copy link' },
    { id: 'enriched-share-link', title: 'Share link' },
  ],
});

/** Companion's markdown is drawn on its dark surfaces. */
const DARK = true;

export function MobileEnrichedMarkdownText(props: SelectableMarkdownTextProps) {
  const markdown = useMemo(
    () => markdownWithInlineFileLinks(props.markdown, ENRICHED_INLINE_FILE_LINK_REGEX),
    [props.markdown],
  );
  const [linkUrls, setLinkUrls] = useState<ReadonlyArray<string>>([]);
  const codeBlocks = useRef(new Map<string, MarkdownCodeBlockSeen>());
  const { onRendered } = props;
  const onLinksChange = (links: MarkdownLinkOccurrence[]) => {
    const urls = [...new Set(links.map((link) => link.url))];
    setLinkUrls((previous) =>
      previous.length === urls.length && previous.every((url, index) => url === urls[index])
        ? previous
        : urls,
    );
    onRendered?.({ links: urls, codeBlocks: [...codeBlocks.current.values()], markdown });
  };
  const { linkVariants, linkPillContent } = useEnrichedLinkVariants(linkUrls, props);
  const { fileContextMenu, onFileContextMenuAction, onLinkPress } = props;
  const performMenuAction = (url: string, actionId: string) => {
    if (actionId === 'enriched-open-link') onLinkPress?.(url);
    else if (actionId === 'enriched-copy-link')
      Clipboard.setStringAsync(url).catch((error: Error) =>
        Alert.alert('Could not copy link', error.message),
      );
    else if (actionId === 'enriched-share-link') void Share.share({ message: url });
    else onFileContextMenuAction?.(url, actionId);
  };
  const linkContextMenuItems =
    Platform.OS === 'ios' && (fileContextMenu || onLinkPress)
      ? Object.fromEntries(
          linkUrls.map((url) => {
            const menu = fileContextMenu?.(url) ?? DEFAULT_LINK_MENU(url);
            return [
              enrichedLinkVariantPattern(url),
              menu.actions.map((action) => ({
                text: action.title,
                disabled: action.disabled === true,
                onPress: () => performMenuAction(url, action.id),
              })),
            ];
          }),
        )
      : undefined;
  const onLinkLongPress =
    Platform.OS === 'android' && fileContextMenu
      ? ({ url }: { url: string }) => {
          const menu = fileContextMenu(url) ?? DEFAULT_LINK_MENU(url);
          Alert.alert(menu.title ?? url, undefined, [
            ...menu.actions
              .filter((action) => !action.disabled)
              .map((action) => ({
                text: action.title,
                onPress: () => performMenuAction(url, action.id),
              })),
            { text: 'Cancel', style: 'cancel' as const },
          ]);
        }
      : undefined;
  const { fontScale } = useWindowDimensions();
  const baseMarkdownStyle = useMemo(() => {
    const style = enrichedStyle(props.textStyle, DARK, fontScale);
    return {
      ...style,
      paragraph: props.textAlign
        ? { ...style.paragraph, textAlign: props.textAlign }
        : style.paragraph,
    };
  }, [props.textStyle, props.textAlign, fontScale]);
  // Link variants change as a message streams. The code renderer reads only the base style, so
  // it stays the same function and the library keeps its rendered blocks.
  const markdownStyle = useMemo(
    () => ({ ...baseMarkdownStyle, linkVariants }),
    [baseMarkdownStyle, linkVariants],
  );
  const renderers = {
    // Companion draws every fence natively; this records the complete ones for proofs.
    code: (block: MarkdownCodeBlock) => {
      if (block.isComplete)
        codeBlocks.current.set(`${block.language}\n${block.code}`, {
          language: block.language,
          lines: block.code.split('\n').length,
        });
      return undefined;
    },
  };

  return (
    <View
      testID={props.testID}
      style={{
        flexShrink: 1,
        minWidth: 0,
        marginTop: props.marginTop,
        marginBottom: props.marginBottom,
      }}
    >
      <EnrichedMarkdownText
        markdown={markdown}
        markdownStyle={markdownStyle}
        writingDirection={props.writingDirection}
        onLinksChange={onLinksChange}
        renderers={renderers}
        containerStyle={{ flexShrink: 1, minWidth: 0 }}
        flavor="github"
        selectable
        selectionColor={props.textStyle.selectionColor}
        selectionHandleColor={props.textStyle.selectionHandleColor}
        md4cFlags={{
          hardSoftBreaks: props.preserveSoftBreaks ?? false,
          admonitions: true,
          preserveWindowsPaths: true,
        }}
        enableCodeBlockWrapToggle
        spoilerOverlay="solid"
        onLinkPress={onLinkPress ? ({ url }) => onLinkPress(url) : undefined}
        onLinkLongPress={onLinkLongPress}
        linkContextMenuItems={linkContextMenuItems}
        linkPillContent={linkPillContent}
      />
    </View>
  );
}
