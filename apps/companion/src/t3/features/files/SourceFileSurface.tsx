// From T3 Code apps/mobile/src/features/files/SourceFileSurface.tsx and sourceHighlightingState.ts
// (b8c2cfad). T3 highlights through an Effect atom and styles with its theme classes; Companion
// highlights in a memo (the lexer is synchronous) and uses its own dark tokens. The surface, the
// line-jump retry and the selectable fallbacks are T3's.
import { SourceText } from '@t3tools/mobile-source-text';
import { type ComponentType, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Platform,
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { WebView } from 'react-native-webview';

import { colors } from '../../../lib/theme';
import { resolveHighlightLanguage } from '../../lib/highlightLanguage';
import { highlightCode, type HighlightedLines, type HighlightedToken } from '../../lib/highlights';
import {
  type NativeReviewDiffDebugEvent,
  type NativeReviewDiffViewProps,
  resolveNativeReviewDiffView,
} from '../diffs/nativeReviewDiffSurface';
import {
  createNativeReviewDiffTheme,
  MOBILE_CODE_SURFACE,
  type ResolvedMobileCodeSurface,
} from '../review/nativeReviewDiffAdapter';

import {
  buildNativeSourceTokens,
  createNativeSourceStyle,
  NATIVE_SOURCE_CONTENT_WIDTH,
  nativeSourceRowId,
} from './nativeSourceFileAdapter';
import {
  boundedSelectableSourceTokens,
  prepareSourceFileDocument,
  selectableSourceHtml,
} from './source-file-document';
import { createSourceLineScroll } from './source-file-scroll';

export const REVIEW_MONO_FONT_FAMILY = Platform.select({
  ios: 'ui-monospace',
  android: 'monospace',
  default: 'monospace',
});

export function renderVisibleWhitespace(value: string): string {
  const expandedTabs = value.replace(/\t/g, '    ');
  return expandedTabs.replace(/^( +)/, (leading) => leading.replaceAll(' ', '\u00A0'));
}

export type SourceHighlightStatus = 'ready' | 'plain' | 'error';
export type SourceSurfaceKind = 'native' | 'list' | 'selectable';

export interface SourceFileSurfaceProps {
  readonly contents: string;
  readonly path: string;
  readonly initialLine?: number | null;
  readonly selectable?: boolean;
  readonly onLongPressLine?: (line: number) => void;
  /** Companion: what rendered, for proofs. */
  readonly onRendered?: (rendered: SourceFileRendered) => void;
  /** Companion: the native view's debug events, such as `visible-range`. */
  readonly onDebug?: (event: NativeReviewDiffDebugEvent) => void;
}

export interface SourceFileRendered {
  readonly surface: SourceSurfaceKind;
  readonly language: string;
  readonly status: SourceHighlightStatus;
  readonly lineCount: number;
  readonly targetIndex: number | null;
  /** Lines whose tokens carry a lexer color. */
  readonly coloredLines: number;
  readonly error?: string;
}

const codeSurface = MOBILE_CODE_SURFACE;
const nativeSourceStyle = createNativeSourceStyle(codeSurface);
const nativeTheme = createNativeReviewDiffTheme();

const HighlightedSourceLine = function HighlightedSourceLine(props: {
  readonly codeSurface: ResolvedMobileCodeSurface;
  readonly index: number;
  readonly line: string;
  readonly tokens: ReadonlyArray<HighlightedToken> | null;
  readonly highlighted: boolean;
  readonly onLongPress?: () => void;
}) {
  const selectable = props.onLongPress === undefined;
  const row = (
    <View
      style={{
        flexDirection: 'row',
        minHeight: props.codeSurface.rowHeight,
        backgroundColor: props.highlighted ? `${colors.accent}1a` : undefined,
      }}
    >
      <Text
        style={{
          width: props.codeSurface.gutterWidth,
          paddingRight: 12,
          textAlign: 'right',
          color: colors.textMuted,
          fontFamily: REVIEW_MONO_FONT_FAMILY,
          fontSize: props.codeSurface.lineNumberFontSize,
          lineHeight: props.codeSurface.rowHeight,
        }}
      >
        {props.index + 1}
      </Text>
      <Text
        selectable={selectable}
        numberOfLines={1}
        style={{
          flex: 1,
          color: colors.textPrimary,
          fontFamily: REVIEW_MONO_FONT_FAMILY,
          fontSize: props.codeSurface.fontSize,
          lineHeight: props.codeSurface.rowHeight,
          minWidth: 320,
        }}
      >
        {props.tokens && props.tokens.length > 0
          ? (() => {
              let offset = 0;
              return props.tokens.map((token) => {
                const start = offset;
                offset += token.content.length;
                const fontWeight =
                  token.fontStyle !== null && (token.fontStyle & 2) === 2
                    ? ('700' as const)
                    : ('400' as const);
                const fontStyle =
                  token.fontStyle !== null && (token.fontStyle & 1) === 1
                    ? ('italic' as const)
                    : ('normal' as const);
                return (
                  <Text
                    key={`${start}:${token.content.length}:${token.color ?? ''}`}
                    selectable={selectable}
                    style={{
                      color: token.color ?? undefined,
                      fontFamily: REVIEW_MONO_FONT_FAMILY,
                      fontWeight,
                      fontStyle,
                    }}
                  >
                    {token.content.length > 0 ? renderVisibleWhitespace(token.content) : ' '}
                  </Text>
                );
              });
            })()
          : renderVisibleWhitespace(props.line || ' ')}
      </Text>
    </View>
  );
  const onLongPress = props.onLongPress;
  return onLongPress ? (
    <Pressable
      onLongPress={onLongPress}
      accessibilityActions={[{ name: 'longpress', label: 'Select text' }]}
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === 'longpress') onLongPress();
      }}
    >
      {row}
    </Pressable>
  ) : (
    row
  );
};

