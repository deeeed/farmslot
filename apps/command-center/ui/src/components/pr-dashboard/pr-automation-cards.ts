import { html, nothing } from 'lit';

import {
  DEFAULT_PR_REVIEW_OPTIONS,
  monitoredPRUrl,
  type PRMonitor,
  prReviewBlockedReason,
  type PRReviewIntent,
  type PRRuleActionRecord,
  type PRRuleNotification,
  type PRTeamProfile,
  type QueueItem,
  type Run,
} from '@farmslot/protocol';

import { reviewRunLabel } from './pr-review-status.js';

function time(value?: string) {
  return value ? new Date(value).toLocaleString() : 'Not observed yet';
}
function runLink(id?: string) {
  return id ? html`<a href=${`#runs?run=${encodeURIComponent(id)}`}>Open run</a>` : nothing;
}

export function ruleNotificationCard(
  note: PRRuleNotification,
  disabled: boolean,
  acknowledge: () => void,
) {
  return html`<article class="card" data-rule-notification=${note.id}>
    <h3>${note.teamName} · ${note.ruleName}</h3>
    <a href=${monitoredPRUrl(note.pr)} target="_blank" rel="noopener noreferrer"
      >${note.pr.repo}#${note.pr.number}: ${note.title}</a
    >
    <p>${note.reasons.join('; ')}</p>
    <p class="muted">
      ${time(note.createdAt)} · ${note.current ? 'Current match' : 'Historical match'}
    </p>
    ${note.acknowledgedAt
      ? html`<p class="muted">Acknowledged ${time(note.acknowledgedAt)}</p>`
      : html`<button
          data-testid="pr-rule-notification-ack"
          ?disabled=${disabled}
          @click=${acknowledge}
        >
          Acknowledge
        </button>`}
  </article>`;
}

export function ruleActionCard(action: PRRuleActionRecord, disabled: boolean, open: () => void) {
  return html`<article class="card" data-rule-monitor-action=${action.id}>
    <h3>
      ${action.ruleName} · ${action.kind === 'monitor' ? 'Monitor enrollment' : 'Notification'}
    </h3>
    <p>${action.subject.pr.repo}#${action.subject.pr.number} · ${action.status}</p>
    ${action.error ? html`<p class="error">${action.error}</p>` : nothing}
    ${action.monitorId
      ? html`<button ?disabled=${disabled} @click=${open}>Open monitor</button>`
      : nothing}
  </article>`;
}

