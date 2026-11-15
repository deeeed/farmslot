// From T3 Code apps/mobile/src/native/SelectableMarkdownText.types.ts (b8c2cfad), without the
// skill, model, image and context-clipboard props Companion does not use.

export interface NativeMarkdownTextStyle {
  readonly selectionColor?: string;
  readonly selectionHandleColor?: string;
  readonly color: string;
  readonly strongColor: string;
  readonly mutedColor: string;
  readonly linkColor: string;
  readonly inlineCodeColor: string;
  readonly codeColor: string;
  readonly codeBackgroundColor: string;
  readonly codeBlockBackgroundColor: string;
  readonly fileTextColor: string;
  readonly quoteMarkerColor: string;
  readonly dividerColor: string;
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly fontFamily?: string;
  readonly headingFontFamily?: string;
  readonly boldFontFamily?: string;
  readonly headingFontSizes?: ReadonlyArray<number>;
}

export interface MarkdownFileContextMenuAction {
  readonly id: string;
  readonly title: string;
  readonly disabled?: boolean;
}

export interface MarkdownFileContextMenu {
  readonly title?: string;
  readonly actions: ReadonlyArray<MarkdownFileContextMenuAction>;
}

export interface MarkdownLinkCustomization {
  readonly iconTintColor?: string;
  readonly color?: string;
  readonly label?: string;
  readonly chip?: { readonly accent?: string; readonly tintsIcon: boolean };
}

/** A fenced code block the renderer drew natively. */
export interface MarkdownCodeBlockSeen {
  readonly language: string;
  readonly lines: number;
}

export interface SelectableMarkdownTextProps {
  readonly markdown: string;
  readonly textStyle: NativeMarkdownTextStyle;
  readonly preserveSoftBreaks?: boolean;
  readonly onLinkPress?: (href: string) => void;
  readonly fileContextMenu?: (href: string) => MarkdownFileContextMenu | undefined;
  readonly onFileContextMenuAction?: (href: string, actionId: string) => void;
  readonly linkCustomization?: (href: string) => MarkdownLinkCustomization | undefined;
  /** Companion: the links and complete code blocks the renderer parsed, for proofs. */
  readonly onRendered?: (rendered: {
    readonly links: ReadonlyArray<string>;
    readonly codeBlocks: ReadonlyArray<MarkdownCodeBlockSeen>;
    /** The markdown handed to the native renderer, after file links were added. */
    readonly markdown: string;
  }) => void;
  readonly marginTop?: number;
  readonly marginBottom?: number;
  readonly writingDirection?: 'ltr' | 'rtl';
  readonly textAlign?: 'left' | 'right';
  readonly testID?: string;
}
