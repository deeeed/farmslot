import {
  viewIntegerField,
  viewStateParams,
  viewToggleField,
  viewToggleMapField,
} from '@farmslot/protocol';

export const DEFAULT_SIDEBAR_WIDTH = 260;
export const MIN_SIDEBAR_WIDTH = 180;
export const MAX_SIDEBAR_WIDTH = 420;
export const SIDEBAR_PANEL_FIELD = viewToggleField('panels', 'sidebar', false);

export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_SIDEBAR_WIDTH;
  return Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, Math.round(width)));
}

/** Shell choices belong to every workspace route. Destination choices remain authoritative. */
export function inheritSidebarViewState(
  params: URLSearchParams,
  source: URLSearchParams,
): URLSearchParams {
  return viewStateParams(params, (values) => {
    if (!('sidebar' in viewToggleMapField('panels').read(params)))
      values.set(SIDEBAR_PANEL_FIELD, SIDEBAR_PANEL_FIELD.read(source));
    const width = viewIntegerField('sidebarWidth', DEFAULT_SIDEBAR_WIDTH);
    if (!params.has(width.key)) values.set(width, clampSidebarWidth(width.read(source)));
  });
}
