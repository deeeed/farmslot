import { html } from 'lit';

import '../shared/hydrating-placeholder.js';

/** Match the inventory's header and compact rows. */
export function renderRunListSkeleton(error = '', retry?: () => void) {
  return html`<farm-hydrating message="Runs" .error=${error} @retry=${retry}>
    <div style="display:grid;gap:12px;min-height:340px">
      <farm-skeleton width="30%"></farm-skeleton>
      ${Array.from(
        { length: 6 },
        () =>
          html`<div
            style="display:grid;grid-template-columns:44px 2fr 1fr 1fr;gap:12px;align-items:center;height:44px"
          >
            <farm-skeleton kind="avatar"></farm-skeleton><farm-skeleton width="85%"></farm-skeleton
            ><farm-skeleton width="75%"></farm-skeleton><farm-skeleton width="60%"></farm-skeleton>
          </div>`,
      )}
    </div>
  </farm-hydrating>`;
}
