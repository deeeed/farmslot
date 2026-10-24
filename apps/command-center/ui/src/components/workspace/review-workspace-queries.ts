import type { ReactiveController, ReactiveControllerHost } from 'lit';

import {
  Methods,
  parseGitHubRef,
  reviewPostingFingerprint,
  reviewResultForRun,
  type RunDecision,
  type RunForSlotResult,
  type RunGetResult,
} from '@farmslot/protocol';
import { resourceQuery } from '@farmslot/protocol/client-cache';

import { gateway } from '../../gateway-client.js';
import { getResourceWorkspaceKey } from '../../resource-cache.js';
import type { ConfirmActionTimer } from '../shared/confirm-action-model.js';
import { ResourceQueryController } from '../shared/resource-query-controller.js';

export interface ReviewWorkspaceQueryHost extends ReactiveControllerHost {
  isConnected: boolean;
  runId: string;
  slotId: string;
  decision: RunDecision;
  readOnly: boolean;
  workspaceView: boolean;
  readonly _usesMockData: boolean;
  readonly _confirmTimer: Pick<ConfirmActionTimer, 'clear'>;
  _retireReviewScope(): void;
  _reviewInputsChanged(): void;
}

/** The shared full run owns gate inputs; explicit commands keep their own lifetime. */
export class ReviewWorkspaceQueries implements ReactiveController {
  readonly run: ResourceQueryController<RunGetResult>;
  readonly slot: ResourceQueryController<RunForSlotResult>;
  private scope = '';
  private confirmationScope = '';
  private generation = 0;
  private synchronizing = false;
  private previousState?: object;
  private ageClock?: ReturnType<typeof setInterval>;

  constructor(private readonly view: ReviewWorkspaceQueryHost) {
    this.run = new ResourceQueryController(view, () => this.sync());
    this.slot = new ResourceQueryController(view, () => this.sync());
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
    this.view._retireReviewScope();
  }

  get decision(): RunDecision | undefined {
    if (this.view._usesMockData) return this.view.decision;
    const run = this.run.belongsToWorkspace ? this.run.state.data?.run : undefined;
    if (run?.id !== this.view.runId) return;
    if (!this.view.readOnly) return run.decisions.find(({ id }) => id === this.view.decision?.id);
    const result = reviewResultForRun(run);
    if (!result) return;
    return {
      id: `saved-${run.id}`,
      type: 'engine_review_posting',
      title: 'Saved review',
      description: '',
      actions: [],
      createdAt: run.createdAt,
      payload: {
        kind: 'review',
        ...result,
        prNumber: run.prNumber ?? null,
        repo: parseGitHubRef(run.ticketOrPr)?.repo ?? null,
      },
    };
  }

  get ready(): boolean {
    return this.run.ready && Boolean(this.decision && !this.decision.resolvedAt);
  }

  requireDecision(actionId?: string): RunDecision {
    this.run.requireReady();
    const decision = this.decision;
    if (
      this.view.readOnly ||
      !decision ||
      decision.payload?.kind !== 'review' ||
      decision.resolvedAt ||
      (actionId && !decision.actions.some(({ id }) => id === actionId))
    )
      throw new Error('This review action is no longer available. Review the current decision.');
    return decision;
  }

  requireSlot(): void {
    const run = this.run.requireReady().run;
    const selected = this.slot.requireReady().run;
    if (run.slotId !== this.view.slotId || selected?.id !== run.id)
      throw new Error('This slot no longer belongs to the reviewed run. Open its current run.');
  }

  capture(): { current(): boolean; ownsView(): boolean } {
    const scope = this.viewScope();
    const generation = this.generation;
    const connection = gateway.resourceConnectionId;
    const ownsView = () =>
      this.view.isConnected && this.generation === generation && this.viewScope() === scope;
    return {
      ownsView,
      current: () =>
        ownsView() &&
        gateway.connectionState === 'connected' &&
        gateway.resourceConnectionId === connection,
    };
  }

  sync(): void {
    if (this.synchronizing || !this.view.isConnected || this.view._usesMockData) return;
    this.synchronizing = true;
    try {
      const scope = this.viewScope();
      if (scope !== this.scope) {
        this.scope = scope;
        this.generation++;
        this.view._retireReviewScope();
      }
      this.run.setQuery(
        this.view.runId ? resourceQuery(Methods.RUN_GET, { runId: this.view.runId }) : undefined,
      );
      this.slot.setQuery(
        this.view.slotId && !this.view.readOnly
          ? resourceQuery(Methods.RUN_FOR_SLOT, { slotId: this.view.slotId })
          : undefined,
      );
      const decision = this.decision;
      const confirmationScope = JSON.stringify([
        scope,
        this.ready,
        decision?.resolvedAt,
        decision?.actions,
        decision?.payload?.kind === 'review'
          ? reviewPostingFingerprint(decision.payload)
          : undefined,
      ]);
      if (confirmationScope !== this.confirmationScope) {
        this.confirmationScope = confirmationScope;
        this.view._confirmTimer.clear();
      }
      if (this.run.state.observedAt && !this.run.ready && !this.ageClock)
        this.ageClock = setInterval(() => this.view.requestUpdate(), 1000);
      else if ((!this.run.state.observedAt || this.run.ready) && this.ageClock) {
        clearInterval(this.ageClock);
        this.ageClock = undefined;
      }
      if (this.previousState !== this.run.state) {
        this.previousState = this.run.state;
        this.view._reviewInputsChanged();
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
      this.view.readOnly,
      this.view.workspaceView,
    ]);
  }
}
