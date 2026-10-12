import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  type StyleProp,
  StyleSheet,
  Text,
  type TextStyle,
  View,
  type ViewProps,
  type ViewStyle,
} from 'react-native';

import {
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

/** Bridge acknowledgement follows the committed HUD rather than the state setter. */
export function useRecipeHudState(): RecipeHudStateController {
  const [state, setState] = useState<FarmslotRecipeHudState | null>(null);
  const current = useRef(state);
  current.current = state;
  const pending = useRef<(() => void)[]>([]);
  const update = useCallback((next: FarmslotRecipeHudState | null) => {
    if (next === current.current) return Promise.resolve();
    return new Promise<void>((resolve) => {
      pending.current.push(resolve);
      setState(next);
    });
  }, []);
  useEffect(() => {
    const acknowledgements = pending.current.splice(0);
    if (acknowledgements.length)
      void waitForHudPaint(requestAnimationFrame).then(() => {
        for (const acknowledge of acknowledgements) acknowledge();
      });
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

export function RecipeHud({
  state,
  styles: customStyles,
  text,
  overlay: Overlay,
  onLayout,
}: Readonly<RecipeHudProps>): React.ReactElement | null {
  if (!state || state.status === 'idle') return null;
  const badge = text?.badge?.(state) ?? formatBadge(state);
  const intent = hudIntentDisplay(text?.intent?.(state) ?? state.intent, 'native');
  const error = text?.error?.(state) ?? state.error;
  const badgeTone = badgeToneForStatus(state.status);
  const overlay = (
    <View
      onLayout={onLayout}
      accessibilityElementsHidden
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={[
        styles.container,
        state.position === 'top' ? { top: 16, bottom: undefined } : undefined,
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
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text
          {...intent.nativeProps}
          style={[styles.line, customStyles?.line, customStyles?.intent, intent.nativeStyle]}
        >
          {intent.text}
        </Text>
        {error ? (
          <Text
            numberOfLines={1}
            allowFontScaling={false}
            style={[styles.error, customStyles?.error, { lineHeight: 16, maxHeight: 16 }]}
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

function formatBadge(state: FarmslotRecipeHudState): string {
  const status = state.status === 'running' ? 'run' : state.status;
  const progress = formatProgress(state.currentStep, state.totalSteps);
  return [status, progress].filter(Boolean).join(' ').toUpperCase();
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
    paddingVertical: 3,
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
  error: {
    color: '#e6e6e6',
    fontSize: 10,
    fontWeight: '400',
    lineHeight: 12,
  },
});
