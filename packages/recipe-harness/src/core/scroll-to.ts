import { RecipeExecutionError } from './failure.js';
import { isRecord } from './json.js';

/** Stable ui.scroll_to failure codes. Every one is classified as a `harness` failure. */
export const UI_SCROLL_TO_ERROR_CODES = [
  'SCROLL_UNSUPPORTED',
  'SCROLL_SURFACE_MISSING',
  'SCROLL_TARGET_MISSING',
  'SCROLL_TARGET_NOT_MEASURABLE',
  'SCROLL_SESSION_CONFLICT',
  'SCROLL_SETTLEMENT_TIMEOUT',
  'SCROLL_TARGET_NOT_VISIBLE',
] as const;

export type UiScrollToErrorCode = (typeof UI_SCROLL_TO_ERROR_CODES)[number];

export interface UiRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface UiScrollOffset {
  x: number;
  y: number;
}

/** One provider measurement, in the same coordinate space as the viewport. */
export interface UiScrollGeometry {
  /** Surface bounds; null when the surface is not rendered. */
  surface: UiRect | null;
  /** Part of the surface content area a user can see; null when the surface is missing. */
  viewport: UiRect | null;
  /** Current scroll offset of the surface. */
  offset: UiScrollOffset;
  targetPresent: boolean;
  /** Null when the target is absent or has no measurable box (for example flattened Text). */
  targetBounds: UiRect | null;
  visibilityAnchorPresent?: boolean;
  visibilityAnchorBounds?: UiRect | null;
  /** HUD and overlay regions drawn over the page. */
  occlusions?: UiRect[];
}

export interface UiScrollToRequest {
  surfaceTestId: string;
  targetTestId: string;
  visibilityAnchorTestId?: string;
  align: 'start' | 'center' | 'end' | 'nearest';
  viewportPolicy: 'hud_safe' | 'full';
  verifyVisible: boolean;
  settle: { timeoutMs: number; intervalMs: number; stableSamples: number };
}

/** Provider handle that is valid only inside the transport's withScrollSession callback. */
export interface UiScrollSession {
  backend: string;
  sessionId: string;
  measure(): Promise<UiScrollGeometry>;
  /** Set the surface's absolute offset. Providers clamp to the scrollable range. */
  scrollTo(offset: UiScrollOffset): Promise<void>;
}

export interface UiScrollSnapshot {
  offset: UiScrollOffset;
  targetPresent: boolean;
  targetBounds: UiRect | null;
  visibilityAnchorPresent?: boolean;
  visibilityAnchorBounds?: UiRect | null;
}

export interface UiScrollSettlement {
  status: 'settled' | 'skipped' | 'timeout';
  samples: number;
  elapsedMs: number;
}

/** ui.scroll_to node output and failure details recorded in trace.json. */
export interface UiScrollToObservation {
  backend?: string;
  sessionId?: string;
  surfaceTestId: string;
  targetTestId: string;
  visibilityAnchorTestId?: string;
  align: UiScrollToRequest['align'];
  viewportPolicy: UiScrollToRequest['viewportPolicy'];
  measuredBy?: 'target' | 'visibility_anchor';
  viewport?: UiRect | null;
  safeViewport?: UiRect | null;
  occlusions?: UiRect[];
  before?: UiScrollSnapshot;
  after?: UiScrollSnapshot;
  /** Offset requested from the provider; the current offset when the node was a no-op. */
  offset?: UiScrollOffset;
  scrolled: boolean;
  alreadyVisible: boolean;
  settlement?: UiScrollSettlement;
  finalVisible?: boolean;
}

export class UiScrollToError extends RecipeExecutionError {
  readonly code: UiScrollToErrorCode;
  readonly reason: string;

  constructor(
    code: UiScrollToErrorCode,
    reason: string,
    details?: unknown,
    options?: ErrorOptions,
  ) {
    super('harness', `${code}: ${reason}`, { ...options, code, details });
    this.name = 'UiScrollToError';
    this.code = code;
    this.reason = reason;
  }
}

const ALIGNMENTS = new Set(['start', 'center', 'end', 'nearest']);
const VIEWPORT_POLICIES = new Set(['hud_safe', 'full']);
const EDGE_TOLERANCE_PX = 1;

