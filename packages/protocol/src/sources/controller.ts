import type { GatewayResourceCache, ResourceQueryStatus } from '../client-cache/index.js';
import type { SourcesStatusResult } from '../rpc/sources.js';

import {
  type PreparedSourceCommand,
  type SourceCommandClient,
  sourceStatusParamsForTarget,
  sourceStatusQuery,
} from './client.js';
import type { SourceSelection } from './pins.js';
import {
  deriveSourceStatusView,
  type SourceStatusViewContext,
  type SourceStatusViewModel,
  type SourceViewAction,
} from './status-view.js';

export interface SourceStatusSnapshot {
  freshness: ResourceQueryStatus;
  observedAt?: number;
  loading: boolean;
  busy: boolean;
  view?: SourceStatusViewModel;
  error?: string;
  operationError?: string;
  notice?: string;
  pending?: PreparedSourceCommand;
  pendingLabel?: string;
  canRetry?: boolean;
  selections: SourceSelection[];
  interactive: boolean;
  canEdit: boolean;
  selectionRefusal?: string;
  /** Render nothing: no facts or failure yet, an empty context, or a viewer that cannot read. */
  hidden: boolean;
  /** Render the rows' pin and sync controls. */
  controls: boolean;
  /** The gateway reports sources but did not announce live source status. */
  unsupported: boolean;
}

function commandLabel(command: PreparedSourceCommand): string {
  if (command.method === 'sources.sync')
    return `Sync ${command.params.sourceId ?? 'sources'} on ${command.params.nodeId ?? 'the farm'}`;
  return `${command.method === 'sources.pin' ? `Pin ${command.params.sourceId} to ${command.params.ref}` : `Return ${command.params.sourceId} to main`} on ${command.params.scope} ${command.params.targetId}`;
}

