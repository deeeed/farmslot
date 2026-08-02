import type { UiObserverRef } from '@farmslot/protocol';

import type { StandardUiAction, UiActionTransport } from '../adapters/ui.js';
import type { ActionExecutionContext, RecipeObservationResult } from '../core/types.js';

export type ReactNativeBridgeCommandName =
  | 'navigate'
  | 'press'
  | 'keyPress'
  | 'setInput'
  | 'scroll'
  | 'swipe'
  | 'pan'
  | 'drag'
  | 'longPress'
  | 'waitFor'
  | 'screenshot'
  | 'status'
  | 'lifecycle'
  | 'hud'
  | 'trace'
  | 'observeUi';

export interface ReactNativeBridgeCommand {
  command: ReactNativeBridgeCommandName;
  nodeId: string;
  payload: Record<string, unknown>;
}

export interface ReactNativeBridge {
  send(command: ReactNativeBridgeCommand, context: ActionExecutionContext): Promise<unknown>;
}

export interface CreateReactNativeBridgeUiTransportOptions {
  bridge: ReactNativeBridge;
}

const RN_COMMANDS: Record<StandardUiAction, ReactNativeBridgeCommandName> = {
  'ui.navigate': 'navigate',
  'ui.press': 'press',
  'ui.key_press': 'keyPress',
  'ui.set_input': 'setInput',
  'ui.scroll': 'scroll',
  'ui.swipe': 'swipe',
  'ui.pan': 'pan',
  'ui.drag': 'drag',
  'ui.long_press': 'longPress',
  'ui.wait_for': 'waitFor',
  'ui.screenshot': 'screenshot',
  'app.status': 'status',
  'app.lifecycle': 'lifecycle',
  'app.hud': 'hud',
  'app.trace': 'trace',
};

export function createReactNativeBridgeUiTransport(
  options: CreateReactNativeBridgeUiTransportOptions,
): UiActionTransport {
  return {
    async execute(action, node, context) {
      const { action: _action, ...payload } = node;
      return options.bridge.send(
        { command: RN_COMMANDS[action], nodeId: context.nodeId, payload },
        context,
      );
    },
    async observe(refs: readonly UiObserverRef[], node, context): Promise<RecipeObservationResult> {
      const result = await options.bridge.send(
        {
          command: 'observeUi',
          nodeId: context.nodeId,
          payload: { refs, node },
        },
        context,
      );
      return normalizeBridgeObservationResult(result, refs);
    },
  };
}

export const createReactNativeCdpBridgeUiTransport = createReactNativeBridgeUiTransport;

function normalizeBridgeObservationResult(
  result: unknown,
  refs: readonly UiObserverRef[],
): RecipeObservationResult {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return {
      warnings: refs.map((ref) => ({ ref, message: 'Bridge observeUi returned no object.' })),
    };
  }
  const record = result as Record<string, unknown>;
  if (record.ok === false) {
    const message = typeof record.error === 'string' ? record.error : 'Bridge observeUi failed.';
    return { warnings: refs.map((ref) => ({ ref, message })) };
  }
  const observations = record.observations;
  const warnings = record.warnings;
  return {
    ...(observations && typeof observations === 'object' && !Array.isArray(observations)
      ? { observations: observations as RecipeObservationResult['observations'] }
      : {}),
    ...(Array.isArray(warnings)
      ? { warnings: warnings as RecipeObservationResult['warnings'] }
      : {}),
  };
}