export function parseUiScrollToRequest(node: Record<string, unknown>): UiScrollToRequest {
  const surfaceTestId = requiredString(node.surface_test_id, 'surface_test_id');
  const targetTestId = requiredString(node.target_test_id, 'target_test_id');
  const anchor = node.visibility_anchor_test_id;
  const align = node.align ?? 'nearest';
  const viewportPolicy = node.viewport_policy ?? 'hud_safe';
  if (typeof align !== 'string' || !ALIGNMENTS.has(align)) {
    throw invalidParam('align must be start, center, end, or nearest');
  }
  if (typeof viewportPolicy !== 'string' || !VIEWPORT_POLICIES.has(viewportPolicy)) {
    throw invalidParam('viewport_policy must be hud_safe or full');
  }
  if (node.verify_visible !== undefined && typeof node.verify_visible !== 'boolean') {
    throw invalidParam('verify_visible must be a boolean');
  }
  const settle = node.settle === undefined ? {} : node.settle;
  if (!isRecord(settle)) throw invalidParam('settle must be an object');
  return {
    surfaceTestId,
    targetTestId,
    ...(anchor === undefined
      ? {}
      : { visibilityAnchorTestId: requiredString(anchor, 'visibility_anchor_test_id') }),
    align: align as UiScrollToRequest['align'],
    viewportPolicy: viewportPolicy as UiScrollToRequest['viewportPolicy'],
    verifyVisible: node.verify_visible !== false,
    settle: {
      timeoutMs: nonNegativeNumber(settle.timeout_ms, 'settle.timeout_ms', 2_000),
      intervalMs: Math.max(1, nonNegativeNumber(settle.interval_ms, 'settle.interval_ms', 50)),
      stableSamples: Math.max(
        1,
        Math.floor(nonNegativeNumber(settle.stable_samples, 'settle.stable_samples', 2)),
      ),
    },
  };
}

export function uiScrollToRequestSummary(request: UiScrollToRequest): UiScrollToObservation {
  return {
    surfaceTestId: request.surfaceTestId,
    targetTestId: request.targetTestId,
    ...(request.visibilityAnchorTestId
      ? { visibilityAnchorTestId: request.visibilityAnchorTestId }
      : {}),
    align: request.align,
    viewportPolicy: request.viewportPolicy,
    scrolled: false,
    alreadyVisible: false,
  };
}

/**
 * Canonical scroll-to-visible algorithm shared by every provider: measure, no-op when the proof
 * element already rests in the safe viewport, otherwise move once, wait for geometry to settle,
 * and verify the final bounds. It never retries a failed contract.
 */
export async function runUiScrollTo(
  request: UiScrollToRequest,
  session: UiScrollSession,
): Promise<UiScrollToObservation> {
  const observation: UiScrollToObservation = {
    backend: session.backend,
    sessionId: session.sessionId,
    ...uiScrollToRequestSummary(request),
  };
  const fail = (code: UiScrollToErrorCode, reason: string): never => {
    throw new UiScrollToError(code, reason, observation);
  };

  const initial = await session.measure();
  observation.before = snapshot(initial);
  observation.viewport = initial.viewport;
  if (initial.occlusions?.length) observation.occlusions = initial.occlusions;
  const initialFrame = frame(request, initial, fail);
  observation.measuredBy = initialFrame.measuredBy;
  observation.safeViewport = initialFrame.safeViewport;

  if (
    isVisibleWithin(
      initialFrame.proofBounds,
      initialFrame.safeViewport,
      cardOcclusions(initial, request.viewportPolicy),
    )
  ) {
    return Object.assign(observation, {
      after: observation.before,
      offset: initial.offset,
      alreadyVisible: true,
      settlement: { status: 'skipped', samples: 0, elapsedMs: 0 },
      finalVisible: true,
    } satisfies Partial<UiScrollToObservation>);
  }

  // Unclamped: providers clamp to their scrollable range (which may be negative in RTL).
  const deltaX = nearestDelta(initialFrame.proofBounds, initialFrame.safeViewport, 'x');
  const offset = {
    x: initial.offset.x + deltaX,
    y:
      initial.offset.y +
      clearCards(
        // Cards are checked where the horizontal move leaves the element.
        { ...initialFrame.proofBounds, x: initialFrame.proofBounds.x - deltaX },
        initialFrame.safeViewport,
        alignDelta(initialFrame.proofBounds, initialFrame.safeViewport, request.align),
        cardOcclusions(initial, request.viewportPolicy),
        // A vertical scroll offset is never negative, so moves below -offset.y are unreachable.
        -initial.offset.y,
      ),
  };
  observation.offset = offset;
  await session.scrollTo(offset);
  observation.scrolled = true;

  const settled = await settle(session, request.settle);
  observation.settlement = settled.settlement;
  observation.after = snapshot(settled.geometry);
  observation.viewport = settled.geometry.viewport;
  if (settled.settlement.status === 'timeout') {
    fail(
      'SCROLL_SETTLEMENT_TIMEOUT',
      `geometry for ${request.targetTestId} kept changing for ${settled.settlement.elapsedMs}ms.`,
    );
  }
  const finalFrame = frame(request, settled.geometry, fail);
  observation.safeViewport = finalFrame.safeViewport;
  observation.finalVisible = isVisibleWithin(
    finalFrame.proofBounds,
    finalFrame.safeViewport,
    cardOcclusions(settled.geometry, request.viewportPolicy),
  );
  if (request.verifyVisible && !observation.finalVisible) {
    fail(
      'SCROLL_TARGET_NOT_VISIBLE',
      `${finalFrame.measuredBy === 'target' ? request.targetTestId : request.visibilityAnchorTestId} ended outside the ${request.viewportPolicy} viewport.`,
    );
  }
  return observation;
}

