import type { StandardUiAction, UiActionTransport } from '../adapters/ui.js';
import type { ActionExecutionContext } from '../core/types.js';

export type ReactNativeBridgeCommandName =
  | 'navigate'
  | 'press'
  | 'keyPress'
  | 'setInput'
  | 'scroll'
  | 'gesture'
  | 'waitFor'
  | 'screenshot'
  | 'status'
  | 'lifecycle'
  | 'hud'
  | 'trace';

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
  'ui.gesture': 'gesture',
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
  };
}

export const createReactNativeCdpBridgeUiTransport = createReactNativeBridgeUiTransport;
