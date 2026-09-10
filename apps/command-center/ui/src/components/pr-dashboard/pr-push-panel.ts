import { html, nothing } from 'lit';

import type { PRPushListResult } from '@farmslot/protocol';

export function prPushPanel(
  state: PRPushListResult,
  history: boolean,
  disabled: boolean,
  acknowledge: (sourceId: string) => void,
) {
  const attention = state.attention.filter(
    (item) => history || (item.current && !item.acknowledgedAt),
  );
  const deliveries = state.deliveries.filter(
    (item) => history || ['retry', 'unknown', 'failed'].includes(item.state),
  );
  return html`
    <p class="muted">
      Enable push on each device in Companion. Acknowledgement does not resolve the GitHub issue.
    </p>
    ${!attention.length ? html`<p class="muted">No unacknowledged PR notifications.</p>` : nothing}
    ${attention.map(
      (item) =>
        html`<div class="card" data-testid="pr-push-attention" data-attention-id=${item.id}>
          <p>${item.title}</p>
          <p>${item.body}</p>
          <p class="muted">
            ${item.current ? 'Current attention' : 'Historical attention'} ·
            ${new Date(item.createdAt).toLocaleString()}
          </p>
          ${item.acknowledgedAt
            ? html`<p class="muted">Acknowledged</p>`
            : html`<button
                data-testid="pr-push-ack"
                ?disabled=${disabled}
                @click=${() => acknowledge(item.id)}
              >
                Acknowledge for me
              </button>`}
        </div>`,
    )}
    ${state.devices.map(
      (device) =>
        html`<p class="muted" data-testid="pr-push-device">
          ${device.platform} · ${device.profileId} ·
          ${device.enabled ? 'Push enabled' : 'Push disabled'}${device.error
            ? ` · ${device.error}`
            : ''}
        </p>`,
    )}
    ${deliveries.map(
      (delivery) =>
        html`<p class="attention">
          ${delivery.state}:
          ${delivery.error ?? 'Push delivery recorded'}${delivery.nextAttemptAt
            ? ` · Next check ${new Date(delivery.nextAttemptAt).toLocaleString()}`
            : ''}
        </p>`,
    )}
  `;
}