/**
 * Remove bar-shaped occlusion (at least half the viewport wide, like the recipe HUD) from the
 * viewport: bars in the lower half trim the bottom edge, others the top. Narrower cards are
 * checked against the proof element instead; see cardOcclusions.
 */
export function safeViewportFor(
  viewport: UiRect,
  occlusions: readonly UiRect[] | undefined,
  policy: UiScrollToRequest['viewportPolicy'],
): UiRect {
  if (policy === 'full' || !occlusions?.length) return viewport;
  let top = viewport.y;
  let bottom = viewport.y + viewport.height;
  const center = viewport.y + viewport.height / 2;
  for (const occlusion of occlusions) {
    const overlapsX =
      occlusion.x < viewport.x + viewport.width && occlusion.x + occlusion.width > viewport.x;
    const overlapsY = occlusion.y < bottom && occlusion.y + occlusion.height > top;
    if (!overlapsX || !overlapsY || !isBar(occlusion, viewport)) continue;
    if (occlusion.y + occlusion.height / 2 >= center) bottom = Math.min(bottom, occlusion.y);
    else top = Math.max(top, occlusion.y + occlusion.height);
  }
  return { x: viewport.x, y: top, width: viewport.width, height: Math.max(0, bottom - top) };
}

/**
 * Fully inside (or covering the whole axis when larger than) the safe viewport, and not under a
 * card-shaped occlusion.
 */
export function isVisibleWithin(
  bounds: UiRect,
  area: UiRect,
  cards: readonly UiRect[] = [],
): boolean {
  if (area.width <= 0 || area.height <= 0) return false;
  return (
    axisVisible(bounds.y, bounds.height, area.y, area.height) &&
    axisVisible(bounds.x, bounds.width, area.x, area.width) &&
    !cards.some((card) => intersects(card, bounds))
  );
}

function isBar(occlusion: UiRect, viewport: UiRect): boolean {
  return occlusion.width >= viewport.width / 2;
}

