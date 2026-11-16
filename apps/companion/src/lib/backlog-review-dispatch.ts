import type {
  BacklogItem,
  FlowType,
  ProjectConfig,
  ReviewRequestContext,
  ReviewSelection,
} from '@farmslot/protocol';
import { resolveReviewDispatchDefaults, ReviewDispatchViewModel } from '@farmslot/review-dispatch';

type BacklogExecutionItem = Pick<BacklogItem, 'runner' | 'model' | 'effort' | 'reviewMode'>;
type BacklogExecutionProject = Pick<ProjectConfig, 'name' | 'defaults' | 'review'>;

export function backlogExecutionDefaults(
  project: BacklogExecutionProject | undefined,
  flow: FlowType,
  item?: BacklogExecutionItem,
): Partial<ReviewSelection> {
  return resolveReviewDispatchDefaults(project, flow, undefined, {
    runner: item?.runner,
    model: item?.model,
    effort: item?.effort,
    mode: item?.reviewMode,
  });
}

/** Primary backlog picker. Review-PR shows the review effort. Other flows stay on the worker default. */
export function backlogCreatePrimaryPicker(input: {
  project: BacklogExecutionProject | undefined;
  flowType: FlowType;
  item?: BacklogExecutionItem & { reviewContext?: ReviewRequestContext };
}): ReviewDispatchViewModel {
  const review = input.flowType === 'review-pr';
  return new ReviewDispatchViewModel({
    context: {
      allowedActions: ['configure'],
      defaults: backlogExecutionDefaults(input.project, input.flowType, input.item),
      allowSequence: false,
      allowFreshChain: review,
      reviewContext: review ? input.item?.reviewContext : undefined,
      effortRole: review ? 'review' : undefined,
    },
  });
}
