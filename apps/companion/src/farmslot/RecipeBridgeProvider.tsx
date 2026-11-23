import React, { createContext, useEffect, useMemo, useRef } from 'react';
import { Dimensions, Platform, View } from 'react-native';
import { FullWindowOverlay } from 'react-native-screens';

import { resolveRecipeUiObservation } from '../lib/recipe-ui-observation';

import { useRecipeBridgeRelay } from './recipe-bridge-relay';
import { normalizeHudState } from './recipe-hud-state';
import { type FarmslotRecipeHudState, RecipeHud, useRecipeHudState } from './RecipeHud';

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

export type FarmslotRecipeUiObserver = (
  refs: readonly string[],
) => FarmslotRecipeUiObservation | undefined | Promise<FarmslotRecipeUiObservation | undefined>;

export interface RecipeBridgeProviderOptions {
  bridgeName?: string;
  isEnabled?: () => boolean;
  renderHud?: (state: FarmslotRecipeHudState | null) => React.ReactNode;
  observeUi?: FarmslotRecipeUiObserver;
}

declare global {
  var __FARMSLOT_RECIPE_BRIDGE__: FarmslotRecipeBridgeApi | undefined;
  var __FARMSLOT_RECIPE_OBSERVER__: FarmslotRecipeUiObserver | undefined;
}

export const FarmslotRecipeBridgeContext = createContext<FarmslotRecipeBridgeApi | null>(null);
export const RecipeHudContext = createContext<FarmslotRecipeHudState | null>(null);

interface RecipeBridgeProviderProps extends RecipeBridgeProviderOptions {
  children: React.ReactNode;
}

export function RecipeBridgeProvider({
  bridgeName = '@farmslot/adapter-rn',
  children,
  isEnabled = isRecipeBridgeEnabled,
  renderHud,
  observeUi,
}: Readonly<RecipeBridgeProviderProps>): React.ReactElement {
  const enabled = isEnabled();
  const [hud, setHud] = useRecipeHudState();
  const hudRef = useRef(hud);
  hudRef.current = hud;

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
          // `clear` is part of the app.hud action manifest; it hides the HUD.
          await setHud(command.payload?.clear === true ? null : normalizeHudState(command.payload));
          return { ok: true };
        }
        if (command.command === 'trace') {
          return { ok: true, trace: command.payload ?? {} };
        }
        if (command.command === 'observeUi') {
          const refs = Array.isArray(command.payload?.refs)
            ? command.payload.refs.filter((ref): ref is string => typeof ref === 'string')
            : [];
          const observed = await resolveRecipeUiObservation(
            refs,
            observeUi,
            globalThis.__FARMSLOT_RECIPE_OBSERVER__,
            () => defaultObserveUi(refs, { bridgeName, hud: hudRef.current }),
          );
          return { ok: true, ...observed };
        }
        return { ok: false, error: `Unsupported Farmslot bridge command: ${command.command}` };
      },
    }),
    [bridgeName, enabled, observeUi, setHud],
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
      <RecipeHudContext.Provider value={hud}>
        <View style={{ flex: 1 }}>
          {children}
          {renderHud ? (
            renderHud(hud)
          ) : (
            <RecipeHud
              state={hud}
              overlay={Platform.OS === 'ios' ? FullWindowOverlay : undefined}
            />
          )}
        </View>
      </RecipeHudContext.Provider>
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
