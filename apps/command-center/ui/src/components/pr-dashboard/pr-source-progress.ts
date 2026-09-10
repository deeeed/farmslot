import { html, nothing } from 'lit';

import type { PRRuleSourceProgress } from '@farmslot/protocol';

export function sourceProgress(progress?: PRRuleSourceProgress) {
  if (!progress) return nothing;
  return html`<div data-testid="pr-source-progress">
    <p class="muted">
      ${progress.completedAt ? 'Source scan complete' : 'Source scan in progress'} ·
      ${progress.pages} pages saved
    </p>
    <p class="muted">
      ${progress.oldestObservationAt ? 'Source observations from' : 'Scan started'}
      ${new Date(progress.oldestObservationAt ?? progress.startedAt).toLocaleString()}
    </p>
    ${progress.resumed ? html`<p class="muted">Using saved scan progress</p>` : nothing}
    ${progress.nextAttemptAt
      ? html`<p class="attention">
          Retry available ${new Date(progress.nextAttemptAt).toLocaleString()}
        </p>`
      : nothing}
  </div>`;
}