interface SourceHighlight {
  readonly language: string;
  readonly tokens: HighlightedLines | null;
  readonly status: SourceHighlightStatus;
  readonly error?: string;
}

function highlightSource(path: string, contents: string): SourceHighlight {
  const language = resolveHighlightLanguage({ path });
  if (language === 'text') return { language, tokens: null, status: 'plain' };
  // The native lexer can fail on a binary missing it or on input it rejects. The file still shows,
  // as plain text, and the status names the failure rather than dropping it.
  try {
    return { language, tokens: highlightCode(contents, language, 'dark'), status: 'ready' };
  } catch (cause) {
    return {
      language,
      tokens: null,
      status: 'error',
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

function useSourceFileModel(props: SourceFileSurfaceProps) {
  const document = prepareSourceFileDocument(props.contents);
  const { contents: normalizedContents, lines, rowsJson } = document;
  const targetIndex =
    props.initialLine !== null && props.initialLine !== undefined && props.initialLine > 0
      ? Math.min(Math.floor(props.initialLine) - 1, Math.max(0, lines.length - 1))
      : null;
  const highlight = useMemo(
    () => highlightSource(props.path, normalizedContents),
    [props.path, normalizedContents],
  );
  return { normalizedContents, lines, rowsJson, targetIndex, ...highlight };
}

function useReportRendered(
  props: SourceFileSurfaceProps,
  surface: SourceSurfaceKind,
  model: ReturnType<typeof useSourceFileModel>,
) {
  const { onRendered } = props;
  const { language, status, lines, targetIndex, tokens, error } = model;
  useLayoutEffect(() => {
    onRendered?.({
      surface,
      language,
      status,
      lineCount: lines.length,
      targetIndex,
      coloredLines: tokens?.filter((line) => line.some((token) => token.color)).length ?? 0,
      ...(error ? { error } : {}),
    });
  }, [onRendered, surface, language, status, lines, targetIndex, tokens, error]);
}

function SourceHighlightStatusView(props: {
  readonly status: SourceHighlightStatus;
  readonly error?: string;
}) {
  if (props.status !== 'error') return null;
  return (
    <View
      style={{
        borderBottomWidth: 1,
        borderColor: colors.bgCardHover,
        paddingHorizontal: 16,
        paddingVertical: 8,
      }}
    >
      <Text style={{ color: colors.textSecondary, fontSize: 10, textTransform: 'uppercase' }}>
        Plain text{props.error ? ` · ${props.error}` : ''}
      </Text>
    </View>
  );
}

function NativeSourceFileSurface(
  props: SourceFileSurfaceProps & {
    readonly NativeView: ComponentType<NativeReviewDiffViewProps>;
  },
) {
  const { NativeView, onLongPressLine } = props;
  const model = useSourceFileModel(props);
  const { rowsJson, status, targetIndex, tokens } = model;
  useReportRendered(props, 'native', model);
  const tokensJson = JSON.stringify(buildNativeSourceTokens(tokens));
  const selectedRowIdsJson = JSON.stringify(
    targetIndex === null ? [] : [nativeSourceRowId(targetIndex)],
  );
  const themeJson = JSON.stringify(nativeTheme);
  const styleJson = JSON.stringify(nativeSourceStyle);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bgSurface }}>
      <SourceHighlightStatusView status={status} error={model.error} />
      <NativeView
        collapsable={false}
        testID="source-native-code-view"
        style={{ flex: 1 }}
        appearanceScheme="dark"
        contentResetKey={props.path}
        contentWidth={NATIVE_SOURCE_CONTENT_WIDTH}
        contentInsetTop={0}
        contentInsetBottom={8}
        initialRowIndex={targetIndex ?? -1}
        rowHeight={nativeSourceStyle.rowHeight ?? codeSurface.rowHeight}
        rowsJson={rowsJson}
        selectedRowIdsJson={selectedRowIdsJson}
        styleJson={styleJson}
        themeJson={themeJson}
        tokensJson={tokensJson}
        onDebug={props.onDebug}
        onPressLine={({ nativeEvent }) => {
          if (nativeEvent.gesture === 'longPress' && nativeEvent.newLineNumber !== undefined) {
            onLongPressLine?.(nativeEvent.newLineNumber);
          }
        }}
      />
    </View>
  );
}

