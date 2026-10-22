import type { ReactiveController } from 'lit';

import {
  Methods,
  type RunDecision,
  type RunGetResult,
  type RunRecipeRunsForRunResult,
} from '@farmslot/protocol';
import { resourceQuery } from '@farmslot/protocol/client-cache';

import { gateway } from '../../gateway-client.js';
import { getResourceWorkspaceKey } from '../../resource-cache.js';
import { ResourceQueryController } from '../shared/resource-query-controller.js';

import type { ReadyWorkspaceActionPresenter } from './ready-workspace-action-presenter.js';

/** Run and frozen-evidence reads share the same owner as the containing run view. */
export class ReadyWorkspaceQueries implements ReactiveController {
  readonly run: ResourceQueryController<RunGetResult>;
  readonly evidence: ResourceQueryController<RunRecipeRunsForRunResult>;
  private scope = '';
  private confirmationScope = '';
  private synchronizing = false;
  private generation = 0;
  private previousRunState?: object;
  private previousEvidenceState?: object;
  private ageClock?: ReturnType<typeof setInterval>;

  constructor(private readonly view: ReadyWorkspaceActionPresenter) {
    this.run = new ResourceQueryController(view, () => this.sync());
    this.evidence = new ResourceQueryController(view, () => this.sync());
    view.addController(this);
  }

  hostConnected(): void {
    this.sync();
  }

  hostDisconnected(): void {
    this.generation++;
    this.scope = '';
    clearInterval(this.ageClock);
    this.ageClock = undefined;
    this.view._retireWorkspaceCommands();
  }

  get decision(): RunDecision | undefined {
    return this.run.belongsToWorkspace && this.run.state.data?.run.id === this.view.runId
      ? this.run.state.data.run.decisions.find(({ id }) => id === this.view.decision?.id)
      : undefined;
  }

  get ready(): boolean {
    return this.run.ready && this.evidence.ready && Boolean(this.decision);
  }

  requireDecision(): RunDecision {
    const run = this.run.requireReady().run;
    this.evidence.requireReady();
    const decision = run.decisions.find(({ id }) => id === this.view.decision?.id);
    if (run.id !== this.view.runId || !decision || decision.resolvedAt)
      throw new Error('The gate changed. Review the current gate before acting.');
    return decision;
  }

  /** Busy cleanup belongs to the view, even when its connection has gone away. */
  capture(): { current: () => boolean; ownsView: () => boolean } {
    const generation = this.generation;
    const scope = this.viewScope();
    const connection = gateway.resourceConnectionId;
    const ownsView = () =>
      this.view.isConnected && generation === this.generation && scope === this.viewScope();
    return {
      ownsView,
      current: () =>
        ownsView() &&
        gateway.connectionState === 'connected' &&
        connection === gateway.resourceConnectionId,
    };
  }

  async retry(): Promise<void> {
    await Promise.all(
      [this.run, this.evidence].filter(({ state }) => state.error).map((read) => read.retry()),
    );
  }

  sync(): void {
    if (this.synchronizing || !this.view.isConnected || this.view._usesMockData) return;
    this.synchronizing = true;
    try {
      const scope = this.viewScope();
      if (this.scope !== scope) {
        this.generation++;
        this.scope = scope;
        this.view._retireWorkspaceCommands();
      }
      this.run.setQuery(
        this.view.runId ? resourceQuery(Methods.RUN_GET, { runId: this.view.runId }) : undefined,
      );
      const decision = this.decision;
      const payload = decision?.payload;
      this.evidence.setQuery(
        decision && payload?.kind === 'ready'
          ? resourceQuery(Methods.RUN_RECIPE_RUNS_FOR_RUN, {
              runId: this.view.runId,
              includeRecordedEvidence: true,
              decisionId: decision.id,
              evidenceSnapshotHash: payload.prPackage?.packageHash,
            })
          : undefined,
      );
      const confirmationScope = JSON.stringify([
        scope,
        payload?.kind === 'ready' ? payload.prPackage?.packageHash : undefined,
        decision?.resolvedAt,
        this.ready,
      ]);
      if (confirmationScope !== this.confirmationScope) {
        this.confirmationScope = confirmationScope;
        this.view._confirmTimer.clear();
        this.view._pendingConfirm = null;
      }
      if (this.run.state.observedAt && !this.run.ready && !this.ageClock)
        this.ageClock = setInterval(() => this.view.requestUpdate(), 1000);
      else if ((!this.run.state.observedAt || this.run.ready) && this.ageClock) {
        clearInterval(this.ageClock);
        this.ageClock = undefined;
      }
      if (
        this.previousRunState !== this.run.state ||
        this.previousEvidenceState !== this.evidence.state
      ) {
        this.previousRunState = this.run.state;
        this.previousEvidenceState = this.evidence.state;
        this.view._sharedWorkspaceQueriesChanged();
      }
    } finally {
      this.synchronizing = false;
    }
  }

  private viewScope(): string {
    return JSON.stringify([
      getResourceWorkspaceKey(),
      this.view.runId,
      this.view.slotId,
      this.view.decision?.id,
    ]);
  }
}
