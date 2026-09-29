import {
  css,
  html,
  nothing,
  type ReactiveController,
  type ReactiveControllerHost,
  unsafeCSS,
} from 'lit';

import type { TaskProgressStructured } from '@farmslot/protocol';

import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';
import { runDetailEvidenceArtifactHash } from '../runs/run-detail-url-state.js';

/** Include in every host's shadow-root styles alongside renderOperationPanel. */
export const operationPanelStyles = css`
  .operation-panel {
    display: grid;
    gap: ${unsafeCSS(spacing.md)};
    margin-bottom: ${unsafeCSS(spacing.lg)};
    color: ${unsafeCSS(colors.textPrimary)};
    font-size: ${unsafeCSS(fonts.sizeSm)};
    line-height: 1.5;
    overflow-wrap: anywhere;
  }
  .operation-item {
    padding: ${unsafeCSS(spacing.lg)};
    border: 1px solid ${unsafeCSS(colors.bgCardHover)};
    border-radius: ${unsafeCSS(radii.md)};
    background: ${unsafeCSS(colors.bgSurface)};
  }
  .operation-heading,
  .operation-freshness {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.lg)};
  }
  .operation-command {
    font-size: ${unsafeCSS(fonts.sizeMd)};
  }
  .operation-status {
    border: 1px solid currentColor;
    border-radius: ${unsafeCSS(radii.sm)};
    padding: 0 ${unsafeCSS(spacing.sm)};
  }
  .operation-status.running {
    color: ${unsafeCSS(colors.accentHover)};
  }
  .operation-status.pass {
    color: ${unsafeCSS(colors.statusOk)};
  }
  .operation-status.fail,
  .operation-error {
    color: ${unsafeCSS(colors.statusFail)};
  }
  .operation-stage,
  .operation-freshness {
    margin-top: ${unsafeCSS(spacing.sm)};
    color: ${unsafeCSS(colors.textSecondary)};
  }
  .operation-stale {
    color: ${unsafeCSS(colors.statusWarn)};
  }
  .operation-log,
  .operation-log:visited {
    display: inline-block;
    margin-top: ${unsafeCSS(spacing.md)};
    padding: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.md)};
    border: 1px solid ${unsafeCSS(colors.accentHover)};
    border-radius: ${unsafeCSS(radii.sm)};
    color: ${unsafeCSS(colors.accentHover)};
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  .operation-log:hover {
    background: ${unsafeCSS(colors.bgCardHover)};
    color: ${unsafeCSS(colors.textPrimary)};
  }
  .operation-log:focus-visible {
    outline: 2px solid ${unsafeCSS(colors.accentHover)};
    outline-offset: 3px;
  }
`;

function age(at: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(at)) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function renderOperationPanel(
  progress: TaskProgressStructured,
  runId?: string | null,
  now = Date.now(),
) {
  if (progress.operationsError)
    return html`<p class="operation-error" role="status">${progress.operationsError}</p>`;
  const operations = progress.operations ?? [];
  const active = operations.filter(
    (operation) =>
      operation.status === 'running' && now - Date.parse(operation.updatedAt) <= 30_000,
  );
  const selected = active.length ? active : operations.slice(-1);
  if (!selected.length) return nothing;
  return html`<section
    class="operation-panel"
    aria-label="Command activity"
    data-testid="operation-panel"
  >
    ${selected.map(
      (operation) =>
        html`<div class="operation-item">
          <div class="operation-heading">
            <strong class="operation-command">${operation.command}</strong>
            <span class="operation-status ${operation.status}"
              >${operation.status === 'running'
                ? 'Running reported'
                : operation.status === 'pass'
                  ? 'Completed'
                  : 'Failed'}</span
            >
            <span>
              ·
              ${age(
                operation.startedAt,
                operation.finishedAt ? Date.parse(operation.finishedAt) : now,
              )}
              elapsed</span
            >
            ${operation.parentId ? html`<span>· Nested command</span>` : nothing}
          </div>
          ${operation.stage
            ? html`<div class="operation-stage">
                Stage:
                ${operation.stage}${operation.stageStartedAt
                  ? ` · ${age(operation.stageStartedAt, operation.finishedAt ? Date.parse(operation.finishedAt) : now)} elapsed`
                  : nothing}
              </div>`
            : nothing}
          <div class="operation-freshness">
            <span
              >Last output:
              ${operation.lastOutputAt
                ? `${age(operation.lastOutputAt, now)} ago`
                : 'none recorded'}</span
            >
            <span>· Status update: ${age(operation.updatedAt, now)} ago</span>
            ${operation.status === 'running' && now - Date.parse(operation.updatedAt) > 30_000
              ? html`<strong class="operation-stale">· No recent status update</strong>`
              : nothing}
          </div>
          ${runId
            ? html`<a
                class="operation-log"
                href=${runDetailEvidenceArtifactHash(
                  runId,
                  { path: operation.logPath },
                  `#run/${encodeURIComponent(runId)}`,
                )}
                >View operation log</a
              >`
            : html`<code>${operation.logPath}</code>`}
        </div>`,
    )}
  </section>`;
}

/** Refresh observation ages even when a dead producer emits no more events. */
export class OperationClock implements ReactiveController {
  private timer?: ReturnType<typeof setInterval>;
  constructor(
    private host: ReactiveControllerHost,
    private progress: () => TaskProgressStructured | undefined | null,
  ) {
    host.addController(this);
  }
  hostConnected(): void {
    this.timer = setInterval(() => {
      if (this.progress()?.operations?.some((operation) => operation.status === 'running'))
        this.host.requestUpdate();
    }, 1000);
  }
  hostDisconnected(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
