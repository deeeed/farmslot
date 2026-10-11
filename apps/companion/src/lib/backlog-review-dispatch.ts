import type { BacklogItem, FlowType, ProjectConfig, ReviewSelection } from '@farmslot/protocol';
import { resolveReviewDispatchDefaults } from '@farmslot/review-dispatch';

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
