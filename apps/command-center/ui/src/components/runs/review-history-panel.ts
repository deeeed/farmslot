import { html, LitElement, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import {
  type FamilyObservabilityArtifact,
  type FsReadResult,
  type GitDiffResult,
  type GitShowResult,
  Methods,
  reviewedFindingContext,
  type Run,
} from '@farmslot/protocol';
import {
  loadReviewHistoryArtifacts,
  mergeReviewHistoryArtifacts,
  type ReviewHistoryArtifacts,
  type ReviewHistoryFinding,
  reviewHistoryIdentity,
  type ReviewHistoryRound,
  reviewHistorySourceRequest,
  reviewHistoryView,
} from '@farmslot/review-dispatch';

import '../shared/diff-viewer-modal.js';
import '../diff-viewer/code-viewer.js';

import { gateway } from '../../gateway-client.js';
import { gatewayHttpFetch } from '../../utils/gateway-origin.js';
import { currentRecoveryEpoch, isRecoveryEpochCurrent } from '../../utils/reconnect.js';
import { runArtifactApiPath } from '../workspace/workspace-artifacts.js';

import { reviewHistoryStyles } from './review-history-styles.js';
import { renderReviewAttempt, renderReviewFix } from './step-inspector-review-renderer.js';

@customElement('review-history-panel')
export class ReviewHistoryPanel extends LitElement {
  @property({ attribute: false }) run?: Run;
  static styles = reviewHistoryStyles;
  private clock?: ReturnType<typeof setInterval>;
  private unsubscribeConnection?: () => void;
  connectedCallback() {
    super.connectedCallback();
    this.clock = setInterval(() => this.requestUpdate(), 30000);
    this.unsubscribeConnection = gateway.onConnectionChange(() => {
      void this._loadHistory(true);
    });
  }
  disconnectedCallback() {
    this.unsubscribeConnection?.();
    clearInterval(this.clock);
    super.disconnectedCallback();
  }
  updated() {
    void this._loadHistory();
  }
  @state() private _historyArtifacts: ReviewHistoryArtifacts = {};
  private _historyIdentity = '';
  private _historyArtifactScope = '';
  @state() private _historyLoading = false;
  @state() private _historyDiff: {
    path: string;
    text: string;
    runId: string;
    epoch: number;
  } | null = null;

  private async _loadHistory(force = false) {
    const run = this.run;
    if (!run) return;
    const epoch = currentRecoveryEpoch();
    const identity = `${epoch}:${reviewHistoryIdentity(run)}`;
    if (!force && identity === this._historyIdentity) return;
    this._historyIdentity = identity;
    const scope = `${epoch}:${run.id}`;
    if (this._historyArtifactScope !== scope) this._historyArtifacts = {};
    this._historyArtifactScope = scope;
    this._historyLoading = true;
    const artifacts = await loadReviewHistoryArtifacts(
      run,
      async (path) => {
        const response = await gatewayHttpFetch(runArtifactApiPath(run.id, { path }));
        if (response.status === 404) return null;
        if (!response.ok) throw new Error(`Artifact HTTP ${response.status}`);
        return response.text();
      },
      async (params) => {
        if (!isRecoveryEpochCurrent(epoch)) throw new Error('Farm connection changed');
        return (await gateway.request<FsReadResult>(Methods.FS_READ, params)).content;
      },
      async (params) => {
        if (!isRecoveryEpochCurrent(epoch)) throw new Error('Farm connection changed');
        return (await gateway.request<GitDiffResult>(Methods.GIT_DIFF, params)).diff;
      },
    );
    if (
      this.isConnected &&
      isRecoveryEpochCurrent(epoch) &&
      this.run?.id === run.id &&
      this._historyIdentity === identity
    ) {
      this._historyArtifacts = mergeReviewHistoryArtifacts(this._historyArtifacts, artifacts);
      this._historyLoading = false;
    }
  }

  render() {
    if (!this.run) return nothing;
    const history = reviewHistoryView(
      this.run,
      this._historyArtifactScope === `${currentRecoveryEpoch()}:${this.run.id}`
        ? this._historyArtifacts
        : {},
    );
    if (!history.roundCount && !history.segments.length && !history.chain.length) return nothing;
    const openArtifact = (path: string) => {
      if (!this.run) return;
      const content = this._historyArtifacts[path]?.content;
      if (content !== undefined) {
        this._historyDiff = {
          path: path.startsWith('history:')
            ? (() => {
                const round = history.checks
                  .flatMap((check) => check.rounds)
                  .find((round) => round.diffPath === path || round.fixDiffPath === path);
                return `Frozen code · ${round?.diffPath === path ? round.reviewRange : (round?.fixRange ?? '')}`;
              })()
            : path,
          text: content,
          runId: this.run.id,
          epoch: currentRecoveryEpoch(),
        };
        return;
      }
      const artifact: FamilyObservabilityArtifact = {
        runId: this.run.id,
        familyId: this.run.familyId,
        path,
        purpose: 'diff',
        source: 'artifact-manifest',
      };
      location.hash = `#run/${artifact.runId}?tab=files&file=${encodeURIComponent(artifact.path)}`;
    };
    return html`<section data-testid="review-history">
      ${history.activeReplay
        ? html`<p role="status" data-testid="review-history-replay">
            Round ${history.activeReplay.roundNumber} · Replay starting ·
            ${history.activeReplay.startedAt}
          </p>`
        : nothing}
      <div class="history-header">
        <div>
          <h3>Review history</h3>
          <span class="review-loop-meta">${history.summary}</span>
        </div>
        <button @click=${() => this._loadHistory(true)}>Refresh</button>
      </div>
      ${this._historyLoading
        ? html`<div class="review-loop-meta">Loading recorded round details…</div>`
        : nothing}
      <div class="timeline">
        ${history.events.map((event) =>
          event.kind === 'review'
            ? renderReviewAttempt(
                event.round,
                this._historyLoading,
                openArtifact,
                (finding) => void this._openSource(event.round, finding),
                (finding) => this._renderSource(event.round, finding),
              )
            : event.kind === 'fix'
              ? renderReviewFix(event.fix, openArtifact)
              : html`<div class="history-gate">${event.label}</div>`,
        )}
      </div>
      <diff-viewer-modal
        .open=${Boolean(
          this._historyDiff &&
          this._historyDiff.runId === this.run.id &&
          this._historyDiff.epoch === currentRecoveryEpoch(),
        )}
        .title=${this._historyDiff?.path ?? 'Fix changes'}
        .diffText=${this._historyDiff?.text ?? ''}
        @diff-modal-close=${() => {
          this._historyDiff = null;
        }}
      ></diff-viewer-modal>
    </section>`;
  }

  @state() private source: {
    key: string;
    runId: string;
    epoch: number;
    loading: boolean;
    content: string;
    error: string;
  } | null = null;

  private async _openSource(round: ReviewHistoryRound, finding: ReviewHistoryFinding) {
    if (!this.run) return;
    if (this.source?.key === `${round.key}:${finding.id}`) {
      this.source = null;
      return;
    }
    const params = reviewHistorySourceRequest(this.run, round, finding);
    if (!params) return;
    const selection = {
      key: `${round.key}:${finding.id}`,
      runId: this.run.id,
      epoch: currentRecoveryEpoch(),
      loading: true,
      content: '',
      error: '',
    };
    this.source = selection;
    try {
      const result = await gateway.request<GitShowResult>(Methods.GIT_SHOW, params);
      if (this.source !== selection || !isRecoveryEpochCurrent(selection.epoch)) return;
      const context = reviewedFindingContext(result.content, finding.line!);
      this.source = {
        ...selection,
        loading: false,
        content: context.available ? result.content : '',
        error: context.note,
      };
    } catch (error) {
      if (this.source === selection)
        this.source = {
          ...selection,
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        };
    }
  }

  private _renderSource(round: ReviewHistoryRound, finding: ReviewHistoryFinding) {
    const source = this.source;
    if (
      !source ||
      source.key !== `${round.key}:${finding.id}` ||
      source.runId !== this.run?.id ||
      !isRecoveryEpochCurrent(source.epoch)
    )
      return nothing;
    return html`<div class="review-loop-meta">
        Reviewed ${round.headSha?.slice(0, 8)} · ${finding.file}:${finding.line}
      </div>
      ${source.loading
        ? html`<div role="status">Loading reviewed source…</div>`
        : source.error
          ? html`<div role="alert">${source.error}</div>`
          : html`<code-viewer
              .content=${source.content}
              .filePath=${finding.file}
              .filename=${finding.file.split('/').at(-1) ?? ''}
              .revealLine=${finding.line ?? 0}
            ></code-viewer>`}`;
  }
}
