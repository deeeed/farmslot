/** Display limits apply after font layout, never by cutting authored copy. */
export const HUD_INTENT_FONT_SIZE = 16;
export const HUD_INTENT_LINE_HEIGHT = 20;
/** Nominal: a 120-character intent fits a card in 3 lines. Web never clamps the intent. */
export const HUD_INTENT_MAX_LINES = 3;
export const HUD_NATIVE_INTENT_FONT_SIZE = 13;
export const HUD_NATIVE_INTENT_LINE_HEIGHT = 17;
export const HUD_NATIVE_INTENT_MAX_LINES = 2;
/** The discreet line for the step that just finished. */
export const HUD_FINISHED_FONT_SIZE = 11;
export const HUD_FINISHED_LINE_HEIGHT = 14;
export const HUD_NATIVE_FINISHED_FONT_SIZE = 10;
export const HUD_NATIVE_FINISHED_LINE_HEIGHT = 13;
export const HUD_COLORS = {
  muted: 'rgba(255,255,255,0.55)',
  pass: '#48d17a',
  fail: '#ff8a8a',
} as const;
export const RECIPE_INTENT_WARN_LENGTH = 80;
export const RECIPE_INTENT_MAX_LENGTH = 120;
/**
 * Native bounds clip. Web heights are nominal (a card with 3 intent lines, the
 * finished line and an error): web panels grow rather than hide intent text.
 */
export const HUD_PANEL_BOUNDS = {
  native: { maxWidth: 360, maxHeight: 88 },
  card: { maxWidth: 500, maxHeight: 144 },
  bar: { maxWidth: 960, maxHeight: 144 },
} as const;

export type RecipeHudPlacement = 'top' | 'bottom';

/** Native renderers use the vertical part of the existing HUD display position. */
export function hudPlacement(display: unknown): RecipeHudPlacement | undefined {
  if (!display || typeof display !== 'object') return undefined;
  const position = (display as { position?: unknown }).position;
  if (position === 'top' || position === 'top-left' || position === 'top-right') return 'top';
  if (position === 'bottom' || position === 'bottom-left' || position === 'bottom-right')
    return 'bottom';
  return undefined;
}

/** Let the updated caption paint before the next capture or recorder stop. */
export function waitForHudPaint(
  nextFrame: (callback: () => void) => unknown,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false;
    // Anonymous callbacks keep the function self-contained when embedded in a page.
    const [finish, abort] = [
      (error?: unknown) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve();
      },
      () => finish(signal?.reason ?? new Error('HUD paint cancelled.')),
    ] as const;
    const timer = setTimeout(() => finish(new Error('HUD did not paint within 500ms.')), 500);
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
    nextFrame(() => nextFrame(() => finish()));
  });
}

export function hudIntentDisplay(
  value: string | number | null | undefined,
  platform: keyof typeof HUD_PANEL_BOUNDS = 'card',
) {
  return {
    text: String(value ?? '')
      .replace(/\s+/gu, ' ')
      .trim(),
    panel: HUD_PANEL_BOUNDS[platform],
    nativeProps: {
      numberOfLines: HUD_NATIVE_INTENT_MAX_LINES,
      ellipsizeMode: 'tail' as const,
      allowFontScaling: false,
    },
    nativeStyle: {
      lineHeight: HUD_NATIVE_INTENT_LINE_HEIGHT,
      maxHeight: HUD_NATIVE_INTENT_LINE_HEIGHT * HUD_NATIVE_INTENT_MAX_LINES,
      fontSize: HUD_NATIVE_INTENT_FONT_SIZE,
    },
    // No clamp, ellipsis or max height: the panel grows to show the whole intent.
    webStyle: {
      whiteSpace: 'normal',
      overflowWrap: 'anywhere',
      fontSize: `${HUD_INTENT_FONT_SIZE}px`,
      lineHeight: `${HUD_INTENT_LINE_HEIGHT}px`,
      fontWeight: '600',
    },
  };
}

export interface HudFinishedStep {
  nodeId: string;
  intent: string;
  status: string;
}

/**
 * The discreet line for the step that just finished, unless that step is still
 * the main line (a failing main line takes the fail colour instead).
 */
export function hudFinishedLine(
  last: HudFinishedStep | null | undefined,
  currentNodeId?: string,
): { text: string; tone: 'pass' | 'fail' } | null {
  if (!last || (last.status !== 'pass' && last.status !== 'fail')) return null;
  if (last.nodeId === currentNodeId) return null;
  const mark = last.status === 'pass' ? '✓' : '✗';
  return { text: `${mark} ${hudIntentDisplay(last.intent).text}`, tone: last.status };
}

/** One step result as a step-numbered HUD (native) sees it. */
export interface HudStepResult {
  step?: number;
  intent: string;
  status: 'pass' | 'fail';
}

/**
 * Folds one step-numbered HUD update into the step that just finished. A new
 * run starts clean: a cleared or idle HUD, an earlier step, or a running step
 * that is not after the last result.
 */
export function nextHudFinishedStep(
  last: HudStepResult | null,
  next: { status: string; intent: string; currentStep?: number } | null,
): { finished: HudStepResult | null; last: HudStepResult | null } {
  if (!next || next.status === 'idle') return { finished: null, last: null };
  const newRun =
    last?.step !== undefined &&
    next.currentStep !== undefined &&
    (next.currentStep < last.step || (next.status === 'running' && next.currentStep === last.step));
  const previous = newRun ? null : last;
  if (next.status !== 'pass' && next.status !== 'fail')
    return { finished: previous, last: previous };
  const result: HudStepResult = {
    step: next.currentStep,
    intent: next.intent,
    status: next.status,
  };
  return { finished: previous, last: result };
}

/** Existing metadata/error cap; intent always uses the uncut display model. */
export function hudSecondaryText(value: string | number | null | undefined, max = 180): string {
  const text = hudIntentDisplay(value).text;
  const characters = Array.from(text);
  return characters.length > max ? `${characters.slice(0, max - 1).join('')}…` : text;
}
