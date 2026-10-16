import { html } from 'lit';

import '../shared/hydrating-placeholder.js';

export function renderFleetSkeleton(error = '', retry?: () => void) {
  return html`<farm-hydrating message="Fleet" .error=${error} @retry=${retry}>
    <div style="display:grid;gap:16px;min-height:340px">
      <farm-skeleton width="24%"></farm-skeleton>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px">
        ${Array.from(
          { length: 6 },
          () =>
            html`<div style="display:grid;gap:12px;padding:12px">
              <farm-skeleton width="65%"></farm-skeleton><farm-skeleton kind="block"></farm-skeleton
              ><farm-skeleton width="45%"></farm-skeleton>
            </div>`,
        )}
      </div>
    </div>
  </farm-hydrating>`;
}
