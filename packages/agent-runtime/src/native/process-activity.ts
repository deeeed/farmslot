import type {
  ProcessEventRef,
  ProcessLabel,
  ProcessProductEdit,
  RunProcessActivity,
} from '@farmslot/protocol';

export interface ProcessActivityFacts extends Omit<
  RunProcessActivity,
  'schemaVersion' | 'labels' | 'firstProductEdit'
> {
  productEdits: ProcessProductEdit[] | null;
}

const time = (value: string): number | undefined => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/** Presence only: instructions or quoted headings elsewhere are not the worker's section. */
export function hasProcessRootCause(markdown: string): boolean {
  let fence = '',
    section = false;
  for (const line of markdown.split('\n')) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = '';
      continue;
    }
    if (!fence && /^##\s+Root Cause\s*$/i.test(line)) {
      section = true;
      continue;
    }
    if (!fence && section && /^#{1,2}\s+/.test(line)) return false;
    if (section && line.trim() && !/^#{3,6}\s+/.test(line)) return true;
  }
  return false;
}

/** Derive advisory labels once, from the frozen facts shared by every consumer. */
export function deriveProcessActivity(facts: ProcessActivityFacts): RunProcessActivity {
  const { productEdits, ...captured } = facts;
  const observed = (productEdits ?? [])
    .filter((edit) => edit.status === 'observed' && edit.classification === 'product')
    .filter((edit) => time(edit.at) !== undefined)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const firstProductEdit =
    observed[0] ??
    productEdits?.find((edit) => edit.classification !== 'diagnostic-marker') ??
    null;
  const unknown = (reason: string): ProcessLabel => ({ value: null, reason, references: [] });
  const label = (value: boolean, reason: string, references: ProcessEventRef[]): ProcessLabel => ({
    value,
    reason,
    references,
  });
  const comparable = (left: ProcessEventRef, right: ProcessEventRef): boolean => {
    const a = facts.sources.find((source) => source.id === left.sourceId);
    const b = facts.sources.find((source) => source.id === right.sourceId);
    return Boolean(
      a?.executionNodeId &&
      a.executionNodeId === b?.executionNodeId &&
      a.clockId &&
      a.clockId === b.clockId,
    );
  };
  const ticks = facts.checklist.events;
  const firstTick = ticks?.reduce<number | undefined>((first, event) => {
    const at = time(event.checkedAt);
    return at === undefined ? first : first === undefined ? at : Math.min(first, at);
  }, undefined);
  const checklistSource = facts.checklist.source;
  const completed = (edit: ProcessProductEdit): number | undefined => {
    const end = edit.completedAt ? time(edit.completedAt) : undefined;
    return end !== undefined && end >= Date.parse(edit.at) ? end : undefined;
  };
  const editBeforeFirstTick =
    checklistSource &&
    observed.find(
      (edit) =>
        comparable(edit.source, checklistSource) &&
        completed(edit) !== undefined &&
        (firstTick === undefined || completed(edit)! < firstTick),
    );
  const firstCompleted = observed.find((edit) => completed(edit) !== undefined);
  let skipped = unknown('Checklist coverage or comparable worker chronology is unavailable');
  if (facts.coverage.checklist.status === 'complete' && ticks) {
    if (
      !ticks.length &&
      (facts.checklist.expectedSteps ?? 0) > 0 &&
      (facts.checklist.workerStatus === 'complete' || facts.checklist.workerStatus === 'done')
    ) {
      skipped = label(
        true,
        'The frozen worker checklist has no ticks',
        facts.checklist.source ? [facts.checklist.source] : [],
      );
    } else if (checklistSource && editBeforeFirstTick) {
      skipped = label(true, 'A product edit was observed before the first checklist tick', [
        editBeforeFirstTick.source,
        checklistSource,
      ]);
    } else if (
      facts.checklist.complete &&
      facts.coverage.productEdits.status === 'complete' &&
      observed.length &&
      facts.checklist.source &&
      firstTick !== undefined &&
      comparable(observed[0].source, facts.checklist.source) &&
      Date.parse(observed[0].at) > firstTick
    ) {
      skipped = label(
        false,
        'The captured checklist is complete and marking preceded the first observed product edit',
        [facts.checklist.source, observed[0].source],
      );
    }
  }
  const baseline = facts.firstBaselineRun;
  let before = unknown('Baseline or attributable product-edit chronology is unavailable');
  if (
    baseline &&
    time(baseline.at) !== undefined &&
    facts.coverage.baseline.status === 'complete'
  ) {
    const edit = observed.find(
      (item) =>
        comparable(item.source, baseline.source) &&
        completed(item) !== undefined &&
        completed(item)! < Date.parse(baseline.at),
    );
    if (edit) {
      before = label(
        true,
        'A non-marker product edit completed before the first task-declared recorded baseline',
        [edit.source, ...(edit.resultSource ? [edit.resultSource] : []), baseline.source],
      );
    } else if (
      observed.length &&
      facts.coverage.productEdits.status === 'complete' &&
      observed.every(
        (item) =>
          comparable(item.source, baseline.source) && Date.parse(item.at) > Date.parse(baseline.at),
      )
    ) {
      before = label(false, 'The observed product edits started after the recorded baseline', [
        baseline.source,
        observed[0].source,
      ]);
    }
  } else if (
    facts.coverage.baseline.status === 'complete' &&
    observed.length &&
    facts.firstBaselineRun === null &&
    firstCompleted
  ) {
    before = label(
      true,
      'A non-marker product edit was observed with complete capture and no baseline',
      [
        firstCompleted.source,
        ...(firstCompleted.resultSource ? [firstCompleted.resultSource] : []),
      ],
    );
  }
  return {
    ...captured,
    schemaVersion: 1,
    firstProductEdit,
    labels: { skipped_checklist: skipped, fix_before_baseline: before },
  };
}
