import type { BacklogItem } from '@farmslot/protocol';

type DispatchConfigItem = Pick<
  BacklogItem,
  | 'allowedSlots'
  | 'autoDispatch'
  | 'devInteractiveProfile'
  | 'effort'
  | 'mode'
  | 'model'
  | 'pendingReviewPlan'
  | 'prepareProfile'
  | 'runner'
  | 'taskTemplate'
  | 'waitPolicy'
  | 'workGraphId'
>;

export interface DispatchConfigSummary {
  visible: boolean;
  execution: string;
  slots: string;
  rows: string[];
  chips: DispatchConfigSummaryChip[];
  meta: DispatchConfigSummaryMeta[];
  reviewSteps: DispatchConfigReviewStep[];
}

export type DispatchConfigSummaryTone = 'default' | 'positive' | 'warn' | 'accent';

export interface DispatchConfigSummaryChip {
  label: string;
  tone: DispatchConfigSummaryTone;
  title?: string;
}

export interface DispatchConfigSummaryMeta {
  label: string;
  value: string;
}

export interface DispatchConfigReviewStep {
  label: string;
  runner: string;
  detail: string;
}

export function dispatchTemplateLabel(item: DispatchConfigItem): string {
  if (!item.taskTemplate?.fileName) return 'default template';
  return item.taskTemplate.variant
    ? `${item.taskTemplate.fileName} (${item.taskTemplate.variant})`
    : item.taskTemplate.fileName;
}

export function dispatchReviewLabel(item: DispatchConfigItem): string {
  const plan = item.pendingReviewPlan ?? [];
  if (plan.length === 0) return '';
  return plan
    .map((loop) => [loop.runner, loop.model, loop.validationDepth].filter(Boolean).join('/'))
    .join(', ');
}

export function summarizeBacklogDispatchConfig(item: DispatchConfigItem): DispatchConfigSummary {
  const template = dispatchTemplateLabel(item);
  const reviews = dispatchReviewLabel(item);
  const mode = item.mode || 'default mode';
  const runner = item.runner || 'default runner';
  const model = item.model || 'default model';
  const effort = item.effort || 'default effort';
  const prepare = item.prepareProfile || 'project default';
  const execution = [mode, runner, model, effort].join(' / ');
  const slots = item.allowedSlots?.length ? item.allowedSlots.join(', ') : 'Any eligible slot';
  const rows = [
    `Template: ${template}`,
    `Execution: ${execution}`,
    `Prepare: ${prepare}`,
    `Slots: ${slots}`,
    item.devInteractiveProfile ? `Interactive profile: ${item.devInteractiveProfile}` : '',
    item.waitPolicy ? `Wait policy: ${item.waitPolicy}` : '',
    reviews ? `Publication reviews: ${reviews}` : '',
    item.workGraphId
      ? `Graph start: ${item.autoDispatch === false ? 'Manual start' : 'Auto start'}`
      : '',
  ].filter(Boolean);
  const chips: DispatchConfigSummaryChip[] = [
    {
      label: mode === 'interactive' ? 'interactive' : mode === 'autonomous' ? 'autonomous' : mode,
      tone: mode === 'interactive' ? 'accent' : mode === 'autonomous' ? 'positive' : 'default',
      title: 'Execution template mode',
    },
    {
      label: runner,
      tone: item.runner ? 'accent' : 'default',
      title: 'Runner',
    },
    {
      label: model,
      tone: item.model ? 'accent' : 'default',
      title: 'Model',
    },
    {
      label: effort,
      tone: item.effort ? 'accent' : 'default',
      title: 'Reasoning effort',
    },
  ];
  if (item.devInteractiveProfile) {
    chips.push({
      label: `profile: ${item.devInteractiveProfile}`,
      tone: 'accent',
      title: 'Interactive reply profile',
    });
  }
  if (item.waitPolicy) {
    chips.push({
      label: `wait: ${item.waitPolicy}`,
      tone: 'accent',
      title: 'Resource posture preset applied at every durable wait of the dispatched run',
    });
  }
  if (item.workGraphId) {
    chips.push({
      label: item.autoDispatch === false ? 'Manual start' : 'Auto start',
      tone: item.autoDispatch === false ? 'warn' : 'positive',
      title:
        item.autoDispatch === false
          ? 'When graph dependencies are ready, wait for you to press Dispatch.'
          : 'When graph dependencies are ready, the scheduler may enqueue this item.',
    });
  }
  const meta: DispatchConfigSummaryMeta[] = [
    { label: 'Template', value: template },
    { label: 'Prepare', value: prepare },
    { label: 'Slots', value: slots },
  ];
  if (reviews) meta.push({ label: 'Reviews', value: reviews });
  const reviewSteps: DispatchConfigReviewStep[] = (item.pendingReviewPlan ?? []).map(
    (loop, index) => {
      const runnerLabel = loop.runner || 'same';
      const detail = [loop.model, loop.validationDepth].filter(Boolean).join(' / ');
      return {
        label: `review ${index + 1}`,
        runner: runnerLabel,
        detail,
      };
    },
  );

  const visible = Boolean(
    item.workGraphId ||
    item.taskTemplate ||
    item.mode ||
    item.runner ||
    item.model ||
    item.effort ||
    item.prepareProfile ||
    item.allowedSlots?.length ||
    item.pendingReviewPlan?.length ||
    item.devInteractiveProfile ||
    item.waitPolicy,
  );

  return { visible, execution, slots, rows, chips, meta, reviewSteps };
}
