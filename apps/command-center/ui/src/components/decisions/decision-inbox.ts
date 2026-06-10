import { createTwoFilesPatch } from 'diff';
import { html, LitElement, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';

import type {
  DecisionAction,
  DecisionType,
  ImprovementDiffPayload,
  ImprovementFileChange,
  PendingDecision,
  RetrospectivePayload,
  RunMeta,
} from '@farmslot/protocol';
import { Methods } from '@farmslot/protocol';

import '../diff-viewer/diff-review.js';
import '../shared/hydrating-placeholder.js';

import { gateway } from '../../gateway-client.js';
import { type AppState, getState, isHydrating, subscribe as subscribeState } from '../../state.js';
import { colors } from '../../styles/theme-tokens.js';
import { flowColor, flowLabel } from '../runs/run-utils.js';

import { decisionInboxStyles } from './decision-inbox-styles.js';

function toUnifiedDiff(change: ImprovementFileChange): string {
  return createTwoFilesPatch(
    change.filePath,
    change.filePath,
    change.before,
    change.after,
    '',
    '',
    { context: 3 },
  );
}

function typeLabel(type: DecisionType | string): string {
  switch (type) {
    case 'collision_check':
      return 'Collision check';
    case 'plan_confirmation':
      return 'Plan confirmation';
    case 'retrospective':
      return 'Retrospective';
    case 'review_posting':
      return 'Review posting';
    case 'blocked_alert':
      return 'Blocked alert';
    case 'review_comments':
      return 'Review comments';
    case 'ci_ci_timeout':
      return 'CI timeout';
    case 'ci_ci_failed':
      return 'CI failed';
    case 'ci_merge_conflict':
      return 'Merge conflict';
    case 'ci_review_comments':
      return 'Review comments';
    case 'ci_review_comments_early':
      return 'Early review comments';
    case 'improvement':
      return 'Improvement';
    case 'recipe_strategy':
      return 'Recipe strategy';
    default:
      if (type.startsWith('engine_'))
        return `Engine ${humanizeTypeSuffix(type.slice('engine_'.length))}`;
      if (type.startsWith('monitor_')) {
        return `Monitor ${humanizeTypeSuffix(type.slice('monitor_'.length))}`;
      }
      if (type.startsWith('ci_')) return `CI ${humanizeTypeSuffix(type.slice('ci_'.length))}`;
      return humanizeTypeSuffix(type);
  }
}

function humanizeTypeSuffix(type: string): string {
  return type
    .split('_')
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ');
}

function typeColor(type: DecisionType | string): string {
  switch (type) {
    case 'collision_check':
      return colors.statusWarn;
    case 'plan_confirmation':
      return colors.accent;
    case 'retrospective':
      return '#8b5cf6';
    case 'review_posting':
      return '#06b6d4';
    case 'blocked_alert':
      return colors.statusFail;
    case 'review_comments':
      return colors.statusWarn;
    case 'ci_ci_timeout':
      return colors.statusWarn;
    case 'ci_ci_failed':
      return colors.statusFail;
    case 'ci_merge_conflict':
      return colors.statusFail;
    case 'ci_review_comments':
      return colors.statusWarn;
    case 'ci_review_comments_early':
      return colors.statusWarn;
    case 'improvement':
      return '#22d3ee';
    default:
      return colors.statusUnknown;
  }
}

function actionStyle(style: DecisionAction['style']): string {
  switch (style) {
    case 'primary':
      return `background:${colors.accent}; color:#fff; border-color:${colors.accent};`;
    case 'danger':
      return `background:${colors.statusFail}22; color:${colors.statusFail}; border-color:${colors.statusFail}44;`;
    default:
      return `background:${colors.bgCard}; color:${colors.textPrimary}; border-color:#2a2a44;`;
  }
}

function slotMachine(slotId: string): string {
  return slotId.split('-')[0] ?? '';
}

@customElement('decision-inbox')
export class DecisionInbox extends LitElement {
  @state() private _decisions: PendingDecision[] = [];
  @state() private _filterProjects: string[] = [];
  @state() private _filterMachines: string[] = [];
  @state() private _resolving: Set<string> = new Set();
  @state() private _newIds: Set<string> = new Set();
  @state() private _chatInputs: Map<string, string> = new Map();
  @state() private _chatResponses: Map<string, string> = new Map();
  @state() private _chatSending: Set<string> = new Set();
  @state() private _applyToast: Map<string, string> = new Map();
  @state() private _livePayloads: Map<string, ImprovementDiffPayload> = new Map();
  @state() private _hydrating = false;
  private _slotProjectMap = new Map<string, string>();

  private _unsubState?: () => void;

  static styles = decisionInboxStyles;

  connectedCallback() {
    super.connectedCallback();
    // Initialize from current state immediately
    this._syncFromState(getState());
    // Subscribe for future updates
    this._unsubState = subscribeState((s) => {
      this._syncFromState(s);
    });
    // Refresh from gateway once on mount — recovers from staleness when the
    // bootstrap snapshot was hydrated long ago (cross-tab resolves, gateway
    // restart). Cheap call. The snapshot may briefly clobber a
    // RUN_DECISION_NEW that lands during the request — accepted trade-off:
    // any subsequent live event will re-add it via the deferred buffer, and
    // the snapshot is only authoritative for what's already persisted.
    void this._refreshFromGateway();
  }

  private async _refreshFromGateway(): Promise<void> {
    // Snapshot pre-request ids so any RUN_DECISION_NEW landing during the
    // request window (e.g. an analyzing placeholder) survives the merge.
    const preRequestIds = new Set(getState().decisions.map((d) => d.id));
    try {
      const res = (await gateway.request(Methods.DECISION_LIST)) as {
        decisions: PendingDecision[];
      };
      if (Array.isArray(res?.decisions)) {
        const { mergeDecisions } = await import('../../state.js');
        mergeDecisions(res.decisions, preRequestIds);
      }
    } catch (err) {
      console.warn('[decision-inbox] mount-time refresh failed:', (err as Error).message);
    }
  }

  private _syncFromState(s: AppState) {
    this._filterProjects = s.globalFilters.projects;
    this._filterMachines = s.globalFilters.machines;
    this._hydrating = isHydrating(s, 'decisions');
    // Build slot→project map from fleet for accurate filtering
    if (s.fleet?.slots) {
      this._slotProjectMap = new Map(s.fleet.slots.map((sl) => [sl.slot, sl.project]));
    }
    const sorted = [...s.decisions].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    // Detect newly added decisions for highlight animation
    const oldIds = new Set(this._decisions.map((d) => d.id));
    for (const d of sorted) {
      if (!oldIds.has(d.id)) {
        this._newIds = new Set([...this._newIds, d.id]);
        setTimeout(() => {
          this._newIds = new Set([...this._newIds].filter((id) => id !== d.id));
        }, 2500);
      }
    }
    // Remove resolved from resolving set
    const currentIds = new Set(sorted.map((d) => d.id));
    this._resolving = new Set([...this._resolving].filter((id) => currentIds.has(id)));
    this._decisions = sorted;
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubState?.();
  }

  private get _filtered(): PendingDecision[] {
    let result = this._decisions;
    if (this._filterProjects.length > 0) {
      result = result.filter((d) => {
        if (!d.slotId) return true;
        const project = this._slotProjectMap.get(d.slotId);
        return project ? this._filterProjects.includes(project) : true;
      });
    }
    if (this._filterMachines.length > 0) {
      result = result.filter(
        (d) => !d.slotId || this._filterMachines.includes(slotMachine(d.slotId)),
      );
    }
    return result;
  }

  private async _resolve(decision: PendingDecision, actionId: string) {
    const decisionId = decision.id;
    if (decision.type === 'improvement' && actionId === 'apply') {
      await this._applyImprovement(decision);
      return;
    }
    this._resolving = new Set([...this._resolving, decisionId]);
    try {
      await gateway.request(Methods.DECISION_RESOLVE, { decisionId, actionId });
      // Server will emit DECISION_RESOLVED event
    } catch {
      this._resolving = new Set([...this._resolving].filter((id) => id !== decisionId));
    }
  }

  private async _applyImprovement(decision: PendingDecision) {
    const decisionId = decision.id;
    const runId = decision.runMeta?.runId;
    this._resolving = new Set([...this._resolving, decisionId]);
    try {
      const res = (await gateway.request(Methods.IMPROVEMENT_APPLY, { runId, decisionId })) as {
        applied: unknown[];
        validationPassed: boolean;
        validationOutput?: string;
      };
      const passed = res.validationPassed;
      const msg = passed
        ? `Applied ${(res.applied as unknown[]).length} file(s). Validation passed.`
        : `Applied but validation FAILED:\n${(res.validationOutput ?? '').slice(0, 300)}`;
      this._applyToast = new Map([
        ...this._applyToast,
        [decisionId, passed ? `ok:${msg}` : `fail:${msg}`],
      ]);
      if (passed) {
        // gateway will remove decision from inbox; clear toast after delay
        setTimeout(() => {
          this._applyToast = new Map([...this._applyToast].filter(([k]) => k !== decisionId));
        }, 4000);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this._applyToast = new Map([...this._applyToast, [decisionId, `fail:${msg}`]]);
    } finally {
      this._resolving = new Set([...this._resolving].filter((id) => id !== decisionId));
    }
  }

  private async _sendChat(decision: PendingDecision) {
    const decisionId = decision.id;
    const runId = decision.runMeta?.runId;
    const message = this._chatInputs.get(decisionId) ?? '';
    if (!message.trim()) return;
    this._chatSending = new Set([...this._chatSending, decisionId]);
    try {
      const res = (await gateway.request(Methods.IMPROVEMENT_CHAT, {
        runId,
        decisionId,
        message,
      })) as { text: string; updatedChanges?: unknown };
      this._chatResponses = new Map([...this._chatResponses, [decisionId, res.text ?? '']]);
      this._chatInputs = new Map([...this._chatInputs, [decisionId, '']]);
      // If the server returned updated proposed changes, store them for live re-render
      if (res?.updatedChanges) {
        const current =
          this._livePayloads.get(decisionId) ??
          (decision.payload as ImprovementDiffPayload | undefined);
        if (current) {
          const updated: ImprovementDiffPayload = {
            ...current,
            proposedChanges: res.updatedChanges as ImprovementDiffPayload['proposedChanges'],
          };
          this._livePayloads = new Map([...this._livePayloads, [decisionId, updated]]);
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this._chatResponses = new Map([...this._chatResponses, [decisionId, `Error: ${msg}`]]);
    } finally {
      this._chatSending = new Set([...this._chatSending].filter((id) => id !== decisionId));
    }
  }

  private _renderImprovementCard(d: PendingDecision) {
    const raw = this._livePayloads.get(d.id) ?? (d.payload as ImprovementDiffPayload | undefined);
    if (!raw || raw.kind !== 'improvement') return nothing;

    // Lifecycle states added with combined-learnings landing — surface them as
    // dedicated cards so silent skips are visible.
    const status = raw.analysisStatus;
    if (status === 'analyzing') {
      return html`<div class="improvement-rationale">
        Analyzing combined learnings… typically 1-3 minutes. The card will update with proposed
        changes (or a "no changes" notice) when the LLM finishes.
      </div>`;
    }
    if (status === 'no-content') {
      return html`<div class="improvement-rationale">
        ${raw.rationale ||
        'No learnings.md content was found, so the improvement engine has nothing to analyze.'}
      </div>`;
    }
    if (status === 'no-changes') {
      return html`<div class="improvement-rationale">
        No template changes proposed. ${raw.rationale ?? ''}
      </div>`;
    }
    if (status === 'error') {
      return html`<div class="improvement-rationale" style="border-left-color:#ff4444;">
        Improvement analysis failed: ${raw.analysisError ?? raw.rationale}
      </div>`;
    }

    const chatInput = this._chatInputs.get(d.id) ?? '';
    const chatResponse = this._chatResponses.get(d.id);
    const isSending = this._chatSending.has(d.id);
    const toast = this._applyToast.get(d.id);

    return html`
      ${raw.rationale ? html` <div class="improvement-rationale">${raw.rationale}</div> ` : nothing}

      <div class="improvement-chat">
        <div class="chat-row">
          <input
            class="chat-input"
            type="text"
            placeholder="Ask about these changes..."
            .value=${chatInput}
            @input=${(e: InputEvent) => {
              const val = (e.target as HTMLInputElement).value;
              this._chatInputs = new Map([...this._chatInputs, [d.id, val]]);
            }}
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === 'Enter' && !isSending) this._sendChat(d);
            }}
          />
          <button
            class="chat-send-btn"
            ?disabled=${isSending || !chatInput.trim()}
            @click=${() => this._sendChat(d)}
          >
            ${isSending ? '...' : 'Send'}
          </button>
        </div>
        ${chatResponse ? html`<div class="chat-response">${chatResponse}</div>` : nothing}
      </div>

      <div class="improvement-diff-count">
        ${raw.proposedChanges.length} file${raw.proposedChanges.length !== 1 ? 's' : ''}
      </div>

      ${raw.proposedChanges.map(
        (change) => html`
          <div class="improvement-diff">
            <diff-review .diff=${toUnifiedDiff(change)} .filename=${change.filePath}></diff-review>
          </div>
        `,
      )}
      ${raw.learningContent
        ? html`
            <details class="improvement-learning">
              <summary>Learning content</summary>
              <div class="improvement-learning-body">${raw.learningContent}</div>
            </details>
          `
        : nothing}
      ${toast
        ? html`
            <div class="apply-toast ${toast.startsWith('ok:') ? 'ok' : 'fail'}">
              ${toast.slice(3)}
            </div>
          `
        : nothing}
    `;
  }

  private _renderRetrospectiveCard(d: PendingDecision) {
    const payload = d.payload as RetrospectivePayload | undefined;
    if (!payload || payload.kind !== 'retrospective') return nothing;
    const familyHref = d.runMeta?.familyId
      ? `#family/${d.runMeta.familyId}${d.runMeta.runId ? `?run=${encodeURIComponent(d.runMeta.runId)}` : ''}`
      : null;

    return html`
      <div class="retro-card">
        <div class="retro-what">${payload.whatThisIs}</div>
        <div class="retro-row">
          <span class="retro-label">Outcome</span
          ><span class="retro-value">${payload.outcome}</span>
        </div>
        ${payload.ciWatch
          ? html`
              <div class="retro-row">
                <span class="retro-label">CI Watch</span>
                <span class="retro-value">
                  ${payload.ciWatch.result ?? 'unknown'}
                  ${payload.ciWatch.total != null
                    ? html` · ${payload.ciWatch.passed ?? 0}/${payload.ciWatch.total} passed`
                    : nothing}
                  ${(payload.ciWatch.failed ?? 0) > 0
                    ? html` · ${payload.ciWatch.failed} failed`
                    : nothing}
                  ${(payload.ciWatch.pending ?? 0) > 0
                    ? html` · ${payload.ciWatch.pending} pending`
                    : nothing}
                </span>
              </div>
            `
          : nothing}
        ${payload.selfReviewVerdict
          ? html`
              <div class="retro-row">
                <span class="retro-label">Self Review</span
                ><span class="retro-value">${payload.selfReviewVerdict}</span>
              </div>
            `
          : nothing}
        ${payload.selfReviewSummary
          ? html`
              <div class="retro-row">
                <span class="retro-label">Self Review Summary</span>
                <div class="retro-text">${payload.selfReviewSummary}</div>
              </div>
            `
          : nothing}
        ${payload.commentsTriageSummary
          ? html`
              <div class="retro-row">
                <span class="retro-label">Reviewer comments</span>
                <span class="retro-value">
                  ${payload.commentsTriageSummary.total} total ·
                  ${payload.commentsTriageSummary.real} REAL ·
                  ${payload.commentsTriageSummary.fixed} fixed
                  ${payload.commentsTriageSummary.actionablePaths?.length
                    ? html` · paths: ${payload.commentsTriageSummary.actionablePaths.join(', ')}`
                    : nothing}
                </span>
              </div>
            `
          : nothing}
        ${payload.rootLearnings || payload.deltaLearnings
          ? html`
              ${payload.rootLearnings
                ? html`
                    <details class="retro-details">
                      <summary>
                        Original fix-bug
                        learnings${payload.rootRunId
                          ? html` (run ${payload.rootRunId.slice(0, 8)})`
                          : nothing}
                      </summary>
                      <div class="retro-text">${payload.rootLearnings}</div>
                    </details>
                  `
                : nothing}
              ${payload.deltaLearnings
                ? html`
                    <details class="retro-details" open>
                      <summary>Reviewer-driven delta</summary>
                      <div class="retro-text">${payload.deltaLearnings}</div>
                    </details>
                  `
                : nothing}
            `
          : payload.workerLearnings
            ? html`
                <details class="retro-details">
                  <summary>Worker Learnings</summary>
                  <div class="retro-text">${payload.workerLearnings}</div>
                </details>
              `
            : nothing}
        ${payload.reportExcerpt
          ? html`
              <details class="retro-details">
                <summary>Worker Report</summary>
                <div class="retro-text">${payload.reportExcerpt}</div>
              </details>
            `
          : nothing}
        ${familyHref
          ? html`<a class="retro-open" href=${familyHref}>Open retrospective →</a>`
          : nothing}
        <div class="retro-effects">
          ${payload.actionEffects.map(
            (effect) => html`
              <div class="retro-effect">
                <div class="retro-effect-label">
                  ${d.actions.find((action) => action.id === effect.actionId)?.label ??
                  effect.actionId}
                </div>
                <div class="retro-effect-text">${effect.summary}</div>
              </div>
            `,
          )}
        </div>
      </div>
    `;
  }

  private _workspaceCta(d: PendingDecision): { href: string; label: string } | null {
    const kind = (d.payload as { kind?: string } | undefined)?.kind;
    if ((kind === 'review' || kind === 'ready') && d.runMeta?.runId) {
      return {
        href: `#run/${d.runMeta.runId}`,
        label: kind === 'review' ? 'Open review screen' : 'Open ready screen',
      };
    }
    if (kind === 'retrospective' && d.runMeta?.familyId && d.runMeta?.runId) {
      return {
        href: `#family/${d.runMeta.familyId}?run=${encodeURIComponent(d.runMeta.runId)}`,
        label: 'Open retrospective',
      };
    }
    return null;
  }

  private _formatTime(iso: string): string {
    const d = new Date(iso);
    const now = Date.now();
    const diffMs = now - d.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHrs = Math.floor(diffMin / 60);
    if (diffHrs < 24) return `${diffHrs}h ago`;
    return d.toLocaleDateString();
  }

  private _prUrl(meta: RunMeta): string | null {
    // ticketOrPr like "example-org/example-mobile#28072" or just "#28072"
    const t = meta.ticketOrPr;
    if (!t) return null;
    const full = t.match(/^([^#]+)#(\d+)$/);
    if (full) return `https://github.com/${full[1]}/pull/${full[2]}`;
    const short = t.match(/^#(\d+)$/);
    if (short && meta.prNumber) return null; // no repo info
    return null;
  }

  private _renderChecks(d: PendingDecision) {
    const checks = (d.context as Record<string, unknown>)?.checks as
      | Array<{ name: string; status: string }>
      | undefined;
    if (!checks?.length) return nothing;
    const failed = checks.filter((c) => c.status === 'fail');
    const pending = checks.filter((c) => c.status === 'pending');
    const items = [
      ...failed.map((c) => ({ name: c.name, color: colors.statusFail })),
      ...pending.map((c) => ({ name: c.name, color: colors.statusWarn })),
    ];
    if (!items.length) return nothing;
    return html`
      <div class="check-list">
        ${items.map(
          (i) => html`
            <div class="check-item">
              <span class="check-dot" style="background:${i.color}"></span>
              <span class="check-name">${i.name}</span>
            </div>
          `,
        )}
      </div>
    `;
  }

  private _renderMeta(meta: RunMeta) {
    const fc = flowColor(meta.flowType);
    const prUrl = this._prUrl(meta);
    const prLabel = meta.prNumber ? `PR #${meta.prNumber}` : null;
    const runner = [meta.runner, meta.model].filter(Boolean).join('/');

    return html`
      <div class="decision-meta">
        <span class="meta-flow" style="background:${fc}22; color:${fc}"
          >${flowLabel(meta.flowType)}</span
        >
        ${prLabel
          ? prUrl
            ? html`<a class="meta-pr" href=${prUrl} target="_blank" rel="noopener">${prLabel}</a>`
            : html`<span class="meta-pr">${prLabel}</span>`
          : nothing}
        ${meta.branch
          ? html`<span class="meta-sep">·</span><span class="meta-branch">${meta.branch}</span>`
          : nothing}
        ${runner
          ? html`<span class="meta-sep">·</span><span class="meta-runner">${runner}</span>`
          : nothing}
        <a class="meta-view-run" href="#run/${meta.runId}">View run →</a>
      </div>
    `;
  }

  render() {
    return html`
      <div class="inbox-header">
        <span class="inbox-title">Decisions</span>
        <span class="inbox-count">${this._filtered.length} pending</span>
      </div>
      <div class="inbox-body">
        ${this._filtered.length === 0
          ? this._hydrating
            ? html`<farm-hydrating message="Loading decisions…"></farm-hydrating>`
            : html`
                <div class="empty-state">
                  <div class="empty-check">&#10003;</div>
                  <div class="empty-text">
                    ${this._decisions.length === 0
                      ? 'No pending decisions'
                      : 'No decisions match current filters'}
                  </div>
                </div>
              `
          : this._filtered.map((d) => {
              const color = typeColor(d.type);
              const isNew = this._newIds.has(d.id);
              const isResolving = this._resolving.has(d.id);
              const workspaceCta = this._workspaceCta(d);

              return html`
                <div class="decision ${isNew ? 'new' : ''}">
                  <div class="decision-top">
                    <div
                      class="type-icon"
                      style="background:${color}22; color:${color}"
                      title=${d.type}
                      aria-label=${`Decision type: ${typeLabel(d.type)}`}
                    >
                      ${typeLabel(d.type)}
                    </div>
                    <span class="decision-title">${d.title}</span>
                    ${d.slotId ? html`<span class="decision-slot">${d.slotId}</span>` : ''}
                    <span class="decision-time">${this._formatTime(d.createdAt)}</span>
                  </div>
                  ${d.runMeta ? this._renderMeta(d.runMeta) : nothing}
                  ${d.runMeta?.summary
                    ? html`<div class="decision-summary">${d.runMeta.summary}</div>`
                    : nothing}
                  <div class="decision-desc">${d.description}</div>
                  ${this._renderChecks(d)}
                  ${d.type === 'retrospective' ? this._renderRetrospectiveCard(d) : nothing}
                  ${d.type === 'improvement' ? this._renderImprovementCard(d) : nothing}
                  ${workspaceCta
                    ? html`
                        <div class="decision-actions">
                          <a class="decision-open-link" href=${workspaceCta.href}
                            >${workspaceCta.label} →</a
                          >
                        </div>
                      `
                    : html`
                        <div class="decision-actions">
                          ${d.actions.map(
                            (action) => html`
                              <button
                                class="decision-btn"
                                style=${actionStyle(action.style)}
                                ?disabled=${isResolving}
                                @click=${() => this._resolve(d, action.id)}
                              >
                                ${action.label}
                              </button>
                            `,
                          )}
                        </div>
                      `}
                </div>
              `;
            })}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'decision-inbox': DecisionInbox;
  }
}
