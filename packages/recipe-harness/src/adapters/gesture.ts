import type { RecipeActionPhase } from '../core/types.js';

export type GestureAction = 'ui.swipe' | 'ui.pan' | 'ui.drag' | 'ui.long_press';

export interface UiPoint {
  x: number;
  y: number;
}

export function gestureTarget(
  node: Record<string, unknown>,
  action: GestureAction,
): string | UiPoint {
  const target = node.target;
  if (typeof target === 'string' && target.trim()) return target;
  if (isPoint(target)) return target;
  throw new Error(`${action}.target must be a non-empty test id or { x, y } coordinates.`);
}

export function gestureDurationMs(node: Record<string, unknown>, action: GestureAction): number {
  const field = action === 'ui.long_press' ? 'holdMs' : 'duration_ms';
  const value = node[field];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`${action}.${field} must be a positive integer.`);
  }
  return value;
}

export function gesturePoints(
  action: GestureAction,
  node: Record<string, unknown>,
  start: UiPoint,
): UiPoint[] {
  if (action === 'ui.long_press') return [start, start];
  if (action === 'ui.swipe') {
    const distance = node.distance;
    if (typeof distance !== 'number' || !Number.isFinite(distance) || distance <= 0) {
      throw new Error('ui.swipe.distance must be a positive number.');
    }
    const direction = node.direction;
    const offsets: Record<string, UiPoint> = {
      up: { x: 0, y: -distance },
      down: { x: 0, y: distance },
      left: { x: -distance, y: 0 },
      right: { x: distance, y: 0 },
    };
    const offset = typeof direction === 'string' ? offsets[direction] : undefined;
    if (!offset) throw new Error('ui.swipe.direction must be up, down, left, or right.');
    return [start, addPoint(start, offset)];
  }

  if (Array.isArray(node.path)) {
    if (node.path.length === 0) throw new Error(`${action}.path must contain at least one point.`);
    return [
      start,
      ...node.path.map((point, index) => {
        if (!isPoint(point))
          throw new Error(`${action}.path[${index}] must contain numeric x and y.`);
        return addPoint(start, point);
      }),
    ];
  }
  if (isPoint(node.delta)) return [start, addPoint(start, node.delta)];
  throw new Error(`${action} requires exactly one of path or delta.`);
}

export function gesturePhase(
  phase: RecipeActionPhase['phase'],
  point: UiPoint,
  startedAtMs: number,
): RecipeActionPhase {
  return {
    phase,
    x: point.x,
    y: point.y,
    elapsedMs: Math.max(0, Date.now() - startedAtMs),
  };
}

export function gestureSegmentDuration(durationMs: number, points: readonly UiPoint[]): number {
  return Math.max(1, Math.round(durationMs / Math.max(1, points.length - 1)));
}

function addPoint(left: UiPoint, right: UiPoint): UiPoint {
  return { x: left.x + right.x, y: left.y + right.y };
}

function isPoint(value: unknown): value is UiPoint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const point = value as Record<string, unknown>;
  return (
    typeof point.x === 'number' &&
    Number.isFinite(point.x) &&
    typeof point.y === 'number' &&
    Number.isFinite(point.y)
  );
}