function intersects(a: UiRect, b: UiRect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function cardOcclusions(geometry: UiScrollGeometry, policy: UiScrollToRequest['viewportPolicy']) {
  if (policy === 'full' || !geometry.viewport) return [];
  const viewport = geometry.viewport;
  return (geometry.occlusions ?? []).filter((occlusion) => !isBar(occlusion, viewport));
}

function axisVisible(start: number, size: number, areaStart: number, areaSize: number): boolean {
  const end = start + size;
  const areaEnd = areaStart + areaSize;
  if (size > areaSize) {
    return start <= areaStart + EDGE_TOLERANCE_PX && end >= areaEnd - EDGE_TOLERANCE_PX;
  }
  return start >= areaStart - EDGE_TOLERANCE_PX && end <= areaEnd + EDGE_TOLERANCE_PX;
}

function frame(
  request: UiScrollToRequest,
  geometry: UiScrollGeometry,
  fail: (code: UiScrollToErrorCode, reason: string) => never,
): {
  proofBounds: UiRect;
  measuredBy: 'target' | 'visibility_anchor';
  safeViewport: UiRect;
} {
  if (!geometry.surface || !geometry.viewport) {
    return fail('SCROLL_SURFACE_MISSING', `surface ${request.surfaceTestId} is not rendered.`);
  }
  if (geometry.viewport.width <= 0 || geometry.viewport.height <= 0) {
    return fail(
      'SCROLL_SURFACE_MISSING',
      `surface ${request.surfaceTestId} has no visible viewport.`,
    );
  }
  if (!geometry.targetPresent) {
    return fail('SCROLL_TARGET_MISSING', `target ${request.targetTestId} is not rendered.`);
  }
  let proofBounds = geometry.targetBounds;
  let measuredBy: 'target' | 'visibility_anchor' = 'target';
  if (!proofBounds) {
    if (!request.visibilityAnchorTestId) {
      return fail(
        'SCROLL_TARGET_NOT_MEASURABLE',
        `target ${request.targetTestId} has no measurable box; declare visibility_anchor_test_id.`,
      );
    }
    if (!geometry.visibilityAnchorPresent || !geometry.visibilityAnchorBounds) {
      return fail(
        'SCROLL_TARGET_NOT_MEASURABLE',
        `target ${request.targetTestId} has no measurable box and anchor ${request.visibilityAnchorTestId} is ${geometry.visibilityAnchorPresent ? 'not measurable' : 'not rendered'}.`,
      );
    }
    proofBounds = geometry.visibilityAnchorBounds;
    measuredBy = 'visibility_anchor';
  }
  return {
    proofBounds,
    measuredBy,
    safeViewport: safeViewportFor(geometry.viewport, geometry.occlusions, request.viewportPolicy),
  };
}

function alignDelta(bounds: UiRect, area: UiRect, align: UiScrollToRequest['align']): number {
  const start = bounds.y - area.y;
  const end = bounds.y + bounds.height - (area.y + area.height);
  if (bounds.height > area.height || align === 'start') return start;
  if (align === 'end') return end;
  if (align === 'center') return bounds.y + bounds.height / 2 - (area.y + area.height / 2);
  return nearestDelta(bounds, area, 'y');
}

/**
 * Pick the vertical move closest to the aligned one that leaves the element inside the safe
 * viewport and clear of every card. Candidates rest the element flush against a card or a
 * viewport edge; with no clear position the aligned move stands and verification reports it.
 */
function clearCards(
  bounds: UiRect,
  area: UiRect,
  deltaY: number,
  cards: readonly UiRect[],
  minDelta: number,
): number {
  if (!cards.length) return deltaY;
  const bottom = bounds.y + bounds.height;
  const candidates = [
    deltaY,
    bounds.y - area.y,
    bottom - (area.y + area.height),
    ...cards.flatMap((card) => [bottom - card.y, bounds.y - (card.y + card.height)]),
  ];
  const clear = candidates.filter((delta) => {
    if (delta < minDelta) return false;
    const moved = { ...bounds, y: bounds.y - delta };
    return (
      axisVisible(moved.y, moved.height, area.y, area.height) &&
      !cards.some((card) => intersects(card, moved))
    );
  });
  if (!clear.length) return deltaY;
  return clear.reduce((best, delta) =>
    Math.abs(delta - deltaY) < Math.abs(best - deltaY) ? delta : best,
  );
}

function nearestDelta(bounds: UiRect, area: UiRect, axis: 'x' | 'y'): number {
  const size = axis === 'x' ? 'width' : 'height';
  const start = bounds[axis] - area[axis];
  const end = bounds[axis] + bounds[size] - (area[axis] + area[size]);
  if (start < 0 || bounds[size] > area[size]) return start;
  if (end > 0) return end;
  return 0;
}

async function settle(
  session: UiScrollSession,
  options: UiScrollToRequest['settle'],
): Promise<{ geometry: UiScrollGeometry; settlement: UiScrollSettlement }> {
  const startedAt = Date.now();
  // The budget always fits stable_samples measurements, so timeout_ms 0 still gets one chance.
  const budgetMs = Math.max(options.timeoutMs, (options.stableSamples - 1) * options.intervalMs);
  let geometry = await session.measure();
  let samples = 1;
  let unchanged = 1;
  while (unchanged < options.stableSamples) {
    if (Date.now() - startedAt >= budgetMs) {
      return {
        geometry,
        settlement: { status: 'timeout', samples, elapsedMs: Date.now() - startedAt },
      };
    }
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs));
    const next = await session.measure();
    samples += 1;
    unchanged = geometryKey(next) === geometryKey(geometry) ? unchanged + 1 : 1;
    geometry = next;
  }
  return {
    geometry,
    settlement: { status: 'settled', samples, elapsedMs: Date.now() - startedAt },
  };
}

function geometryKey(geometry: UiScrollGeometry): string {
  const round = (rect: UiRect | null | undefined) =>
    rect ? [rect.x, rect.y, rect.width, rect.height].map((value) => Math.round(value)) : null;
  return JSON.stringify([
    Math.round(geometry.offset.x),
    Math.round(geometry.offset.y),
    round(geometry.viewport),
    round(geometry.targetBounds),
    round(geometry.visibilityAnchorBounds),
    geometry.occlusions?.map(round),
  ]);
}

function snapshot(geometry: UiScrollGeometry): UiScrollSnapshot {
  return {
    offset: geometry.offset,
    targetPresent: geometry.targetPresent,
    targetBounds: geometry.targetBounds,
    ...(geometry.visibilityAnchorPresent === undefined
      ? {}
      : {
          visibilityAnchorPresent: geometry.visibilityAnchorPresent,
          visibilityAnchorBounds: geometry.visibilityAnchorBounds ?? null,
        }),
  };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value === 'string' && value.trim()) return value;
  throw invalidParam(`${field} must be a non-empty string`);
}

function nonNegativeNumber(value: unknown, field: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  throw invalidParam(`${field} must be a non-negative number`);
}

function invalidParam(message: string): RecipeExecutionError {
  return new RecipeExecutionError('harness', `ui.scroll_to ${message}.`);
}
