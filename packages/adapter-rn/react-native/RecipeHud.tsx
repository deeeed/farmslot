import React, { useCallback, useContext, useEffect, useRef, useState } from 'react';
import {
  type StyleProp,
  StyleSheet,
  Text,
  type TextStyle,
  View,
  type ViewProps,
  type ViewStyle,
} from 'react-native';
import { initialWindowMetrics, SafeAreaInsetsContext } from 'react-native-safe-area-context';

import {
  HUD_COLORS,
  HUD_NATIVE_FINISHED_FONT_SIZE,
  HUD_NATIVE_FINISHED_LINE_HEIGHT,
  HUD_NATIVE_INTENT_LINE_HEIGHT,
  HUD_NATIVE_INTENT_MAX_LINES,
  HUD_PANEL_BOUNDS,
  hudFinishedLine,
  type HudFinishedStep,
  hudIntentDisplay,
  type RecipeHudPlacement,
  waitForHudPaint,
} from '@farmslot/protocol/recipe';

export type FarmslotRecipeHudStatus = 'idle' | 'running' | 'pass' | 'fail';

export interface FarmslotRecipeHudState {
  status: FarmslotRecipeHudStatus;
  intent: string;
  currentStep?: number;
  totalSteps?: number;
  error?: string;
  position?: RecipeHudPlacement;
}

export type RecipeHudStateController = readonly [
  FarmslotRecipeHudState | null,
  (state: FarmslotRecipeHudState | null) => Promise<void>,
];

interface HudAcknowledgement {
  resolve(): void;
  reject(error: unknown): void;
}

/** Bridge acknowledgement follows the committed HUD rather than the state setter. */
export function useRecipeHudState(): RecipeHudStateController {
  const [state, setState] = useState<FarmslotRecipeHudState | null>(null);
  const current = useRef(state);
  current.current = state;
  const pending = useRef<HudAcknowledgement[]>([]);
  const lifecycle = useRef<AbortController | null>(null);
  const update = useCallback((next: FarmslotRecipeHudState | null) => {
    if (next === current.current) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      pending.current.push({ resolve, reject });
      setState(next);
    });
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    lifecycle.current = controller;
    return () => {
      const error = new Error('HUD provider unmounted.');
      controller.abort(error);
      for (const acknowledgement of pending.current.splice(0)) acknowledgement.reject(error);
    };
  }, []);
  useEffect(() => {
    const acknowledgements = pending.current.splice(0);
    if (acknowledgements.length)
      void waitForHudPaint(requestAnimationFrame, lifecycle.current?.signal).then(
        () => {
          for (const acknowledgement of acknowledgements) acknowledgement.resolve();
        },
        (error: unknown) => {
          for (const acknowledgement of acknowledgements) acknowledgement.reject(error);
        },
      );
  }, [state]);
  return [state, update];
}

export interface FarmslotRecipeHudText {
  badge?: (state: FarmslotRecipeHudState) => string;
  intent?: (state: FarmslotRecipeHudState) => string;
  error?: (state: FarmslotRecipeHudState) => string | undefined;
}

export interface FarmslotRecipeHudStyles {
  container?: StyleProp<ViewStyle>;
  line?: StyleProp<TextStyle>;
  badgeText?: StyleProp<TextStyle>;
  badgeTextRunning?: StyleProp<TextStyle>;
  badgeTextPass?: StyleProp<TextStyle>;
  badgeTextFail?: StyleProp<TextStyle>;
  intent?: StyleProp<TextStyle>;
  error?: StyleProp<TextStyle>;
}

export interface RecipeHudOverlayProps {
  children: React.ReactNode;
  unstable_accessibilityContainerViewIsModal?: boolean;
}

export interface RecipeHudOptions {
  overlay?: React.ComponentType<RecipeHudOverlayProps>;
  text?: FarmslotRecipeHudText;
  styles?: FarmslotRecipeHudStyles;
}

export interface RecipeHudProps extends RecipeHudOptions {
  onLayout?: ViewProps['onLayout'];
  state: FarmslotRecipeHudState | null;
}

const PADDING_VERTICAL = 3;
const ERROR_LINE_HEIGHT = 16;
// The native panel never grows: the finished row shows only while two intent
// lines, that row and an error line still fit its height.
const FINISHED_ROW_FITS =
  PADDING_VERTICAL * 2 +
    HUD_NATIVE_INTENT_LINE_HEIGHT * HUD_NATIVE_INTENT_MAX_LINES +
    HUD_NATIVE_FINISHED_LINE_HEIGHT +
    ERROR_LINE_HEIGHT <=
  HUD_PANEL_BOUNDS.native.maxHeight;

