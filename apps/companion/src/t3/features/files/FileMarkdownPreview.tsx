// From T3 Code apps/mobile/src/features/files/FileMarkdownPreview.tsx and
// packages/shared/src/markdownFrontmatter.ts (b8c2cfad). Companion renders the file with the same
// native markdown text; T3's workspace images, videos and media modals are not ported, and links are
// handed to the caller, which opens files in its own viewer.
import { ScrollView, View } from 'react-native';

import { SelectableMarkdownText } from '../../native/SelectableMarkdownText';
import type {
  MarkdownCodeBlockSeen,
  NativeMarkdownTextStyle,
} from '../../native/SelectableMarkdownText.types';

const LEADING_FRONTMATTER =
  /^\uFEFF?---[ \t]*(?:\r\n|\r|\n)(?:[\s\S]*?(?:\r\n|\r|\n))?(?:---|\.\.\.)[ \t]*(?=\r\n|\r|\n|$)/;

/**
 * Blanks a leading YAML frontmatter block so rendered previews skip it instead
 * of showing a rule and a setext heading. Masked characters become spaces and
 * line breaks stay, so source offsets (task checkbox edits) stay valid.
 */
export function maskMarkdownFrontmatter(markdown: string): string {
  return markdown.replace(LEADING_FRONTMATTER, (block) => block.replace(/[^\r\n]/g, ' '));
}

export function FileMarkdownPreview(props: {
  readonly markdown: string;
  readonly textStyle: NativeMarkdownTextStyle;
  readonly onLinkPress?: (href: string) => void;
  readonly onRendered?: (rendered: {
    readonly links: ReadonlyArray<string>;
    readonly codeBlocks: ReadonlyArray<MarkdownCodeBlockSeen>;
    readonly markdown: string;
  }) => void;
}) {
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 18 }}>
      <View style={{ width: '100%', maxWidth: 760, alignSelf: 'center' }}>
        <SelectableMarkdownText
          testID="native-file-markdown-preview"
          markdown={maskMarkdownFrontmatter(props.markdown)}
          onLinkPress={props.onLinkPress}
          onRendered={props.onRendered}
          textStyle={props.textStyle}
        />
      </View>
    </ScrollView>
  );
}