function JavaScriptSourceFileSurface(props: SourceFileSurfaceProps) {
  const foreground = colors.textPrimary;
  const model = useSourceFileModel(props);
  const { normalizedContents, lines, status, targetIndex, tokens } = model;
  useReportRendered(props, props.selectable ? 'selectable' : 'list', model);
  const selectableTokens = props.selectable ? boundedSelectableSourceTokens(tokens) : null;
  const listRef = useRef<FlatList<string>>(null);
  const [lineScroll] = useState(createSourceLineScroll);
  const { width } = useWindowDimensions();

  const usesLineList = !props.selectable;
  // Android lays out a full selectable TextView on the UI thread, which can stall large files.
  const usesWebSelection = props.selectable === true && Platform.OS === 'android';
  const usesTextSelection = props.selectable === true && !usesWebSelection;

  // Layout effect so a pending jump is cancelled in the commit that swaps the file.
  useLayoutEffect(() => {
    if (targetIndex === null || !usesLineList) {
      return;
    }
    lineScroll.scrollToLine(listRef.current, targetIndex);
    return lineScroll.cancel;
    // Opening another file at the same line index, or leaving selection mode, scrolls the remounted list to it.
  }, [lineScroll, props.path, targetIndex, usesLineList]);

  const { onLongPressLine } = props;
  const renderLine = ({ item, index }: { item: string; index: number }) => (
    <HighlightedSourceLine
      codeSurface={codeSurface}
      index={index}
      line={item}
      tokens={tokens?.[index] ?? null}
      highlighted={index === targetIndex}
      onLongPress={onLongPressLine ? () => onLongPressLine(index + 1) : undefined}
    />
  );

  // One native text view permits document-wide selection; virtualized rows cannot.
  const selectableBlock = usesTextSelection ? (
    <SourceText
      selectable
      style={{
        color: foreground,
        fontFamily: REVIEW_MONO_FONT_FAMILY,
        fontSize: codeSurface.fontSize,
        lineHeight: codeSurface.rowHeight,
      }}
    >
      {selectableTokens
        ? lines.map((line, index) => {
            const lineTokens = selectableTokens[index] ?? null;
            const body =
              lineTokens && lineTokens.length > 0
                ? lineTokens.map((token, tokenIndex) => (
                    <SourceText
                      key={`${index}:${tokenIndex}`}
                      style={{
                        color: token.color ?? foreground,
                        fontWeight:
                          token.fontStyle !== null && (token.fontStyle & 2) === 2 ? '700' : '400',
                        fontStyle:
                          token.fontStyle !== null && (token.fontStyle & 1) === 1
                            ? 'italic'
                            : 'normal',
                      }}
                    >
                      {token.content}
                    </SourceText>
                  ))
                : line;
            return (
              <SourceText key={index}>
                {body}
                {index < lines.length - 1 ? '\n' : ''}
              </SourceText>
            );
          })
        : normalizedContents}
    </SourceText>
  ) : null;

  const webSelection = usesWebSelection ? (
    <WebView
      source={{
        html: selectableSourceHtml(normalizedContents, {
          foreground,
          selection: colors.accent,
          fontSize: codeSurface.fontSize,
          rowHeight: codeSurface.rowHeight,
          wordBreak: false,
        }),
      }}
      originWhitelist={['*']}
      // Android pastes copied HTML as styled text with collapsed whitespace, so copy plain text.
      injectedJavaScript={`addEventListener("copy",(event)=>{event.clipboardData.setData("text/plain",getSelection().toString());event.preventDefault();});${
        targetIndex === null
          ? ''
          : `const line=document.getElementById("L${targetIndex + 1}");const reveal=()=>line?.scrollIntoView({block:"center"});reveal();addEventListener("resize",reveal,{once:true});`
      }true;`}
      domStorageEnabled={false}
      cacheEnabled={false}
      setSupportMultipleWindows={false}
      onShouldStartLoadWithRequest={(request) => request.url === 'about:blank'}
      style={{ flex: 1, backgroundColor: 'transparent' }}
    />
  ) : null;

  const list = (
    <FlatList
      ref={listRef}
      data={lines}
      keyExtractor={(_line, index) => String(index)}
      initialNumToRender={80}
      maxToRenderPerBatch={80}
      windowSize={12}
      getItemLayout={(_data, index) => ({
        length: codeSurface.rowHeight,
        offset: codeSurface.rowHeight * index,
        index,
      })}
      contentContainerStyle={{
        minWidth: width,
        paddingBottom: codeSurface.rowHeight,
        paddingTop: 8,
      }}
      renderItem={renderLine}
      onScrollToIndexFailed={lineScroll.onScrollToIndexFailed}
      onScrollBeginDrag={lineScroll.cancel}
    />
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.bgSurface }}>
      {usesWebSelection ? null : <SourceHighlightStatusView status={status} error={model.error} />}
      {usesLineList ? (
        <ScrollView horizontal bounces={false} style={{ flex: 1 }}>
          {list}
        </ScrollView>
      ) : usesWebSelection ? (
        webSelection
      ) : (
        <ScrollView horizontal bounces={false} style={{ flex: 1 }}>
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{
              paddingBottom: codeSurface.rowHeight,
              paddingHorizontal: 12,
              paddingTop: 8,
            }}
          >
            {selectableBlock}
          </ScrollView>
        </ScrollView>
      )}
    </View>
  );
}

export function SourceFileSurface(props: SourceFileSurfaceProps) {
  const NativeView = resolveNativeReviewDiffView();
  return NativeView && !props.selectable ? (
    <NativeSourceFileSurface {...props} NativeView={NativeView} />
  ) : (
    <JavaScriptSourceFileSurface {...props} />
  );
}
