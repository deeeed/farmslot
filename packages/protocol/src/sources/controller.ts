import type { SourcesStatusResult } from '../rpc/sources.js';

import {
  isNewerSourceRevision,
  type SourceChangeFeed,
  type SourceRevisionMark,
} from './changes.js';
import {
  type PreparedSourceCommand,
  type SourceCommandClient,
  sourceStatusParamsForTarget,
} from './client.js';
import type { SourceSelection } from './pins.js';
import {
  deriveSourceStatusView,
  type SourceStatusViewContext,
  type SourceStatusViewModel,
  type SourceViewAction,
} from './status-view.js';

export interface SourceStatusSnapshot {
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
  private feed?: SourceChangeFeed;
  private covered?: SourceRevisionMark;
  /** The version of the read in flight; a context change abandons it. */
  private readingVersion?: number;
  private rereadAfterRead = false;
  private deniedRead = false;

  constructor(
    private readonly client: SourceCommandClient,
    context: SourceStatusViewContext,
  ) {
    this.context = structuredClone(context);
    this.snapshot = {
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
  }

  getSnapshot = (): SourceStatusSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private update(change: Partial<SourceStatusSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...change };
    if (this.status)
      this.snapshot.view = deriveSourceStatusView(this.status, {
        ...this.context,
        ...(this.context.selections !== undefined || this.snapshot.selections.length
          ? { selections: this.snapshot.selections }
          : {}),
      });
    this.snapshot.interactive =
      !this.snapshot.busy && !this.snapshot.loading && !this.snapshot.pending;
    this.snapshot.canEdit = this.snapshot.interactive && this.snapshot.view?.editable === true;
    const view = this.snapshot.view;
    this.snapshot.hidden =
      view?.hidden === true ||
      (this.snapshot.error !== undefined && this.deniedRead) ||
      (!view && this.snapshot.error === undefined && !this.snapshot.pending);
    this.snapshot.controls = Boolean(
      view && (view.editable || view.draft || view.actions.length > 0),
    );
    this.snapshot.unsupported =
      this.status?.configured === true && this.feed?.getState().announced === false;
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
  }

  /**
   * Live source status (ADR-069 Amendment 1): reread when the gateway's source
   * revision passes what the last read covered. Reconnects stay with the host,
   * which already rereads on every new connection.
   */
  attachFeed(feed: SourceChangeFeed): () => void {
    this.feed = feed;
    const unsubscribe = feed.subscribe(() => this.observeFeed());
    this.observeFeed();
    return () => {
      unsubscribe();
      if (this.feed === feed) this.feed = undefined;
    };
  }

  private observeFeed(): void {
    const latest = this.feed?.getState().latest;
    if (latest && isNewerSourceRevision(latest, this.covered)) {
      // A change during any read, the first included, is not covered by it.
      if (this.readingVersion === this.version) {
        this.rereadAfterRead = true;
        return;
      }
      // Before the first read the host's initial load covers the current state.
      if (this.status || this.snapshot.error) {
        void this.refresh();
        return;
      }
    }
    this.update({});
  }

  setContext(context: SourceStatusViewContext): boolean {
    if (JSON.stringify(context) === JSON.stringify(this.context)) return false;
    if (
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
      loading: false,
      view: undefined,
      error: undefined,
      operationError: undefined,
      notice: undefined,
      selections: structuredClone([...(context.selections ?? [])]),
      ...(this.snapshot.pending
        ? {
            canRetry,
            pendingLabel: canRetry
              ? commandLabel(this.snapshot.pending)
              : 'A source action belongs to the previous farm connection.',
          }
        : {}),
    });
    return true;
  }

  async refresh(): Promise<void> {
    const version = ++this.version;
    const params =
      this.context.params ?? sourceStatusParamsForTarget(undefined, this.context.target);
    // Gateways publish only after a change is readable, so this read covers the mark.
    this.covered = this.feed?.getState().latest;
    this.readingVersion = version;
    this.rereadAfterRead = false;
    this.update({ loading: true, error: undefined });
    try {
      const status = await this.client.status(params);
      if (version !== this.version) return;
      this.status = status;
      this.deniedRead = false;
      this.update({ loading: false });
    } catch (error) {
      // Read failures remain visible; stale responses cannot replace another context's facts.
      if (version === this.version) {
        this.deniedRead = (error as { code?: string }).code === 'AUTH_FORBIDDEN';
        this.update({ loading: false, error: (error as Error).message });
      }
    } finally {
      if (version === this.version) {
        this.readingVersion = undefined;
        // A change seen during the read is not covered by it: read once more.
        if (this.rereadAfterRead) {
          this.rereadAfterRead = false;
          void this.refresh();
        }
      }
    }
  }

  select(selection: SourceSelection): void {
    if (!this.snapshot.view?.editable || this.snapshot.busy || this.snapshot.pending) return;
    const selections = this.snapshot.selections.filter(
      (value) => value.sourceId !== selection.sourceId,
    );
    selections.push(structuredClone(selection));
    this.update({ selections });
  }

  clearSelection(sourceId: string): void {
    if (!this.snapshot.view?.editable || this.snapshot.busy || this.snapshot.pending) return;
    this.update({
      selections: this.snapshot.selections.filter((selection) => selection.sourceId !== sourceId),
    });
  }

  async apply(action: SourceViewAction, sourceId?: string): Promise<void> {
    if (
      this.snapshot.busy ||
      this.snapshot.pending ||
      !this.snapshot.view?.actions.includes(action)
    )
      return;
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
    if (this.snapshot.busy || !this.snapshot.pending) return;
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
      await this.refresh();
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
