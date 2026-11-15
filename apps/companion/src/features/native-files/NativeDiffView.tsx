import { memo, useCallback, useEffect, useMemo } from 'react';
import { View } from 'react-native';

import { MobileDiffViewer } from '../../components/MobileDiffViewer';
import { recordNativeDiff } from '../../farmslot/native-render-proof';
import { nativeDiffDocument, nativeDiffTokens } from '../../lib/native-diff-rows';
import {
  type NativeReviewDiffDebugEvent,
  resolveNativeReviewDiffView,
} from '../../t3/features/diffs/nativeReviewDiffSurface';
import {
  createNativeReviewDiffStyle,
  createNativeReviewDiffTheme,
  MOBILE_CODE_SURFACE,
  NATIVE_REVIEW_DIFF_CONTENT_WIDTH,
} from '../../t3/features/review/nativeReviewDiffAdapter';
import { resolveHighlightLanguage } from '../../t3/lib/highlightLanguage';
import { highlightCode } from '../../t3/lib/highlights';

const style = createNativeReviewDiffStyle(MOBILE_CODE_SURFACE, false);
const styleJson = JSON.stringify(style);
const themeJson = JSON.stringify(createNativeReviewDiffTheme());
const MAX_HEIGHT = 420;

function highlight(code: string, path: string) {
  const language = resolveHighlightLanguage({ path });
  return language === 'text' ? null : highlightCode(code, language, 'dark');
}

/**
 * A unified diff in T3's native diff view, highlighted by the native lexer. Builds without that
 * view (installed before it shipped) keep the JavaScript diff viewer.
 */
export const NativeDiffView = memo(function NativeDiffView({
  diffText,
  title,
  source,
  proof,
  root,
}: {
  diffText: string;
  /** The session folder; file headers inside it show relative paths. */
  root?: string;
  title: string;
  source: 'tool' | 'turn';
  /** Session and key the render is recorded under, for proofs. */
  proof?: { sessionId: string; key: string };
}) {
  const NativeView = resolveNativeReviewDiffView();
  const document = useMemo(() => nativeDiffDocument(diffText, root), [diffText, root]);
  const tokens = useMemo(
    () => (NativeView ? nativeDiffTokens(document, highlight) : {}),
    [NativeView, document],
  );
  const rowsJson = useMemo(() => JSON.stringify(document.rows), [document]);
  const tokensJson = useMemo(() => JSON.stringify(tokens), [tokens]);
  const sessionId = proof?.sessionId;
  const proofKey = proof?.key;
  useEffect(() => {
    if (sessionId && proofKey)
      recordNativeDiff(sessionId, proofKey, {
        source,
        paths: document.files.map((file) => file.path),
        rows: document.rows.length,
        tokenRows: Object.keys(tokens).length,
        surface: NativeView ? 'native' : 'fallback',
      });
  }, [sessionId, proofKey, source, document, tokens, NativeView]);
  const onDebug = useCallback(
    ({ nativeEvent }: NativeReviewDiffDebugEvent) => {
      if (!sessionId || !proofKey) return;
      if (nativeEvent.message === 'rows-decoded' && typeof nativeEvent.rows === 'number')
        recordNativeDiff(sessionId, proofKey, { decodedRows: nativeEvent.rows });
      else if (nativeEvent.message === 'draw-metrics' || nativeEvent.message === 'visible-range')
        recordNativeDiff(sessionId, proofKey, { drawn: true });
    },
    [sessionId, proofKey],
  );
  if (!NativeView)
    return (
      <MobileDiffViewer
        title={title}
        diffText={diffText}
        initialPath={document.files[0]?.path ?? null}
        fullscreenChoiceId={proofKey ? `native-diff:${proofKey}` : undefined}
      />
    );
  const fileRows = document.rows.filter((row) => row.kind === 'file').length;
  const height = Math.min(
    MAX_HEIGHT,
    fileRows * (style.fileHeaderHeight + 2 * style.fileHeaderVerticalMargin) +
      (document.rows.length - fileRows) * style.rowHeight +
      8,
  );
  return (
    <View testID="companion-native-diff" style={{ height, borderRadius: 6, overflow: 'hidden' }}>
      <NativeView
        collapsable={false}
        style={{ flex: 1 }}
        appearanceScheme="dark"
        contentResetKey={`${proofKey ?? title}:${document.rows.length}`}
        contentWidth={NATIVE_REVIEW_DIFF_CONTENT_WIDTH}
        rowHeight={style.rowHeight}
        rowsJson={rowsJson}
        tokensJson={tokensJson}
        styleJson={styleJson}
        themeJson={themeJson}
        onDebug={onDebug}
      />
    </View>
  );
});
