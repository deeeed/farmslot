import React, { createContext, useEffect, useMemo, useState } from 'react';
import { Dimensions, Platform, View } from 'react-native';

import { useRecipeBridgeRelay } from './recipe-bridge-relay';
import { type FarmslotRecipeHudState, RecipeHud } from './RecipeHud';

export interface FarmslotRecipeBridgeCommand {
  command: string;
  nodeId: string;
  payload?: Record<string, unknown>;
}

export interface FarmslotRecipeBridgeApi {
  handleCommand(command: FarmslotRecipeBridgeCommand): Promise<unknown>;
}

export interface FarmslotRecipeUiObservation {
  observations?: Record<string, unknown>;
  warnings?: Array<{ ref: string; message: string }>;
}

export interface RecipeBridgeProviderOptions {
  bridgeName?: string;
  isEnabled?: () => boolean;
  renderHud?: (state: FarmslotRecipeHudState | null) => React.ReactNode;
  observeUi?: (
    refs: readonly string[],
  ) => FarmslotRecipeUiObservation | Promise<FarmslotRecipeUiObservation>;
}

declare global {
  var __FARMSLOT_RECIPE_BRIDGE__: FarmslotRecipeBridgeApi | undefined;
  var __FARMSLOT_RECIPE_OBSERVER__:
    | ((
        refs: readonly string[],
      ) => FarmslotRecipeUiObservation | Promise<FarmslotRecipeUiObservation>)
    | undefined;
}

export const FarmslotRecipeBridgeContext = createContext<FarmslotRecipeBridgeApi | null>(null);

interface RecipeBridgeProviderProps extends RecipeBridgeProviderOptions {
  children: React.ReactNode;
}

export function RecipeBridgeProvider({
  bridgeName = '@farmslot/expo-recipe',
  children,
  isEnabled = isRecipeBridgeEnabled,
  renderHud,
  observeUi,
}: Readonly<RecipeBridgeProviderProps>): React.ReactElement {
  const enabled = isEnabled();
  const [hud, setHud] = useState<FarmslotRecipeHudState | null>(null);

  const bridge = useMemo<FarmslotRecipeBridgeApi>(
    () => ({
      async handleCommand(command) {
        if (!enabled) {
          return { ok: false, error: 'Farmslot recipe bridge is disabled.' };
        }
        if (command.command === 'status') {
          return { ok: true, bridge: bridgeName, platform: Platform.OS, hud: true };
        }
        if (command.command === 'hud') {
          setHud(normalizeHudState(command.payload));
          return { ok: true };
        }
        if (command.command === 'trace') {
          return { ok: true, trace: command.payload ?? {} };
        }
        if (command.command === 'observeUi') {
          const refs = Array.isArray(command.payload?.refs)
            ? command.payload.refs.filter((ref): ref is string => typeof ref === 'string')
            : [];
          const observer = observeUi ?? globalThis.__FARMSLOT_RECIPE_OBSERVER__;
          const observed = observer
            ? await observer(refs)
            : defaultObserveUi(refs, { bridgeName, hud });
          return { ok: true, ...observed };
        }
        return { ok: false, error: `Unsupported Farmslot bridge command: ${command.command}` };
      },
    }),
    [bridgeName, enabled, hud, observeUi],
  );

  useRecipeBridgeRelay(bridge, enabled);

  useEffect(() => {
    if (!enabled) return;
    globalThis.__FARMSLOT_RECIPE_BRIDGE__ = bridge;
    return () => {
      if (globalThis.__FARMSLOT_RECIPE_BRIDGE__ === bridge) {
        globalThis.__FARMSLOT_RECIPE_BRIDGE__ = undefined;
      }
    };
  }, [bridge, enabled]);

  if (!enabled) return <>{children}</>;

  return (
    <FarmslotRecipeBridgeContext.Provider value={bridge}>
      <View style={{ flex: 1 }}>
        {children}
        {renderHud ? renderHud(hud) : <RecipeHud state={hud} />}
      </View>
    </FarmslotRecipeBridgeContext.Provider>
  );
}

function defaultObserveUi(
  refs: readonly string[],
  state: { bridgeName: string; hud: FarmslotRecipeHudState | null },
): FarmslotRecipeUiObservation {
  const observations: Record<string, unknown> = {};
  const warnings: Array<{ ref: string; message: string }> = [];
  const window = Dimensions.get('window');
  for (const ref of refs) {
    if (ref === 'ui.screen') {
      observations[ref] = {
        provider: state.bridgeName,
        name: 'ReactNativeApp',
        route: undefined,
        title: state.hud?.intent,
        platform: Platform.OS,
      };
    } else if (ref === 'ui.visible') {
      const items = state.hud?.intent
        ? [
            {
              role: 'status',
              label: state.hud.intent,
              test_id: 'farmslot-recipe-hud',
              selector: 'farmslot-recipe-hud',
              enabled: true,
            },
          ]
        : [];
      observations[ref] = {
        provider: state.bridgeName,
        items,
        hidden_or_offscreen: [],
        truncated: false,
        viewport: { width: window.width, height: window.height },
        hints: [
          'Provide RecipeBridgeProvider.observeUi to expose app-specific Pressable/TextInput handles.',
        ],
      };
    } else {
      warnings.push({ ref, message: `Unsupported UI observer: ${ref}.` });
    }
  }
  return {
    ...(Object.keys(observations).length ? { observations } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
}

function isRecipeBridgeEnabled(): boolean {
  return Boolean(__DEV__ && process.env.EXPO_PUBLIC_FARMSLOT_RECIPE_BRIDGE === '1');
}

function normalizeHudState(payload: Record<string, unknown> | undefined): FarmslotRecipeHudState {
  const status = parseStatus(payload?.status);
  const progress = isRecord(payload?.progress) ? payload.progress : undefined;
  return {
    status,
    intent: asString(
      payload?.intent ?? payload?.text,
      status === 'fail' ? 'Recipe failed' : 'Recipe HUD missing intent',
    ),
    currentStep: asOptionalNumber(
      payload?.currentStep ?? payload?.current_step ?? progress?.current,
    ),
    totalSteps: asOptionalNumber(payload?.totalSteps ?? payload?.total_steps ?? progress?.total),
    error: asOptionalString(payload?.error),
  };
}

function parseStatus(value: unknown): FarmslotRecipeHudState['status'] {
  if (value === 'idle' || value === 'running' || value === 'pass' || value === 'fail') return value;
  return 'running';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