export function RecipeHud({
  state,
  styles: customStyles,
  text,
  overlay: Overlay,
  onLayout,
}: Readonly<RecipeHudProps>): React.ReactElement | null {
  const insets = useContext(SafeAreaInsetsContext) ?? initialWindowMetrics?.insets;
  const lastFinished = useRef<HudFinishedStep | null>(null);
  if (!state || state.status === 'idle') {
    lastFinished.current = null;
    return null;
  }
  const badge = text?.badge?.(state);
  const intent = hudIntentDisplay(text?.intent?.(state) ?? state.intent, 'native');
  const error = text?.error?.(state) ?? state.error;
  const badgeTone = badgeToneForStatus(state.status);
  // The HUD state has no node id: a step is its number and intent.
  const step = `${state.currentStep ?? ''}:${intent.text}`;
  if (state.status === 'pass' || state.status === 'fail')
    lastFinished.current = { nodeId: step, intent: intent.text, status: state.status };
  const finished = FINISHED_ROW_FITS ? hudFinishedLine(lastFinished.current, step) : null;
  const progress = FINISHED_ROW_FITS ? formatProgress(state.currentStep, state.totalSteps) : '';
  const overlay = (
    <View
      onLayout={onLayout}
      accessibilityElementsHidden
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={[
        styles.container,
        state.position === 'top' ? { top: (insets?.top ?? 0) + 16, bottom: undefined } : undefined,
        customStyles?.container,
        state.position === 'top'
          ? { bottom: undefined }
          : state.position === 'bottom'
            ? { top: undefined }
            : undefined,
        intent.panel,
        { overflow: 'hidden', flexDirection: 'row' },
      ]}
    >
      {badge ? (
        <Text
          numberOfLines={1}
          allowFontScaling={false}
          style={[
            styles.badgeText,
            badgeTone === 'fail'
              ? styles.badgeTextFail
              : badgeTone === 'pass'
                ? styles.badgeTextPass
                : styles.badgeTextRunning,
            customStyles?.badgeText,
            badgeTone === 'fail'
              ? customStyles?.badgeTextFail
              : badgeTone === 'pass'
                ? customStyles?.badgeTextPass
                : customStyles?.badgeTextRunning,
            { maxWidth: 80, marginRight: 8 },
          ]}
        >
          {badge}
        </Text>
      ) : null}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text
          {...intent.nativeProps}
          style={[styles.line, customStyles?.line, customStyles?.intent, intent.nativeStyle]}
        >
          {intent.text}
        </Text>
        {finished || progress ? (
          <View style={styles.finishedRow}>
            <Text
              numberOfLines={1}
              allowFontScaling={false}
              style={[styles.finished, finished?.tone === 'fail' ? styles.failed : undefined]}
            >
              {finished?.text}
            </Text>
            {progress ? (
              <Text numberOfLines={1} allowFontScaling={false} style={styles.progress}>
                {progress}
              </Text>
            ) : null}
          </View>
        ) : null}
        {error ? (
          <Text
            numberOfLines={1}
            allowFontScaling={false}
            style={[
              styles.error,
              customStyles?.error,
              { lineHeight: ERROR_LINE_HEIGHT, maxHeight: ERROR_LINE_HEIGHT },
            ]}
          >
            {error}
          </Text>
        ) : null}
      </View>
    </View>
  );
  return Overlay ? (
    <Overlay unstable_accessibilityContainerViewIsModal={false}>{overlay}</Overlay>
  ) : (
    overlay
  );
}

function formatProgress(currentStep?: number, totalSteps?: number): string {
  if (!currentStep || !totalSteps) return '';
  return `${currentStep}/${totalSteps}`;
}

function badgeToneForStatus(status: FarmslotRecipeHudStatus): 'running' | 'pass' | 'fail' {
  if (status === 'fail') return 'fail';
  if (status === 'pass') return 'pass';
  return 'running';
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 16,
    zIndex: 9999,
    backgroundColor: 'rgba(0, 0, 0, 0.58)',
    paddingHorizontal: 10,
    paddingVertical: PADDING_VERTICAL,
  },
  line: {
    color: '#ffffff',
    fontSize: 11,
    fontWeight: '700',
    lineHeight: 14,
  },
  badgeText: {
    fontSize: 9,
    fontWeight: '800',
  },
  badgeTextRunning: {
    color: '#00ff88',
  },
  badgeTextPass: {
    color: '#00ff88',
  },
  badgeTextFail: {
    color: '#ff4d4f',
  },
  finishedRow: {
    flexDirection: 'row',
  },
  finished: {
    flex: 1,
    color: HUD_COLORS.muted,
    fontSize: HUD_NATIVE_FINISHED_FONT_SIZE,
    lineHeight: HUD_NATIVE_FINISHED_LINE_HEIGHT,
  },
  failed: {
    color: HUD_COLORS.fail,
  },
  progress: {
    marginLeft: 6,
    color: HUD_COLORS.muted,
    fontSize: HUD_NATIVE_FINISHED_FONT_SIZE,
    lineHeight: HUD_NATIVE_FINISHED_LINE_HEIGHT,
  },
  error: {
    color: '#e6e6e6',
    fontSize: 10,
    fontWeight: '400',
    lineHeight: 12,
  },
});
