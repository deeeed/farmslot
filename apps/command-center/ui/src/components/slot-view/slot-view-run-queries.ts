import type { ReactiveController } from 'lit';

import {
  Methods,
  type Run,
  type RunForSlotResult,
  type RunGetResult,
  type RunRecipeRunsForRunResult,
} from '@farmslot/protocol';
import { resourceQuery } from '@farmslot/protocol/client-cache';

import { gateway } from '../../gateway-client.js';
import { getResourceWorkspaceKey } from '../../resource-cache.js';
import { ResourceQueryController } from '../shared/resource-query-controller.js';

import type { SlotView } from './slot-view.js';
import { selectSlotViewLinkedRun } from './slot-view-linked-run-model.js';
import { slotBoundRunIdForSlot } from './slot-view-model.js';
import {
  applySlotViewRecipeRunsResult,
  clearSlotViewRecipeRuns,
  retireSlotViewRunCommands,
} from './slot-view-recipe-run-effects.js';
import { getSlotViewHashParam, requestedRunFromHash } from './slot-view-url-state.js';

/** Shared queries own run selection and inventory; this controller owns their view transitions. */
export class SlotViewRunQueries implements ReactiveController {
  readonly slot: ResourceQueryController<RunForSlotResult>;
  readonly pinned: ResourceQueryController<RunGetResult>;
  readonly recipes: ResourceQueryController<RunRecipeRunsForRunResult>;
  private scope?: string;
  private previousStatus: string | null = null;
  private recipeData?: RunRecipeRunsForRunResult;
  private synchronizing = false;
  private generation = 0;
  private ageClock?: ReturnType<typeof setInterval>;

  constructor(private readonly view: SlotView) {
    this.slot = new ResourceQueryController(view, () => this.sync());
    this.pinned = new ResourceQueryController(view, () => this.sync());
    this.recipes = new ResourceQueryController(view, () => this.sync());
    view.addController(this);
  }

  hostConnected(): void {
    this.sync();
  }
  hostDisconnected(): void {
    this.generation++;
    clearInterval(this.ageClock);
    this.ageClock = undefined;
    this.scope = undefined;
    this.previousStatus = null;
    this.recipeData = undefined;
  }

  get ready(): boolean {
    return this.slot.ready && (!requestedRunFromHash() || this.pinned.ready);
  }

  private select(slot: RunForSlotResult | undefined, pinned: RunGetResult | undefined): Run | null {
    const view = this.view;
    const slotBoundRunId = slotBoundRunIdForSlot(view.slotId, view._slot?.currentRunId, undefined);
    const candidate = pinned?.run;
    return selectSlotViewLinkedRun({
      slotId: view.slotId,
      requestedRunId: requestedRunFromHash(),
      requestedContextId: getSlotViewHashParam('contextId'),
      slotBoundRunId,
      cachedRun:
        candidate && (candidate.slotId === view.slotId || candidate.id === slotBoundRunId)
          ? candidate
          : null,
      rpcRun: slot?.run ?? null,
    });
  }

  requireRun(): Run {
    if (!this.view.isConnected || !this.view._isLive || this.view._isRecoveryBlocked)
      throw new Error('Wait for the slot workspace to recover before acting.');
    const slot = this.slot.requireReady();
    const pinned = requestedRunFromHash() ? this.pinned.requireReady() : undefined;
    const run = this.select(slot, pinned);
    if (!run || run.id !== this.view._linkedRun?.id)
      throw new Error('The selected run changed. Review the current run before acting.');
    return run;
  }

  requireRecipes(): Run {
    const run = this.requireRun();
    this.recipes.requireReady();
    return run;
  }

  capture(): () => boolean {
    const run = this.requireRun();
    const generation = this.generation;
    const workspace = getResourceWorkspaceKey();
    const connection = gateway.resourceConnectionId;
    return () =>
      this.view.isConnected &&
      generation === this.generation &&
      workspace === getResourceWorkspaceKey() &&
      connection === gateway.resourceConnectionId &&
      gateway.connectionState === 'connected' &&
      this.view._linkedRun?.id === run.id;
  }

  async retry(): Promise<void> {
    const reads = [this.slot, ...(requestedRunFromHash() ? [this.pinned] : []), this.recipes];
    await Promise.all(reads.filter((read) => read.state.error).map((read) => read.retry()));
  }

  sync(): string | null {
    const view = this.view;
    if (this.synchronizing || !view.isConnected || !view._isLive) return this.previousStatus;
    this.synchronizing = true;
    try {
      const requestedRunId = requestedRunFromHash();
      const scope = JSON.stringify([
        getResourceWorkspaceKey(),
        view.slotId,
        requestedRunId,
        getSlotViewHashParam('contextId'),
      ]);
      if (scope !== this.scope) {
        this.generation++;
        this.scope = scope;
        this.previousStatus = null;
        this.recipeData = undefined;
        view._resetRecipePanelState();
      }
      this.slot.setQuery(
        view.slotId
          ? resourceQuery<RunForSlotResult>(Methods.RUN_FOR_SLOT, { slotId: view.slotId })
          : undefined,
      );
      this.pinned.setQuery(
        requestedRunId
          ? resourceQuery<RunGetResult>(Methods.RUN_GET, { runId: requestedRunId })
          : undefined,
      );
      const run = this.select(
        this.slot.belongsToWorkspace ? this.slot.state.data : undefined,
        this.pinned.belongsToWorkspace ? this.pinned.state.data : undefined,
      );
      view._linkedRunCurrent = this.ready;
      view._linkedRunReadError =
        this.pinned.state.error?.message ?? this.slot.state.error?.message ?? '';
      const observation =
        requestedRunId && run?.id === requestedRunId ? this.pinned.state : this.slot.state;
      view._linkedRunObservedAt = observation.observedAt;
      if (run !== view._linkedRun) {
        if (run?.id !== view._linkedRun?.id) {
          this.generation++;
          retireSlotViewRunCommands(view);
        }
        if (run || this.ready)
          this.previousStatus = view._applyLinkedRun(
            run,
            this.previousStatus,
            this.ready ? 'rpc' : 'cache',
          );
        else view._resetRecipePanelState();
      }
      this.recipes.setQuery(
        run
          ? resourceQuery<RunRecipeRunsForRunResult>(Methods.RUN_RECIPE_RUNS_FOR_RUN, {
              runId: run.id,
            })
          : undefined,
      );
      view._recipeRunsCurrent = this.recipes.ready;
      view._recipeRunsLoading = Boolean(
        run && !this.recipes.state.data && this.recipes.state.status === 'loading',
      );
      view._recipeRunsError = this.recipes.state.error?.message ?? '';
      if (run && this.recipes.belongsToWorkspace && this.recipes.state.data) {
        if (this.recipeData !== this.recipes.state.data) {
          this.recipeData = this.recipes.state.data;
          applySlotViewRecipeRunsResult(view, run, this.recipeData);
        }
      } else {
        this.recipeData = undefined;
        clearSlotViewRecipeRuns(view);
      }
      if (run && !this.ready && !this.ageClock)
        this.ageClock = setInterval(() => view.requestUpdate(), 1000);
      else if ((!run || this.ready) && this.ageClock) {
        clearInterval(this.ageClock);
        this.ageClock = undefined;
      }
      return this.previousStatus;
    } finally {
      this.synchronizing = false;
    }
  }
}
