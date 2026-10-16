import { html } from 'lit';

import '../shared/hydrating-placeholder.js';

export function renderPrBoardSkeleton(board: boolean, error = '', retry?: () => void) {
  return html`<farm-hydrating
    message="Pull requests"
    .error=${error}
    @retry=${retry}
    data-testid="pr-list-loading"
  >
    <div
      style=${`display:grid;gap:12px;min-height:340px;grid-template-columns:${board ? 'repeat(auto-fit,minmax(220px,1fr))' : '1fr'}`}
    >
      ${Array.from(
        { length: board ? 3 : 5 },
        () =>
          html`<div style="display:grid;gap:12px;padding:12px">
            <farm-skeleton width="65%"></farm-skeleton
            ><farm-skeleton kind=${board ? 'block' : 'row'}></farm-skeleton
            ><farm-skeleton width="35%"></farm-skeleton>
          </div>`,
      )}
    </div>
  </farm-hydrating>`;
}
