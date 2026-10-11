import { useEffect, useRef, useState } from 'react';

import {
  type PRExecutionProfile,
  type ReviewContinuationContext,
  type ReviewMode,
  type ReviewRequestContext,
  samePRReviewOptions,
} from '@farmslot/protocol';
import {
  type ReviewDispatchExecutionResources,
  ReviewDispatchViewModel,
  reviewSequenceForExecution,
} from '@farmslot/review-dispatch';

export function usePRExecutionPicker(
  value: PRExecutionProfile,
  onChange: (value: PRExecutionProfile) => void,
  reviewMode?: ReviewMode,
  onReviewModeChange?: (mode: ReviewMode, context: ReviewRequestContext | undefined) => void,
  onPickerReady?: (picker: ReviewDispatchViewModel | undefined) => void,
  reviewContext?: ReviewRequestContext,
  reviewLineages?: readonly ReviewContinuationContext[],
  workflow?: 'review' | 'qa',
) {
  const [picker] = useState(
    () =>
      new ReviewDispatchViewModel({
        context: {
          allowedActions: ['configure'],
          allowSequence: true,
          sequenceRole: 'execution-alternatives',
          workflow,
          reviewContext,
          reviewLineages,
        },
        sequence: reviewSequenceForExecution(value.models, reviewMode),
      }),
  );
  useEffect(() => {
    onPickerReady?.(picker);
    return () => onPickerReady?.(undefined);
  }, [onPickerReady, picker]);
  const pendingEdit = useRef(false);
  const previousContext = useRef(reviewContext);
  const previousLineages = useRef(reviewLineages);
  useEffect(() => {
    if (
      previousContext.current === reviewContext &&
      previousLineages.current === reviewLineages &&
      picker.context.workflow === workflow
    )
      return;
    picker.setContext({ ...picker.context, reviewContext, reviewLineages, workflow });
    previousContext.current = reviewContext;
    previousLineages.current = reviewLineages;
  }, [picker, reviewContext, reviewLineages, workflow]);
  const resources = useRef(new Map<number, ReviewDispatchExecutionResources>());
  const previousModels = useRef(value.models);
  const previousMode = useRef(reviewMode);
  const bindResources = () => {
    resources.current.clear();
    picker.rows.forEach((row, index) => {
      const model = value.models[index];
      resources.current.set(row.id, {
        ...(model?.allowedSlots ? { allowedSlots: model.allowedSlots } : {}),
        ...(model?.allowedMachines ? { allowedMachines: model.allowedMachines } : {}),
      });
    });
  };
  const initialized = useRef(false);
  if (!initialized.current) {
    bindResources();
    initialized.current = true;
  }

  useEffect(() => {
    if (previousModels.current === value.models && previousMode.current === reviewMode) return;
    picker.setSequence(reviewSequenceForExecution(value.models, reviewMode, picker.catalog));
    previousModels.current = value.models;
    previousMode.current = reviewMode;
    bindResources();
  }, [picker, value.models, reviewMode]);

  const changed = () => {
    pendingEdit.current = true;
    const models = picker.toExecutionModels(resources.current);
    const mode = picker.rows[0].selection.mode;
    previousModels.current = models;
    previousMode.current = reviewMode === undefined ? undefined : mode;
    const context = picker.toReviewContext();
    previousContext.current = context;
    onChange({ ...value, models });
    if (
      reviewMode !== undefined &&
      !samePRReviewOptions({ mode: reviewMode, reviewContext }, { mode, reviewContext: context })
    )
      onReviewModeChange?.(mode, context);
    pendingEdit.current = false;
  };
  const changedRef = useRef(changed);
  changedRef.current = changed;
  useEffect(
    () =>
      picker.subscribe(() => {
        if (pendingEdit.current && picker.canInvoke('configure')) changedRef.current();
      }),
    [picker],
  );
  return { picker, resources: resources.current, changed };
}
