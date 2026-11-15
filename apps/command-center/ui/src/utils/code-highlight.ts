// Syntax highlighting for chat code blocks, with the highlighter T3 Code uses: @pierre/diffs over
// @pierre/highlights (WebAssembly lexers, much faster than Shiki's regex engine). It loads on the
// first code block and each language on its first use, so a page with no code never fetches it.
// Rendering stays synchronous: a block whose language is not loaded yet renders as plain text and
// `onHighlighterReady` listeners re-render once it is.
import type { DiffsHighlighter } from '@pierre/diffs';

/** Command Center is dark-only. */
export const CODE_THEME = 'pierre-dark';

type DiffsModule = typeof import('@pierre/diffs');

let diffs: Promise<DiffsModule> | undefined;
const loaded = new Map<string, DiffsHighlighter>();
const loading = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
/** Bumped each time a language finishes loading, so cached plain blocks are rendered again. */
let generation = 0;

export function highlightGeneration(): number {
  return generation;
}

/** Called after any language finishes loading; returns the unsubscribe. */
export function onHighlighterReady(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function loadDiffs(): Promise<DiffsModule> {
  diffs ??= import('@pierre/diffs');
  return diffs;
}

function load(language: string): Promise<void> {
  let pending = loading.get(language);
  if (pending) return pending;
  pending = loadDiffs()
    .then((module) =>
      module.getSharedHighlighter({
        themes: [CODE_THEME],
        langs: [language],
        preferredHighlighter: 'highlights',
      }),
    )
    .then(
      (highlighter) => {
        loaded.set(language, highlighter);
      },
      (error: unknown) => {
        // An unknown fence language falls back to plain text, the way T3 Code does; a failure to
        // load plain text itself is real and surfaces.
        if (language === 'text') throw error;
        return load('text').then(() => {
          const text = loaded.get('text');
          if (text) loaded.set(language, text);
        });
      },
    )
    .then(() => {
      generation++;
      for (const listener of listeners) listener();
    });
  loading.set(language, pending);
  return pending;
}

/** Loads `language`'s highlighter ahead of its first code block (and in tests). */
export function preloadCodeLanguage(language: string): Promise<void> {
  return load(language.trim().toLowerCase() || 'text');
}

/**
 * The highlighted `<pre>` for `code` when `language` (a fence name) is loaded; undefined while it
 * loads, after starting the load.
 */
export function highlightedCodeHtml(code: string, language: string): string | undefined {
  const key = language.trim().toLowerCase() || 'text';
  const highlighter = loaded.get(key);
  if (!highlighter) {
    void load(key);
    return undefined;
  }
  const lang = highlighter.hasLoadedLanguages([key]) ? key : 'text';
  return highlighter.codeToHtml(code, { lang, theme: CODE_THEME });
}
