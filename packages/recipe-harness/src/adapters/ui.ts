import type { UiObserverRef } from '@farmslot/protocol';

import type {
  ActionAdapter,
  ActionExecutionContext,
  ActionResult,
  RecipeActionPhase,
  RecipeObservationResult,
} from '../core/types.js';

export const STANDARD_UI_ACTIONS = [
  'ui.navigate',
  'ui.press',
  'ui.key_press',
  'ui.set_input',
  'ui.scroll',
  'ui.swipe',
  'ui.pan',
  'ui.drag',
  'ui.long_press',
  'ui.wait_for',
  'ui.screenshot',
  'app.status',
  'app.lifecycle',
  'app.hud',
  'app.trace',
] as const;

export type StandardUiAction = (typeof STANDARD_UI_ACTIONS)[number];

export interface UiTransportControl {
  case?: string;
  artifacts?: ActionResult['artifacts'];
}

export interface UiTransportResult {
  output?: unknown;
  control?: UiTransportControl;
  phases?: RecipeActionPhase[];
}

export interface UiActionTransport {
  execute(
    action: StandardUiAction,
    node: Record<string, unknown>,
    context: ActionExecutionContext,
  ): Promise<unknown | UiTransportResult>;
  observe?(
    refs: readonly UiObserverRef[],
    node: Record<string, unknown>,
    context: ActionExecutionContext,
  ): Promise<RecipeObservationResult>;
}

export interface CreateStandardUiAdaptersOptions {
  transport: UiActionTransport;
  actions?: Iterable<string>;
}

export function createStandardUiAdapters(
  options: CreateStandardUiAdaptersOptions,
): ActionAdapter[] {
  const requestedActions = options.actions ? new Set(options.actions) : null;
  return STANDARD_UI_ACTIONS.filter(
    (action) => !requestedActions || requestedActions.has(action),
  ).map((action) => ({
    action,
    source: {
      kind: 'bundled' as const,
      trust: 'trusted' as const,
      name: '@farmslot/recipe-harness',
    },
    async execute(node, context) {
      return normalizeUiTransportResult(await options.transport.execute(action, node, context));
    },
    async observe(refs, node, context) {
      if (!options.transport.observe) {
        return {
          warnings: refs.map((ref) => ({
            ref,
            message: `UI transport does not implement passive observer ${ref}.`,
          })),
        };
      }
      return options.transport.observe(refs, node, context);
    },
  }));
}

export function normalizeUiTransportResult(result: unknown): ActionResult {
  if (isUiTransportResult(result)) {
    return {
      case: result.control?.case,
      artifacts: result.control?.artifacts,
      output: result.output,
      phases: result.phases,
    };
  }
  return { output: result ?? { ok: true } };
}

function isUiTransportResult(value: unknown): value is UiTransportResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return (
    Object.prototype.hasOwnProperty.call(value, 'control') ||
    Object.prototype.hasOwnProperty.call(value, 'phases')
  );
}
