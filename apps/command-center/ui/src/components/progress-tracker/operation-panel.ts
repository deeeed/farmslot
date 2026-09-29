import { html, nothing, type ReactiveController, type ReactiveControllerHost } from 'lit';

import type { TaskProgressStructured } from '@farmslot/protocol';

import { runDetailEvidenceArtifactHash } from '../runs/run-detail-url-state.js';

function age(at: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(at)) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function renderOperationPanel(
  progress: TaskProgressStructured,
  runId?: string | null,
  now = Date.now(),
) {
  if (progress.operationsError) return html`<p role="status">${progress.operationsError}</p>`;
  const operations = progress.operations ?? [];
  const active = operations.filter(
    (operation) =>
      operation.status === 'running' && now - Date.parse(operation.updatedAt) <= 30_000,
  );
  const selected = active.length ? active : operations.slice(-1);
  if (!selected.length) return nothing;
  return html`<section aria-label="Command activity" data-testid="operation-panel">
    ${selected.map(
      (operation) =>
        html`<div style="padding:8px 0; border-bottom:1px solid var(--border-color, #333)">
          <strong>${operation.command}</strong>
          <span
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
          ${operation.parentId ? html`<small> · nested command</small>` : nothing}
          ${operation.stage
            ? html`<div>
                Stage:
                ${operation.stage}${operation.stageStartedAt
                  ? ` · ${age(operation.stageStartedAt, operation.finishedAt ? Date.parse(operation.finishedAt) : now)} elapsed`
                  : nothing}
              </div>`
            : nothing}
          <div>
            Last output:
            ${operation.lastOutputAt ? `${age(operation.lastOutputAt, now)} ago` : 'none recorded'}
            · Status update: ${age(operation.updatedAt, now)} ago
            ${operation.status === 'running' && now - Date.parse(operation.updatedAt) > 30_000
              ? html`<strong> · No recent status update</strong>`
              : nothing}
          </div>
          ${runId
            ? html`<a
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
