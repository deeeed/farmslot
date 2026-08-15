import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

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

interface RecipeHudProps {
  state: FarmslotRecipeHudState | null;
}

export function RecipeHud({ state }: Readonly<RecipeHudProps>): React.ReactElement | null {
  if (!state || state.status === 'idle') return null;
  const progress = formatProgress(state.currentStep, state.totalSteps);
  const overlay = (
    <View
      accessibilityElementsHidden
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={styles.container}
    >
      <View style={[styles.pill, state.status === 'fail' ? styles.fail : styles.active]}>
        <Text style={styles.pillText}>
          {state.status.toUpperCase()}
          {progress ? ` ${progress}` : ''}
        </Text>
      </View>
      <View style={styles.copy}>
        <Text numberOfLines={1} style={styles.intent}>
          {state.intent}
        </Text>
        {state.error ? (
          <Text numberOfLines={1} style={styles.error}>
            {state.error}
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

function formatProgress(currentStep?: number, totalSteps?: number): string {
  if (!currentStep || !totalSteps) return '';
  return `${currentStep}/${totalSteps}`;
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 16,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    borderRadius: 12,
    padding: 8,
    backgroundColor: 'rgba(10, 12, 16, 0.78)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.18)',
  },
  pill: {
    borderRadius: 999,
    paddingHorizontal: 6,
    paddingVertical: 2,
    marginTop: 1,
  },
  active: {
    backgroundColor: 'rgba(16, 185, 129, 0.22)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#10b981',
  },
  fail: {
    backgroundColor: 'rgba(239, 68, 68, 0.22)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#ef4444',
  },
  pillText: {
    color: '#ffffff',
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  copy: {
    flex: 1,
    minWidth: 0,
  },
  intent: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '700',
  },
  error: {
    color: '#fca5a5',
    fontSize: 11,
    marginTop: 1,
  },
});
