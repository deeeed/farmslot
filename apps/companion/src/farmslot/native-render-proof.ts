import type { FarmslotRecipeUiObserver } from './RecipeBridgeProvider';

/** What the native renderers reported drawing, by the component that drew it. Dev builds only. */
export interface NativeMarkdownRender {
  readonly links: readonly string[];
  readonly codeBlocks: ReadonlyArray<{ readonly language: string; readonly lines: number }>;
  /** The markdown the native renderer was given. */
  readonly markdown: string;
}

export interface NativeDiffRender {
  readonly source: 'tool' | 'turn';
  readonly paths: readonly string[];
  readonly rows: number;
  readonly tokenRows: number;
  readonly surface: 'native' | 'fallback';
  /** Native `rows-decoded` row count, once the view decoded the rows sent to it. */
  readonly decodedRows?: number;
  /** The native view drew rows (`draw-metrics` or `visible-range`). */
  readonly drawn?: boolean;
}

export interface NativeFileRender {
  readonly path: string;
  readonly line?: number;
  readonly mode: 'source' | 'rendered' | 'raw';
  readonly surface?: string;
  readonly language?: string;
  readonly status?: string;
  readonly lineCount?: number;
  readonly targetIndex?: number | null;
  readonly coloredLines?: number;
  /** The rows the native view last reported visible. */
  readonly visibleRange?: { readonly first: number; readonly last: number };
  readonly markdown?: NativeMarkdownRender;
  readonly error?: string;
}

interface SessionRender {
  messages: Record<string, NativeMarkdownRender>;
  diffs: Record<string, NativeDiffRender>;
  file?: NativeFileRender;
}

const sessions = new Map<string, SessionRender>();

function session(sessionId: string): SessionRender {
  let render = sessions.get(sessionId);
  if (!render) {
    render = { messages: {}, diffs: {} };
    sessions.set(sessionId, render);
  }
  return render;
}

export function recordNativeMarkdown(sessionId: string, key: string, render: NativeMarkdownRender) {
  if (__DEV__) session(sessionId).messages[key] = render;
}

export function recordNativeDiff(
  sessionId: string,
  key: string,
  render: Partial<NativeDiffRender>,
) {
  if (!__DEV__) return;
  const diffs = session(sessionId).diffs;
  diffs[key] = {
    ...(diffs[key] ?? { source: 'tool', paths: [], rows: 0, tokenRows: 0, surface: 'fallback' }),
    ...render,
  };
}

export function recordNativeFile(
  sessionId: string,
  render: Partial<NativeFileRender> & { path: string },
) {
  if (!__DEV__) return;
  const current = session(sessionId).file;
  session(sessionId).file = {
    ...(current?.path === render.path ? current : { mode: 'source' as const }),
    ...render,
  };
}

/** `native-render:<sessionId>` reads what that session's renderers reported. */
export const observeNativeRenderProof: FarmslotRecipeUiObserver = (refs) => {
  const sessionId = /^native-render:(.+)$/.exec(refs[0] ?? '')?.[1];
  if (!__DEV__ || !sessionId) return undefined;
  return { observations: { nativeRender: sessions.get(sessionId) ?? null } };
};