export function monitorCard(
  monitor: PRMonitor,
  disabled: boolean,
  act: (action: string, monitor: PRMonitor, incidentId?: string) => void,
  expanded = false,
  contextual = false,
) {
  const observation = monitor.observation;
  const incidents = monitor.incidents.filter((incident) => !incident.resolvedAt);
  const work = monitor.activeRuns ?? [];
  const workOngoing = work.length > 0;
  const workSuspended = monitor.lifecycle === 'active' && workOngoing;
  const stale =
    monitor.lifecycle === 'active' &&
    !workSuspended &&
    (!observation ||
      Date.now() - Date.parse(observation.checkedAt) > monitor.config.pollIntervalMs + 60_000);
  const minutes = monitor.config.pollIntervalMs / 60_000;
  const interval = minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes} min`;
  const activeRepair = monitor.repairs?.find(
    (repair) => repair.state !== 'finished' && repair.state !== 'cancelled',
  );
  return html`<details
    ?open=${expanded}
    class="card monitor-card"
    data-monitor-id=${monitor.id}
    data-work-suspended=${String(workSuspended)}
    aria-busy=${String(disabled)}
  >
    <summary data-testid="pr-monitor-summary">
      <span class="monitor-heading">
        <span class="monitor-heading-row">
          ${contextual
            ? nothing
            : html`<a
                class="monitor-pr"
                href=${monitoredPRUrl(monitor.config.pr)}
                target="_blank"
                rel="noopener noreferrer"
                >${monitor.config.pr.repo}#${monitor.config.pr.number}</a
              >`}
          <span class="row monitor-badges">
            <span class="monitor-badge"
              >${workSuspended
                ? 'Work ongoing'
                : {
                    active: 'Monitoring',
                    paused: 'Paused',
                    stopped: 'Stopped',
                    finished: 'Finished',
                  }[monitor.lifecycle]}</span
            >
            <span
              class="monitor-badge ${workOngoing ||
              monitor.observationError ||
              stale ||
              incidents.length
                ? 'attention'
                : ''}"
            >
              ${workOngoing
                ? workSuspended
                  ? 'Checks paused'
                  : 'Work ongoing'
                : monitor.observationError
                  ? 'Check failed'
                  : stale
                    ? 'Awaiting fresh check'
                    : !observation
                      ? 'Awaiting first check'
                      : incidents.length
                        ? `${incidents.length} issue${incidents.length === 1 ? '' : 's'}`
                        : 'No issues detected'}
            </span>
            ${activeRepair
              ? html`<span class="monitor-badge attention">Repair ${activeRepair.state}</span>`
              : nothing}
          </span>
        </span>
        ${contextual
          ? nothing
          : html`<span class="monitor-title">${observation?.title ?? 'Awaiting PR details'}</span>`}
        <span class="row monitor-meta">
          <span
            >${monitor.config.policy.mode === 'notify-only' ? 'Notify only' : 'Automatic repair'} ·
            Every ${interval}</span
          >
          ${workOngoing
            ? html`<span class="attention" data-testid="pr-monitor-active-work">
                ${work.map(
                  (run) =>
                    html`<a href=${`#runs?run=${encodeURIComponent(run.id)}`}
                      >${run.slotId ?? `Run ${run.id.slice(0, 8)}`}</a
                    > `,
                )}
              </span>`
            : monitor.lifecycle === 'active' && monitor.nextCheckAt
              ? html`<span
                  >Next check
                  <time datetime=${monitor.nextCheckAt} title=${time(monitor.nextCheckAt)}
                    >${new Date(monitor.nextCheckAt).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}</time
                  ></span
                >`
              : nothing}
          <span class="monitor-expand-label">Details and actions</span>
        </span>
      </span>
    </summary>
    <div class="monitor-content">
      ${workOngoing
        ? html`<p class="attention">
              ${workSuspended
                ? 'Automated checks and new repairs are paused while this PR has active work. Monitoring resumes on its schedule when that work ends.'
                : `Active work is present. Monitoring remains ${monitor.lifecycle} until you resume it.`}
              Previous alerts remain below.
            </p>
            ${work.map(
              (run) =>
                html`<p>
                  ${run.status} · ${runLink(run.id)}
                  ${run.slotId
                    ? html`·
                        <a href=${`#slot/${encodeURIComponent(run.slotId)}`}
                          >Open slot ${run.slotId}</a
                        >`
                    : nothing}
                </p>`,
            )}`
        : nothing}
      <p class="muted">
        ${observation?.author ?? monitor.config.account.login} ·
        ${monitor.config.project ?? 'No project'} · Last checked ${time(observation?.checkedAt)}
      </p>
      ${stale
        ? html`<p class="attention">Observation is stale. Current PR health is unknown.</p>`
        : nothing}
      ${monitor.observationError ? html`<p class="error">${monitor.observationError}</p>` : nothing}
      ${observation
        ? html`<p>
            ${observation.state} · ${observation.mergeability} ·
            ${observation.reviewDecision.replaceAll('-', ' ')}
          </p>`
        : nothing}
      ${incidents.length
        ? html`<ul class="monitor-incidents">
            ${incidents.map(
              (incident) =>
                html`<li>
                  <a
                    class="monitor-incident-link"
                    href=${incident.signal.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    >${incident.signal.summary}</a
                  >
                  <span class="muted">
                    ${incident.attemptCount
                      ? `${incident.attemptCount} repair attempt(s)`
                      : ''}${incident.handledAt ? ' · feedback handled' : ''}${incident.snoozedUntil
                      ? ` · snoozed until ${time(incident.snoozedUntil)}`
                      : ''}</span
                  >
                  ${incident.waitingReason
                    ? html`<p class="attention">${incident.waitingReason}</p>`
                    : nothing}
                  <div class="row actions">
                    <button
                      ?disabled=${disabled || Boolean(incident.acknowledgedAt)}
                      title="Mark this alert as seen. The issue remains unresolved and monitoring continues."
                      @click=${() => act('acknowledge', monitor, incident.id)}
                    >
                      ${incident.acknowledgedAt ? 'Seen' : 'Mark as seen'}</button
                    ><button
                      ?disabled=${disabled}
                      @click=${() => act('snooze', monitor, incident.id)}
                    >
                      Snooze 1 hour</button
                    >${runLink(incident.runId)}
                  </div>
                </li>`,
            )}
          </ul>`
        : html`<p class="muted">
            ${observation && !monitor.observationError
              ? 'No recorded incidents.'
              : 'Waiting for a complete observation.'}
          </p>`}
      ${(monitor.repairs ?? [])
        .filter((repair) => repair.state !== 'finished' && repair.state !== 'cancelled')
        .map(
          (repair) =>
            html`<p class="attention">
              Repair ${repair.state}: ${repair.waitingReason ?? ''} ${runLink(repair.runId)}
            </p>`,
        )}
      <div class="row actions">
        <button
          data-testid="pr-monitor-refresh"
          ?disabled=${disabled || workSuspended || monitor.lifecycle !== 'active'}
          @click=${() => act('refresh', monitor)}
        >
          Check now
        </button>
        <button
          data-testid="pr-monitor-edit"
          ?disabled=${disabled}
          @click=${() => act('edit', monitor)}
        >
          Monitoring settings
        </button>
        <button
          ?disabled=${disabled}
          @click=${() => act(monitor.lifecycle === 'active' ? 'pause' : 'resume', monitor)}
          data-testid="pr-monitor-lifecycle"
        >
          ${monitor.lifecycle === 'active' ? 'Pause' : 'Resume'}
        </button>
        <button
          ?disabled=${disabled || monitor.lifecycle === 'stopped'}
          @click=${() => act('stop', monitor)}
        >
          Stop monitoring
        </button>
        <button
          data-testid="pr-monitor-repair"
          ?disabled=${disabled ||
          workSuspended ||
          monitor.lifecycle !== 'active' ||
          !incidents.length}
          @click=${() => act('repair', monitor)}
        >
          Set up agent repair
        </button>
      </div>
      <p class="muted monitor-action-help">
        Mark as seen acknowledges an alert without resolving it. Monitoring settings control checks
        and notifications. Agent repair opens a setup form for work that may change this PR's code.
      </p>
    </div>
  </details>`;
}

