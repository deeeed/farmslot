// From T3 Code apps/mobile/src/lib/highlightLanguage.ts (b8c2cfad). T3 detects a path's language
// with @pierre/diffs; Companion reads the file name's extension against the lexer aliases instead,
// which are the same names for the common extensions, so it does not ship @pierre/diffs and Shiki.
import { HIGHLIGHTS_LANGUAGE_IDS } from './highlights.generated';

// Highlights has no lexer for these dialects, so they use their base language's.
const CUSTOM_EXTENSIONS: Readonly<Record<string, string>> = {
  luau: 'lua',
  xsl: 'xml',
  xslt: 'xml',
};

/** The native lexer ID for a @pierre/highlights language name, or 0 (plain text). */
export function highlightLanguageId(language: string): number {
  return Object.hasOwn(HIGHLIGHTS_LANGUAGE_IDS, language) ? HIGHLIGHTS_LANGUAGE_IDS[language]! : 0;
}

function pathLanguage(path: string): string | undefined {
  const name = path.split(/[\\/]/).at(-1)?.toLowerCase() ?? '';
  if (highlightLanguageId(name) !== 0) return name;
  const dot = name.lastIndexOf('.');
  if (dot < 0) return undefined;
  const extension = name.slice(dot + 1);
  return CUSTOM_EXTENSIONS[extension] ?? extension;
}

/** A @pierre/highlights language for a fence language or file path, or `text`. */
export function resolveHighlightLanguage(input: {
  readonly language?: string | null;
  readonly path?: string;
}): string {
  const hinted = input.language?.trim().toLowerCase();
  if (hinted && highlightLanguageId(hinted) !== 0) return hinted;
  const detected = input.path ? pathLanguage(input.path) : undefined;
  if (detected && highlightLanguageId(detected) !== 0) return detected;
  return 'text';
}
