import {
  DEFAULT_REVIEW_MODE,
  DEFAULT_RUNNER,
  type ReviewContinuationContext,
  type ReviewMode,
  type ReviewRequestContext,
  type ReviewRequestPayload,
  type ReviewSelection,
  type ReviewSequence,
} from '@farmslot/protocol';

import {
  DEFAULT_REVIEW_DISPATCH_CATALOG,
  effortsForRunner,
  modelsForRunner,
  runnerOption,
} from './catalog.js';
import { copyExecutionResources } from './execution.js';
import { assertWarmReviewContext } from './provenance.js';
import { sequenceMaximumRows } from './row-limit.js';
import type {
  ReviewDispatchAction,
  ReviewDispatchCatalog,
  ReviewDispatchContext,
  ReviewDispatchEffortChoice,
  ReviewDispatchExecutionResources,
  ReviewDispatchModelOption,
  ReviewDispatchRow,
  ReviewDispatchState,
  ReviewDispatchViewModelOptions,
} from './types.js';
import {
  assertReviewContinuationContext,
  assertReviewRequestContext,
  assertReviewSequence,
  parseReviewSelection,
  parseReviewSequence,
  reviewRequestFromSequence,
} from './validation.js';

/** Platform-neutral picker state. Hosts render and invoke actions; this model owns selections. */
export class ReviewDispatchViewModel {
  private currentContext: ReviewDispatchContext;
  private currentRows: ReviewDispatchRow[] = [];
  private nextId = 1;
  private readonly listeners = new Set<() => void>();

  constructor(options: ReviewDispatchViewModelOptions) {
    this.currentContext = this.checkContext({
      ...options.context,
      ...(options.catalog ? { catalog: options.catalog } : {}),
    });
    if (options.sequence !== undefined) this.setSequence(options.sequence);
    else while (this.currentRows.length < this.minRows) this.addRow();
  }

  get context(): Readonly<ReviewDispatchContext> {
    return this.currentContext;
  }
  get catalog(): ReviewDispatchCatalog {
    return this.currentContext.catalog ?? DEFAULT_REVIEW_DISPATCH_CATALOG;
  }
  get runnerChoices(): ReviewDispatchCatalog {
    return this.catalog;
  }
  get rows(): readonly ReviewDispatchRow[] {
    return this.currentRows;
  }
  get selection(): Readonly<ReviewSelection> | undefined {
    return this.currentRows[0]?.selection;
  }
  canInvoke(action: ReviewDispatchAction): boolean {
    return (
      this.currentContext.allowedActions.includes(action) &&
      this.valid &&
      (action !== 'request-review' || this.currentRows.length > 0)
    );
  }
  get canAddRow(): boolean {
    return this.currentRows.length < this.maxRows;
  }
  get canRemoveRow(): boolean {
    return this.currentRows.length > this.minRows;
  }
  get errors(): readonly string[] {
    try {
      this.assertRows(this.currentRows.map((row) => row.selection));
      return [];
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return [error.message];
    }
  }
  get valid(): boolean {
    return this.errors.length === 0;
  }
  get state(): ReviewDispatchState {
    return {
      rows: this.rows,
      errors: this.errors,
      canAddRow: this.canAddRow,
      canRemoveRow: this.canRemoveRow,
    };
  }
  private get minRows(): number {
    return this.currentContext.minRows ?? (this.currentContext.allowEmpty ? 0 : 1);
  }
  private get maxRows(): number {
    return sequenceMaximumRows({
      ...this.currentContext,
      allowSequence: Boolean(this.currentContext.allowSequence),
    });
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private changed(): void {
    this.listeners.forEach((listener) => listener());
  }
  private checkContext(context: ReviewDispatchContext): ReviewDispatchContext {
    const min = context.minRows ?? (context.allowEmpty ? 0 : 1);
    const max = sequenceMaximumRows({ ...context, allowSequence: Boolean(context.allowSequence) });
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min < 0 || max < 1 || min > max)
      throw new Error('Review picker row limits are invalid');
    if (context.workflow === 'qa' && context.allowedActions.includes('request-review'))
      throw new Error('QA context cannot request a static review');
    if (context.reviewContext) assertReviewRequestContext(context.reviewContext);
    context.reviewLineages?.forEach(assertReviewContinuationContext);
    if (!context.allowedActions.length) throw new Error('Review picker requires an allowed action');
    return { ...context, defaults: context.defaults ? { ...context.defaults } : undefined };
  }
  private assertRows(sequence: readonly Readonly<ReviewSelection>[]): void {
    assertReviewSequence(sequence, {
      ...this.currentContext,
      catalog: this.catalog,
      maxRows: this.maxRows,
    });
    if (this.currentContext.workflow !== 'qa')
      assertWarmReviewContext(
        [...sequence],
        this.toReviewContext(),
        this.currentContext.sequenceRole,
      );
    if (sequence.length < this.minRows)
      throw new Error(`Review picker requires at least ${this.minRows} rows`);
  }
  private defaultSelection(patch: Partial<ReviewSelection> = {}): ReviewSelection {
    const values = { ...this.currentContext.defaults, ...patch };
    const runner =
      values.runner ??
      this.catalog.runners.find((entry) => entry.id === DEFAULT_RUNNER)?.id ??
      this.catalog.runners[0]?.id;
    if (!runner) throw new Error('Review picker has no supported runners');
    runnerOption(runner, this.catalog);
    return parseReviewSelection(
      {
        runner,
        model: values.model ?? null,
        effort: values.effort ?? null,
        mode:
          values.mode === 'warm' &&
          patch.mode === undefined &&
          !this.contextForRow(this.currentRows.length)
            ? DEFAULT_REVIEW_MODE
            : (values.mode ?? DEFAULT_REVIEW_MODE),
      },
      { catalog: this.catalog },
    );
  }
  private contextForRow(index: number): ReviewContinuationContext | null {
    const explicit = this.currentContext.reviewContext?.reviewLineages[index];
    if (
      this.currentContext.reviewContext &&
      index < this.currentContext.reviewContext.reviewLineages.length
    )
      return explicit ? { ...explicit } : null;
    const available = this.currentContext.reviewLineages;
    return (index === 0 || this.currentContext.sequenceRole === 'execution-alternatives') &&
      available?.length === 1
      ? { ...available[0] }
      : null;
  }
  private row(id: number): ReviewDispatchRow {
    const row = this.currentRows.find((entry) => entry.id === id);
    if (!row) throw new Error(`Unknown review picker row: ${id}`);
    return row;
  }

