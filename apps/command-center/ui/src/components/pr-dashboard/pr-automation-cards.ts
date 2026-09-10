import { html, nothing } from 'lit';

import {
  DEFAULT_PR_REVIEW_OPTIONS,
  monitoredPRUrl,
  type PRMonitor,
  type PRReviewIntent,
  type PRRuleActionRecord,
  type PRRuleNotification,
  type PRTeamProfile,
  type QueueItem,
  type Run,
} from '@farmslot/protocol';

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
) {
  const observation = monitor.observation;
  const incidents = monitor.incidents.filter((incident) => !incident.resolvedAt);
  const stale =
    monitor.lifecycle === 'active' &&
    (!observation ||
      Date.now() - Date.parse(observation.checkedAt) > monitor.config.pollIntervalMs + 60_000);
  return html`<article class="card" data-monitor-id=${monitor.id}>
    <div class="row">
      <a href=${monitoredPRUrl(monitor.config.pr)} target="_blank" rel="noopener noreferrer"
        >${monitor.config.pr.repo}#${monitor.config.pr.number}</a
      ><span>${monitor.lifecycle}</span
      ><span class="muted"
        >${monitor.config.policy.mode === 'notify-only'
          ? 'Notify only'
          : 'Automatic PR completion'}</span
      >
    </div>
    <h3>${observation?.title ?? 'Awaiting PR details'}</h3>
    <p class="muted">
      ${monitor.config.account.login} · ${monitor.config.project ?? 'No project'} · Checked
      ${time(observation?.checkedAt)}
    </p>
    ${stale
      ? html`<p class="attention">Observation is stale. Current PR health is unknown.</p>`
      : nothing}
    ${monitor.observationError ? html`<p class="error">${monitor.observationError}</p>` : nothing}
    ${observation
      ? html`<p>
          ${observation.state} · ${observation.mergeability} · ${observation.reviewDecision}
        </p>`
      : nothing}
    ${incidents.length
      ? html`<ul>
          ${incidents.map(
            (incident) =>
              html`<li>
                <a href=${incident.signal.url} target="_blank" rel="noopener noreferrer"
                  >${incident.signal.summary}</a
                >
                <span class="muted">
                  · ${incident.attemptCount} repair
                  attempt(s)${incident.handledAt
                    ? ' · feedback handled'
                    : ''}${incident.snoozedUntil
                    ? ` · snoozed until ${time(incident.snoozedUntil)}`
                    : ''}</span
                >
                ${incident.waitingReason
                  ? html`<p class="attention">${incident.waitingReason}</p>`
                  : nothing}
                <div class="row actions">
                  <button
                    ?disabled=${disabled}
                    @click=${() => act('acknowledge', monitor, incident.id)}
                  >
                    Acknowledge</button
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
      <button ?disabled=${disabled} @click=${() => act('refresh', monitor)}>Refresh facts</button>
      <button
        data-testid="pr-monitor-edit"
        ?disabled=${disabled}
        @click=${() => act('edit', monitor)}
      >
        Configure
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
        ?disabled=${disabled || monitor.lifecycle !== 'active' || !incidents.length}
        @click=${() => act('repair', monitor)}
      >
        Request repair
      </button>
    </div>
  </article>`;
}

export function reviewCard(
  intent: PRReviewIntent,
  teams: PRTeamProfile[],
  runs: Run[],
  queue: QueueItem[],
  disabled: boolean,
  decide: (id: string, action: 'accept' | 'defer') => void,
) {
  const run = runs.find((item) => item.id === intent.runId);
  const queued = queue.find((item) => item.id === intent.queueItemId);
  const trace = run?.repeatReviewContext?.session;
  const active = intent.contributions.filter((item) => item.eligible);
  const controllable =
    !intent.runId &&
    active.length > 0 &&
    !['running', 'completed', 'failed', 'withdrawn'].includes(intent.status);
  return html`<article class="card" data-review-id=${intent.id}>
    <div class="row">
      <a href=${monitoredPRUrl(intent.pr)} target="_blank" rel="noopener noreferrer"
        >${intent.pr.repo}#${intent.pr.number}</a
      ><span>${intent.status}</span
      ><span class="muted">${intent.reviewProfile} · Round ${intent.round ?? 1}</span>
    </div>
    <p>
      <code>${intent.headSha.slice(0, 12)}</code> ${intent.reviewedSha
        ? html` · Reviewed <code>${intent.reviewedSha.slice(0, 12)}</code>`
        : nothing}
    </p>
    ${intent.waitingReason ? html`<p class="attention">${intent.waitingReason}</p>` : nothing}
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
          ${review.scope} · ${review.validationDepth === 'full-live' ? 'Live QA' : 'Static code'} ·
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
        Accept / resume</button
      ><button ?disabled=${disabled || !controllable} @click=${() => decide(intent.id, 'defer')}>
        Defer
      </button>
    </div>
  </article>`;
}