export function reviewCard(
  intent: PRReviewIntent,
  teams: PRTeamProfile[],
  runs: Run[],
  queue: QueueItem[],
  disabled: boolean,
  decide: (id: string, action: 'accept' | 'defer') => void,
  contextual = false,
  blockedReason?: string,
) {
  const run = runs.find((item) => item.id === intent.runId);
  const queued = queue.find((item) => item.id === intent.queueItemId);
  const trace = run?.repeatReviewContext?.session;
  const active = intent.contributions.filter((item) => item.eligible);
  const reviewBlock =
    blockedReason ??
    active.map((source) => prReviewBlockedReason(source.reviewObservation)).find(Boolean);
  const controllable =
    !intent.runId &&
    !reviewBlock &&
    active.length > 0 &&
    !['running', 'completed', 'failed', 'withdrawn'].includes(intent.status);
  return html`<article class="card" data-review-id=${intent.id} data-review-status=${intent.status}>
    <div class="row">
      ${contextual
        ? nothing
        : html`<a href=${monitoredPRUrl(intent.pr)} target="_blank" rel="noopener noreferrer"
            >${intent.pr.repo}#${intent.pr.number}</a
          >`}<span
        >Review run:
        ${reviewBlock && !intent.runId ? 'Not needed' : reviewRunLabel(intent.status)}</span
      ><span class="muted">${intent.reviewProfile} · Round ${intent.round ?? 1}</span>
    </div>
    ${!intent.runId ? html`<p class="muted">No run has started for this request.</p>` : nothing}
    <p>
      <code>${intent.headSha.slice(0, 12)}</code> ${intent.reviewedSha
        ? html` · Reviewed <code>${intent.reviewedSha.slice(0, 12)}</code>`
        : nothing}
    </p>
    ${reviewBlock
      ? html`<p class="muted">${reviewBlock}</p>`
      : intent.waitingReason
        ? html`<p class="muted">${intent.waitingReason}</p>`
        : nothing}
    <details class="review-config-details">
      <summary>Review setup and matching rules</summary>
      ${intent.contributions.map((source) => {
        const review = source.review ?? DEFAULT_PR_REVIEW_OPTIONS;
        const execution = source.execution;
        return html`<div>
          <p>
            ${teams.find((team) => team.id === source.teamId)?.config.name ?? 'Team'} ·
            ${source.submissionId ? 'Direct request' : 'Trigger rule'}${source.eligible
              ? ''
              : ' · no longer eligible'}
          </p>
          <p class="muted">
            ${review.sessionIntent === 'resume' ? 'Continue saved reviewer' : 'Fresh reviewer'} ·
            ${review.scope} · ${review.validationDepth === 'full-live' ? 'Live QA' : 'Static code'}
            ·
            ${review.busySession === 'fresh'
              ? 'Fresh slot fallback allowed'
              : 'Wait for saved reviewer'}
          </p>
          ${execution
            ? html`<p class="muted">
                Slots:
                ${execution.slotPolicy.kind === 'exact'
                  ? execution.slotPolicy.slotId
                  : execution.slotPolicy.allowedSlots.join(', ')}<br />Models:
                ${execution.models
                  .map(
                    (model) =>
                      `${model.runner}/${model.model}${model.effort ? `/${model.effort}` : ''}`,
                  )
                  .join(' → ')}
              </p>`
            : nothing}
          ${source.configurationErrors.map((error) => html`<p class="error">${error}</p>`)}
          <p class="muted">${source.reasons.join('; ')}</p>
        </div>`;
      })}
    </details>
    ${run?.slotId
      ? html`<p>
          Assigned ${run.slotId} ·
          ${run.metrics.runner}/${run.metrics.model}${run.effort ? `/${run.effort}` : ''}
        </p>`
      : queued?.slotId
        ? html`<p>
            Selected ${queued.slotId} · ${queued.model}/${queued.effort ?? 'default effort'}
          </p>`
        : nothing}
    ${trace
      ? html`<p>
          Session
          ${trace.continuity}${trace.fallbackReason
            ? ` · ${trace.fallbackReason}`
            : ''}${trace.sessionId ? ` · ${trace.sessionId}` : ''}
        </p>`
      : nothing}
    <div class="row actions">
      ${runLink(intent.runId)}<button
        ?disabled=${disabled || !controllable || intent.status === 'needs-configuration'}
        @click=${() => decide(intent.id, 'accept')}
      >
        Start review</button
      ><button ?disabled=${disabled || !controllable} @click=${() => decide(intent.id, 'defer')}>
        Defer
      </button>
    </div>
  </article>`;
}