  setCatalog(catalog: ReviewDispatchCatalog): void {
    this.currentContext = this.checkContext({ ...this.currentContext, catalog });
    this.changed();
  }
  setContext(context: ReviewDispatchContext): void {
    this.currentContext = this.checkContext(context);
    this.currentRows = this.currentRows.map((row, index) => ({
      ...row,
      context: this.contextForRow(index),
    }));
    this.changed();
  }
  setSequence(sequence: ReviewSequence): void {
    const selections = parseReviewSequence(sequence, {
      ...this.currentContext,
      catalog: this.catalog,
      maxRows: this.maxRows,
    });
    if (selections.length < this.minRows)
      throw new Error(`Review picker requires at least ${this.minRows} rows`);
    this.currentRows = selections.map((selection, index) => ({
      id: this.nextId++,
      selection,
      context: this.contextForRow(index),
    }));
    this.changed();
  }
  addRow(selection: Partial<ReviewSelection> = {}): void {
    if (!this.canAddRow) throw new Error(`Review picker permits at most ${this.maxRows} rows`);
    const row = {
      id: this.nextId++,
      selection: this.defaultSelection(selection),
      context: this.contextForRow(this.currentRows.length),
    };
    this.currentRows = [...this.currentRows, row];
    this.changed();
  }
  removeRow(id: number): void {
    this.row(id);
    if (!this.canRemoveRow) throw new Error(`Review picker requires at least ${this.minRows} rows`);
    this.currentRows = this.currentRows.filter((row) => row.id !== id);
    this.changed();
  }
  moveRow(id: number, toIndex: number): void {
    const row = this.row(id);
    if (!Number.isSafeInteger(toIndex) || toIndex < 0 || toIndex >= this.currentRows.length)
      throw new Error('Review picker row position is invalid');
    const next = this.currentRows.filter((entry) => entry.id !== id);
    next.splice(toIndex, 0, row);
    this.currentRows = next;
    this.changed();
  }
  updateRow(id: number, patch: Partial<ReviewSelection>): void {
    const current = this.row(id).selection;
    let selection = { ...current, ...patch };
    if (patch.runner !== undefined && patch.runner !== current.runner) {
      runnerOption(patch.runner, this.catalog);
      if (patch.model === undefined) selection.model = null;
      if (patch.effort === undefined) selection.effort = null;
    } else if (
      patch.model !== undefined &&
      patch.effort === undefined &&
      selection.effort !== null &&
      !effortsForRunner(selection.runner, selection.model, this.catalog).includes(selection.effort)
    ) {
      selection.effort = null;
    }
    selection = parseReviewSelection(selection, { catalog: this.catalog });
    this.currentRows = this.currentRows.map((row) => (row.id === id ? { ...row, selection } : row));
    this.changed();
  }
  setRunner(id: number, runner: string): void {
    this.updateRow(id, { runner });
  }
  setModel(id: number, model: string | null): void {
    this.updateRow(id, { model });
  }
  setEffort(id: number, effort: string | null): void {
    this.updateRow(id, { effort });
  }
  setMode(id: number, mode: ReviewMode): void {
    this.updateRow(id, { mode });
  }
  modelChoices(id: number): ReviewDispatchModelOption[] {
    const selection = this.row(id).selection;
    const runner = this.catalog.runners.find((option) => option.id === selection.runner);
    if (!runner) return selection.model ? [{ id: selection.model }] : [];
    return modelsForRunner(selection.runner, selection.model, this.catalog).map(
      (id) => runner.models.find((model) => model.id === id) ?? { id },
    );
  }
  effortChoices(id: number): ReviewDispatchEffortChoice[] {
    const selection = this.row(id).selection;
    const runner = this.catalog.runners.find((option) => option.id === selection.runner);
    if (!runner) return [{ value: null, label: 'Unavailable runner default' }];
    return [
      {
        value: null,
        label: runner.defaultEffort
          ? `Runner default · ${runner.defaultEffort}`
          : 'Supported default',
      },
      ...effortsForRunner(selection.runner, selection.model, this.catalog).map((value) => ({
        value,
        label: value,
      })),
    ];
  }
  toSequence(): ReviewSequence {
    this.assertRows(this.currentRows.map((row) => row.selection));
    return parseReviewSequence(
      this.currentRows.map((row) => row.selection),
      { ...this.currentContext, catalog: this.catalog },
    );
  }
  setReviewContext(id: number, context: ReviewContinuationContext | null): void {
    this.row(id);
    if (context) assertReviewContinuationContext(context);
    this.currentRows = this.currentRows.map((row) =>
      row.id === id ? { ...row, context: context ? { ...context } : null } : row,
    );
    this.changed();
  }
  toReviewContext(): ReviewRequestContext | undefined {
    if (this.currentContext.workflow === 'qa') return undefined;
    const reviewLineages = this.currentRows.map((row) =>
      row.selection.mode === 'warm' && row.context ? { ...row.context } : null,
    );
    return reviewLineages.some(Boolean) ? { reviewLineages } : undefined;
  }
  toRequestPayload(): ReviewRequestPayload {
    if (!this.currentContext.allowedActions.includes('request-review'))
      throw new Error('Review requests are unavailable in this context');
    return reviewRequestFromSequence(
      this.toSequence(),
      {
        ...this.currentContext,
        catalog: this.catalog,
      },
      this.toReviewContext(),
    );
  }
  toDispatchOptions(): {
    reviewSequence: ReviewSequence;
    reviewPolicy?: import('@farmslot/protocol').ReviewPolicy;
    reviewSequenceContext?: ReviewRequestContext;
  } {
    if (
      !this.currentContext.allowedActions.some(
        (action) => action === 'dispatch' || action === 'configure',
      )
    )
      throw new Error('Dispatch configuration is unavailable in this context');
    const reviewSequence = parseReviewSequence(this.toSequence(), {
      ...this.currentContext,
      catalog: this.catalog,
      sequenceRole: 'reviews',
    });
    return {
      reviewSequence,
      ...(this.toReviewContext() ? { reviewSequenceContext: this.toReviewContext() } : {}),
      ...(reviewSequence.length
        ? {
            reviewPolicy: {
              minimumReviews: reviewSequence.length,
              requestedBy: 'dispatch' as const,
            },
          }
        : {}),
    };
  }
  toExecutionModels(
    resources?: ReadonlyMap<number, ReviewDispatchExecutionResources>,
  ): import('@farmslot/protocol').PRExecutionModel[] {
    const sequence = this.toSequence();
    return sequence.map((selection, index) => ({
      ...selection,
      ...copyExecutionResources(resources?.get(this.currentRows[index].id)),
    }));
  }
  toSelection(): ReviewSelection {
    const sequence = this.toSequence();
    if (sequence.length !== 1) throw new Error('Execution requires one selection');
    return sequence[0];
  }
}
