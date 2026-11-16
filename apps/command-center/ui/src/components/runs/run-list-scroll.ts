/** Scroll belongs to the selected run and this browser history entry, not another run or tab. */
const KEY = 'farmslotRunDetailScroll';

export function savedRunDetailScroll(state: unknown, runId: string): number | undefined {
  if (!state || typeof state !== 'object' || !runId) return undefined;
  const saved: unknown = Reflect.get(state, KEY);
  if (!saved || typeof saved !== 'object' || Reflect.get(saved, 'runId') !== runId)
    return undefined;
  const top: unknown = Reflect.get(saved, 'top');
  return typeof top === 'number' && Number.isFinite(top) && top >= 0 ? top : undefined;
}

export function withRunDetailScroll(state: unknown, runId: string, top: number) {
  return {
    ...(state && typeof state === 'object' && !Array.isArray(state) ? state : {}),
    [KEY]: { runId, top },
  };
}

export function restoreRunDetailScroll(
  viewport: Pick<HTMLElement, 'scrollTop' | 'scrollHeight' | 'clientHeight'>,
  top: number,
  detailRendered: boolean,
): boolean {
  if (!detailRendered) return false;
  // A newer snapshot may be shorter; restore its last available position in that case.
  viewport.scrollTop = Math.min(top, Math.max(0, viewport.scrollHeight - viewport.clientHeight));
  return true;
}
