import React from 'react';
import {
  type StyleProp,
  StyleSheet,
  Text,
  type TextStyle,
  View,
  type ViewStyle,
} from 'react-native';

import { hudIntentDisplay } from '@farmslot/protocol/recipe';

// react-native-screens' FullWindowOverlay (iOS) paints in a UIWindow above every
// native layer — including native-stack modal screens (sheets, perps-style modal
// presentations) — which a plain root-level absolute View cannot reach. Resolve
// it optionally so this proof HUD also works in Siteed apps that copy the demo
// without installing react-native-screens: when the module is absent we fall back
// to the root View (the HUD is then hidden behind native modals — a documented
// known limitation). On Android/web FullWindowOverlay is a passthrough.
const FullWindowOverlay = resolveFullWindowOverlay();

function resolveFullWindowOverlay(): React.ComponentType<{
  children: React.ReactNode;
  unstable_accessibilityContainerViewIsModal?: boolean;
}> | null {
  try {
    return require('react-native-screens').FullWindowOverlay ?? null;
  } catch (error) {
    // Expected & recoverable ONLY when react-native-screens is not installed
    // (it is an optional peer for the proof HUD). Any other failure is a real
    // bug and must surface rather than be swallowed.
    if ((error as { code?: string }).code === 'MODULE_NOT_FOUND') return null;
    throw error;
  }
}

export type FarmslotRecipeHudStatus = 'idle' | 'running' | 'pass' | 'fail';

export interface FarmslotRecipeHudState {
  status: FarmslotRecipeHudStatus;
  intent: string;
  currentStep?: number;
  totalSteps?: number;
  error?: string;
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

export interface RecipeHudOptions {
  text?: FarmslotRecipeHudText;
  styles?: FarmslotRecipeHudStyles;
}

export interface RecipeHudProps extends RecipeHudOptions {
  state: FarmslotRecipeHudState | null;
}

export function RecipeHud({
  state,
  styles: customStyles,
  text,
}: Readonly<RecipeHudProps>): React.ReactElement | null {
  if (!state || state.status === 'idle') return null;
  const badge = text?.badge?.(state) ?? formatBadge(state);
  const intent = hudIntentDisplay(text?.intent?.(state) ?? state.intent, 'native');
  const error = text?.error?.(state) ?? state.error;
  const badgeTone = badgeToneForStatus(state.status);
  const overlay = (
    <View
      accessibilityElementsHidden
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={[
        styles.container,
        customStyles?.container,
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
  return FullWindowOverlay ? (
    <FullWindowOverlay unstable_accessibilityContainerViewIsModal={false}>
      {overlay}
    </FullWindowOverlay>
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
