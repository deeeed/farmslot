import {
  css,
  html,
  nothing,
  type ReactiveController,
  type ReactiveControllerHost,
  unsafeCSS,
} from 'lit';

import type { TaskOperation, TaskProgressStructured } from '@farmslot/protocol';

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
  .operation-title {
    margin: 0;
    color: ${unsafeCSS(colors.textSecondary)};
    font-size: ${unsafeCSS(fonts.sizeSm)};
    font-weight: 600;
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
  /* A failed command inside a run that is still working is not a run failure. */
  .operation-status.fail.in-progress,
  .operation-in-progress {
    color: ${unsafeCSS(colors.statusWarn)};
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

const STALE_STATUS_MS = 30_000;

const STATUS_LABEL: Record<TaskOperation['status'], string> = {
  running: 'Command running',
  pass: 'Command completed',
  fail: 'Command failed',
};

/**
 * The command as a reader would type it. Harness runtimes record only their
 * subcommand (`run`, `call`), and a bare `run` next to a status badge reads as
 * the Farmslot run's verdict, so a bare word is shown as a harness subcommand.
 */
function commandLabel(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) return 'harness';
  return /\s/.test(trimmed) ? trimmed : `harness ${trimmed}`;
}

/**
 * What the panel shows: the latest command to start and the commands it runs
 * under, whatever their status or heartbeat, plus any other running command
 * still reporting.
 *
 * By start time, not list position or heartbeat. Filtering running commands by
 * heartbeat age made a running command drop out whenever its heartbeat was
 * late, so the badge flipped between running and failed: a running `run` with
 * a failed nested `call` showed only the failure on every late beat. The
 * latest command and its parents now stay, marked "No recent status update"
 * when the heartbeat is old. An unrelated older record that still says running
 * with an old heartbeat is left out: a harness killed mid-command never
 * finalizes its record, and showing it would bury what the worker did since.
 */
export function selectOperations(
  operations: readonly TaskOperation[],
  now = Date.now(),
): TaskOperation[] {
  const byStart = [...operations].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  const latest = byStart.at(-1);
  const keep = new Set<TaskOperation>();
  const byId = new Map(byStart.map((operation) => [operation.id, operation]));
  for (let current = latest; current && !keep.has(current); ) {
    keep.add(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return byStart.filter(
    (operation) =>
      keep.has(operation) ||
      (operation.status === 'running' && now - Date.parse(operation.updatedAt) <= STALE_STATUS_MS),
  );
}

export interface OperationPanelOptions {
  now?: number;
  /**
   * Whether the run is still working. Only then does a failed command inside
   * an open checklist step read as "run still in progress"; a cancelled or
   * failed run keeps its open steps, and must not be softened.
   */
  runActive?: boolean;
}

export function renderOperationPanel(
  progress: TaskProgressStructured,
  runId?: string | null,
  { now = Date.now(), runActive = false }: OperationPanelOptions = {},
) {
  if (progress.operationsError)
    return html`<p class="operation-error" role="status">${progress.operationsError}</p>`;
  const selected = selectOperations(progress.operations ?? [], now);
  if (!selected.length) return nothing;
  // The run is working and its worker still has a checklist step open: a failed
  // command is something it may retry, not the run's outcome.
  const runInProgress =
    runActive &&
    progress.phases.some((phase) => phase.steps.some((step) => step.status === 'running'));
  return html`<section
    class="operation-panel"
    aria-label="Last worker command"
    data-testid="operation-panel"
  >
    <h4 class="operation-title">Last worker command</h4>
    ${selected.map((operation) => {
      const softened = operation.status === 'fail' && runInProgress;
      return html`<div class="operation-item">
        <div class="operation-heading">
          <strong class="operation-command">${commandLabel(operation.command)}</strong>
          <span class="operation-status ${operation.status}${softened ? ' in-progress' : ''}"
            >${STATUS_LABEL[operation.status]}</span
          >
          ${softened
            ? html`<span class="operation-in-progress">· run still in progress</span>`
            : nothing}
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
          ${operation.status === 'running' &&
          now - Date.parse(operation.updatedAt) > STALE_STATUS_MS
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
      </div>`;
    })}
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
