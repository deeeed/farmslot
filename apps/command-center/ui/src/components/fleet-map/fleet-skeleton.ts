import { html } from 'lit';

import '../shared/hydrating-placeholder.js';

import type { FleetCanvasViewMode } from './fleet-canvas-url-state.js';

/** Drawn in the shape of the view that replaces it, so a cold load does not swap layouts. */
export function renderFleetSkeleton(
  error = '',
  retry?: () => void,
  viewMode: FleetCanvasViewMode = 'list',
) {
  return html`<farm-hydrating message="Fleet" .error=${error} @retry=${retry}>
    <div style="display:grid;gap:16px;min-height:340px">
      <farm-skeleton width="24%"></farm-skeleton>
      ${viewMode === 'card'
        ? html`<div
            style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px"
          >
            ${Array.from(
              { length: 6 },
              () =>
                html`<div style="display:grid;gap:12px;padding:12px">
                  <farm-skeleton width="65%"></farm-skeleton
                  ><farm-skeleton kind="block"></farm-skeleton
                  ><farm-skeleton width="45%"></farm-skeleton>
                </div>`,
            )}
          </div>`
        : html`<div style="display:grid;gap:10px">
            ${Array.from(
              { length: 8 },
              () =>
                html`<div
                  style="display:grid;grid-template-columns:16px 2fr 1fr 3fr 1fr;gap:12px;padding:0 8px"
                >
                  <farm-skeleton></farm-skeleton><farm-skeleton></farm-skeleton
                  ><farm-skeleton></farm-skeleton><farm-skeleton></farm-skeleton
                  ><farm-skeleton></farm-skeleton>
                </div>`,
            )}
          </div>`}
    </div>
  </farm-hydrating>`;
}