/** One context-bound controller serves thin web/native status and selection renderers. */
export class SourceStatusController {
  private context: SourceStatusViewContext;
  private status?: SourcesStatusResult;
  private version = 0;
  private listeners = new Set<() => void>();
  private snapshot: SourceStatusSnapshot;
  private pendingConnectionKey?: string;
  private stopQuery?: () => void;
  private deniedRead = false;
  private ageTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly client: SourceCommandClient,
    context: SourceStatusViewContext,
    private cache?: GatewayResourceCache,
  ) {
    this.context = structuredClone(context);
    this.snapshot = {
      freshness: 'loading',
      loading: false,
      busy: false,
      selections: structuredClone([...(context.selections ?? [])]),
      interactive: true,
      canEdit: false,
      hidden: true,
      controls: false,
      unsupported: false,
    };
    this.update({});
    this.observeQuery();
  }

  getSnapshot = (): SourceStatusSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    this.updateAgeTimer();
    return () => {
      this.listeners.delete(listener);
      this.updateAgeTimer();
    };
  };

  /** Repaint relative age only; this clock never refreshes facts or changes selections. */
  private updateAgeTimer(): void {
    if (this.ageTimer !== undefined) clearTimeout(this.ageTimer);
    this.ageTimer = undefined;
    if (
      !this.listeners.size ||
      this.snapshot.freshness === 'ready' ||
      !this.snapshot.view ||
      this.snapshot.observedAt === undefined
    )
      return;
    const elapsed = Math.max(0, Date.now() - this.snapshot.observedAt);
    const interval = elapsed < 60_000 ? 1000 : 60_000;
    this.ageTimer = setTimeout(
      () => {
        this.ageTimer = undefined;
        this.snapshot = { ...this.snapshot };
        for (const listener of this.listeners) listener();
        this.updateAgeTimer();
      },
      interval - (elapsed % interval),
    );
  }

  private update(change: Partial<SourceStatusSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...change };
    this.snapshot.view = this.status
      ? deriveSourceStatusView(this.status, {
          ...this.context,
          ...(this.context.selections !== undefined || this.snapshot.selections.length
            ? { selections: this.snapshot.selections }
            : {}),
        })
      : undefined;
    this.snapshot.interactive =
      this.snapshot.freshness === 'ready' &&
      !this.snapshot.busy &&
      !this.snapshot.loading &&
      !this.snapshot.pending;
    this.snapshot.canEdit = this.snapshot.interactive && this.snapshot.view?.editable === true;
    const view = this.snapshot.view;
    // A failed read stays visible, even over a context that was empty when last read.
    this.snapshot.hidden =
      (view?.hidden === true && this.snapshot.error === undefined) ||
      (this.snapshot.error !== undefined && this.deniedRead) ||
      (!view && this.snapshot.error === undefined && !this.snapshot.pending);
    this.snapshot.controls = Boolean(
      view && (view.editable || view.draft || view.actions.length > 0),
    );
    this.snapshot.unsupported = this.snapshot.freshness === 'unsupported';
    this.snapshot.canRetry = Boolean(
      !this.snapshot.busy &&
      this.snapshot.pending &&
      this.snapshot.freshness === 'ready' &&
      this.pendingConnectionKey === this.context.connectionKey,
    );
    this.snapshot.selectionRefusal =
      this.snapshot.view?.selectionErrors[0] ??
      (!this.context.target &&
      this.context.selections !== undefined &&
      this.snapshot.selections.length
        ? (this.snapshot.error ??
          (!this.snapshot.interactive
            ? 'Wait for source selection validation.'
            : !this.snapshot.view
              ? 'Source selection facts are unavailable.'
              : undefined))
        : undefined);
    for (const listener of this.listeners) listener();
    this.updateAgeTimer();
  }

  private observeQuery(): void {
    this.stopQuery?.();
    this.stopQuery = undefined;
    if (!this.cache) return;
    const params =
      this.context.params ?? sourceStatusParamsForTarget(undefined, this.context.target);
    this.stopQuery = this.cache.observe(sourceStatusQuery(params), (state) => {
      this.status = state.data;
      this.deniedRead = state.error?.code === 'AUTH_FORBIDDEN';
      this.update({
        freshness: state.status,
        observedAt: state.observedAt,
        loading: state.status === 'loading',
        error: state.error?.message,
      });
    });
  }

  dispose(): void {
    this.version++;
    this.stopQuery?.();
    this.stopQuery = undefined;
    this.cache = undefined;
    this.listeners.clear();
    this.updateAgeTimer();
  }

  setContext(context: SourceStatusViewContext): boolean {
    return this.bind(context, this.cache);
  }

  /** A retired cache must never observe a context from the replacement connection. */
  bind(context: SourceStatusViewContext, cache: GatewayResourceCache | undefined): boolean {
    const cacheChanged = cache !== this.cache;
    const contextChanged = JSON.stringify(context) !== JSON.stringify(this.context);
    this.cache = cache;
    if (!cacheChanged && !contextChanged) return false;
    if (
      !cacheChanged &&
      JSON.stringify({ ...context, selections: undefined }) ===
        JSON.stringify({ ...this.context, selections: undefined })
    ) {
      this.context = structuredClone(context);
      if (this.snapshot.busy && !this.snapshot.pending) this.version++;
      this.update({ selections: structuredClone([...(context.selections ?? [])]) });
      return false;
    }
    this.context = structuredClone(context);
    this.version++;
    this.status = undefined;
    // An uncertain mutation retains its exact old target/request even if the view changes.
    const canRetry = this.pendingConnectionKey === context.connectionKey;
    this.update({
      freshness: 'loading',
      observedAt: undefined,
      loading: false,
      view: undefined,
      error: undefined,
      operationError: undefined,
      notice: undefined,
      selections: structuredClone(
        contextChanged ? [...(context.selections ?? [])] : this.snapshot.selections,
      ),
      ...(this.snapshot.pending
        ? {
            canRetry,
            pendingLabel: canRetry
              ? commandLabel(this.snapshot.pending)
              : 'A source action belongs to the previous farm connection.',
          }
        : {}),
    });
    this.observeQuery();
    return true;
  }

  async refresh(): Promise<void> {
    const params =
      this.context.params ?? sourceStatusParamsForTarget(undefined, this.context.target);
    await this.cache?.retry(sourceStatusQuery(params));
  }

  select(selection: SourceSelection): void {
    if (!this.snapshot.canEdit) return;
    const selections = this.snapshot.selections.filter(
      (value) => value.sourceId !== selection.sourceId,
    );
    selections.push(structuredClone(selection));
    this.update({ selections });
  }

  clearSelection(sourceId: string): void {
    if (!this.snapshot.canEdit) return;
    this.update({
      selections: this.snapshot.selections.filter((selection) => selection.sourceId !== sourceId),
    });
  }

  async apply(action: SourceViewAction, sourceId?: string): Promise<void> {
    if (!this.snapshot.interactive || !this.snapshot.view?.actions.includes(action)) return;
    const version = this.version;
    this.update({ busy: true, error: undefined, operationError: undefined, notice: undefined });
    try {
      const target = this.context.target;
      let command: PreparedSourceCommand;
      if (action === 'sync')
        command = await this.client.prepareSync({
          ...(sourceId ? { sourceId } : {}),
          ...(target?.scope === 'node' ? { nodeId: target.targetId } : {}),
        });
      else {
        if (!target || !sourceId) throw new Error('Select a source and its scope.');
        if (action === 'unpin') command = await this.client.prepareUnpin({ sourceId, ...target });
        else {
          const selection = this.snapshot.selections.find((value) => value.sourceId === sourceId);
          command = await this.client.preparePin({
            sourceId,
            ...target,
            ref: selection?.ref ?? '',
          });
        }
      }
      if (version !== this.version)
        throw new Error(
          'Source view changed before sending. Review the current scope and try again.',
        );
      this.pendingConnectionKey = this.context.connectionKey;
      this.update({ pending: command, pendingLabel: commandLabel(command), canRetry: true });
      await this.submitPending();
    } catch (error) {
      // Preparation has no mutation effect; submitPending retains uncertain submitted requests.
      this.update({ busy: false, error: (error as Error).message });
    }
  }

  async retry(): Promise<void> {
    if (this.snapshot.busy || !this.snapshot.pending || this.snapshot.freshness !== 'ready') return;
    if (this.pendingConnectionKey !== this.context.connectionKey) {
      this.update({ error: 'Select the original farm connection to retry this source action.' });
      return;
    }
    await this.submitPending();
  }

  private async submitPending(): Promise<void> {
    const command = this.snapshot.pending;
    if (!command) return;
    this.update({ busy: true, error: undefined, operationError: undefined });
    try {
      const result = await this.client.execute(command);
      const errors = 'errors' in result ? result.errors : [];
      this.update({
        busy: false,
        pending: undefined,
        pendingLabel: undefined,
        canRetry: false,
        notice: `${commandLabel(command)} ${errors.length ? 'completed with errors' : 'applied'}.`,
        // Read refreshes report current facts separately from this operation's diagnostics.
        operationError: errors.length
          ? errors
              .map(
                (error) =>
                  `${[error.nodeId, error.sourceId, error.project].filter(Boolean).join(' / ') || 'Source'}: ${error.reason}`,
              )
              .join('\n')
          : undefined,
        selections: [],
      });
    } catch (error) {
      // A missing acknowledgement keeps the same operation ID, revisions and explicit target.
      const stale = (error as { code?: string }).code === 'SOURCE_STATE_STALE';
      this.update({
        busy: false,
        operationError: (error as Error).message,
        ...(stale ? { pending: undefined, pendingLabel: undefined, canRetry: false } : {}),
      });
    }
  }
}
