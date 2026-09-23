import type { UiObserverRef } from '@farmslot/protocol';

import { RecipeExecutionError } from '../core/failure.js';
import { isRecord } from '../core/json.js';
import {
  parseUiScrollToRequest,
  runUiScrollTo,
  type UiScrollSession,
  UiScrollToError,
  type UiScrollToRequest,
  uiScrollToRequestSummary,
} from '../core/scroll-to.js';
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
  'ui.scroll_to',
  'ui.swipe',
  'ui.pan',
  'ui.drag',
  'ui.long_press',
  'ui.wait_for',
  'ui.screenshot',
  'ui.capture_surface',
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
  kind: 'ui-transport-result';
  output?: unknown;
  control?: UiTransportControl;
  phases?: RecipeActionPhase[];
  settlementWarning?: string;
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
  /**
   * ui.scroll_to provider hook. Open (or reuse) the backend session, hand it to `use`, and release
   * it before resolving so the next node never conflicts with this one. Throw UiScrollToError
   * SCROLL_SESSION_CONFLICT when the backend is held by another session.
   */
  withScrollSession?<T>(
    request: UiScrollToRequest,
    node: Record<string, unknown>,
    context: ActionExecutionContext,
    use: (session: UiScrollSession) => Promise<T>,
  ): Promise<T>;
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
      if (action === 'ui.scroll_to') return executeScrollTo(options.transport, node, context);
      if (action === 'ui.scroll') assertScrollMovement(node);
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

async function executeScrollTo(
  transport: UiActionTransport,
  node: Record<string, unknown>,
  context: ActionExecutionContext,
): Promise<ActionResult> {
  const request = parseUiScrollToRequest(node);
  if (!transport.withScrollSession) {
    throw new UiScrollToError(
      'SCROLL_UNSUPPORTED',
      'this UI transport does not implement withScrollSession.',
      uiScrollToRequestSummary(request),
    );
  }
  try {
    return {
      output: await transport.withScrollSession(request, node, context, (session) =>
        runUiScrollTo(request, session),
      ),
    };
  } catch (error) {
    // Provider errors raised before a session exists (for example a held device lock) carry
    // only backend details; attach the request so the trace names the node's proof target.
    if (error instanceof UiScrollToError) {
      throw new UiScrollToError(
        error.code,
        error.reason,
        {
          ...uiScrollToRequestSummary(request),
          ...(isRecord(error.details) ? error.details : {}),
        },
        { cause: error },
      );
    }
    throw error;
  }
}

/** ui.scroll is raw movement only: offset_* sets an absolute position, delta_* moves relative to it. */
function assertScrollMovement(node: Record<string, unknown>): void {
  const absolute = node.offset_x !== undefined || node.offset_y !== undefined;
  const relative = node.delta_x !== undefined || node.delta_y !== undefined;
  if (absolute && relative) {
    throw new RecipeExecutionError(
      'harness',
      'ui.scroll accepts offset_x/offset_y (absolute) or delta_x/delta_y (relative), not both.',
    );
  }
  if ((absolute || relative) && node.scroll_into_view === true) {
    throw new RecipeExecutionError(
      'harness',
      'ui.scroll cannot combine scroll_into_view with raw movement; use ui.scroll_to to reveal a target.',
    );
  }
}

export function normalizeUiTransportResult(result: unknown): ActionResult {
  if (isUiTransportResult(result)) {
    const output =
      result.settlementWarning === undefined
        ? result.output
        : typeof result.output === 'object' &&
            result.output !== null &&
            !Array.isArray(result.output)
          ? { ...result.output, settlementWarning: result.settlementWarning }
          : { result: result.output, settlementWarning: result.settlementWarning };
    return {
      case: result.control?.case,
      artifacts: result.control?.artifacts,
      output,
      phases: result.phases,
    };
  }
  return { output: result ?? { ok: true } };
}

function isUiTransportResult(value: unknown): value is UiTransportResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return (value as { kind?: unknown }).kind === 'ui-transport-result';
}
