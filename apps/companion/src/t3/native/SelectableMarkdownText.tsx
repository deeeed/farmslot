// From T3 Code apps/mobile/src/native/SelectableMarkdownText.tsx (b8c2cfad). T3 reads its selection
// colors from its theme; Companion passes them in the text style.
import { MobileEnrichedMarkdownText } from './EnrichedMarkdownText';
import type { SelectableMarkdownTextProps } from './SelectableMarkdownText.types';

export type {
  MarkdownFileContextMenu,
  MarkdownFileContextMenuAction,
  MarkdownLinkCustomization,
  NativeMarkdownTextStyle,
} from './SelectableMarkdownText.types';

export function SelectableMarkdownText(props: SelectableMarkdownTextProps) {
  return <MobileEnrichedMarkdownText {...props} />;
}
