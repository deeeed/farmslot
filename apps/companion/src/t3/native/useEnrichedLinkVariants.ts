// From T3 Code apps/mobile/src/native/useEnrichedLinkVariants.ts (b8c2cfad). Companion keeps the
// file chip and link styles; T3's file icons and context, skill and model chips are not ported.
import { useMemo } from 'react';
import type { LinkPillContent, MarkdownStyle } from 'react-native-enriched-markdown';

import { enrichedLinkVariantPattern } from '../lib/enrichedLinkPresentation';
import { resolveMarkdownLinkPresentation } from '../lib/markdownLinks';

import type {
  MarkdownLinkCustomization,
  SelectableMarkdownTextProps,
} from './SelectableMarkdownText.types';

function presentation(
  url: string,
  props: Pick<SelectableMarkdownTextProps, 'linkCustomization' | 'textStyle'>,
): MarkdownLinkCustomization | undefined {
  const custom = props.linkCustomization?.(url);
  if (custom) return custom;
  const link = resolveMarkdownLinkPresentation(url);
  if (link.kind === 'file')
    return { label: link.label, chip: { accent: props.textStyle.linkColor, tintsIcon: false } };
  return link.kind === 'external' ? { color: props.textStyle.linkColor } : undefined;
}

export function useEnrichedLinkVariants(
  urls: ReadonlyArray<string>,
  props: SelectableMarkdownTextProps,
) {
  const { linkCustomization, textStyle } = props;
  const links = useMemo(() => {
    const byUrl = new Map<string, MarkdownLinkCustomization>();
    for (const url of urls) {
      if (byUrl.has(url)) continue;
      const value = presentation(url, { linkCustomization, textStyle });
      if (value) byUrl.set(url, value);
    }
    return byUrl;
  }, [urls, linkCustomization, textStyle]);
  const linkVariants = useMemo<MarkdownStyle['linkVariants']>(
    () =>
      Object.fromEntries(
        [...links].map(([url, link]) => {
          const chipForeground = link.chip?.accent;
          return [
            enrichedLinkVariantPattern(url),
            {
              pill: {
                borderColor: 'transparent',
                borderWidth: 0,
                borderRadius: 6,
                paddingHorizontal: 5,
                paddingVertical: 2,
              },
              fontFamily: textStyle.fontFamily,
              color: chipForeground ?? link.color ?? textStyle.fileTextColor,
              underline: false,
              backgroundColor: chipForeground ? textStyle.codeBlockBackgroundColor : 'transparent',
            },
          ];
        }),
      ),
    [links, textStyle],
  );
  const linkPillContent = useMemo<Record<string, LinkPillContent>>(
    () =>
      Object.fromEntries(
        [...links].map(([url, link]) => [
          url,
          { label: link.label, iconTintColor: link.iconTintColor },
        ]),
      ),
    [links],
  );
  return { linkVariants, linkPillContent };
}
