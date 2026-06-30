import type { FlowType } from '../contracts/runs.js';
import type { WorkerTemplateOption } from '../contracts/config.js';

export type DispatchRunMode = 'interactive' | 'autonomous';
export type RunCreateMode = DispatchRunMode | 'validation';

/** Default worker template basename per flow — matches gateway FLOW_TO_TEMPLATE. */
export const DEFAULT_WORKER_TEMPLATE_BY_FLOW: Record<string, string> = {
  'fix-bug': 'fix-bug.md',
  'review-pr': 'review-pr.md',
  dev: 'dev.md',
  'pr-complete': 'pr-complete.md',
  'merge-main': 'merge-main.md',
};

export function defaultWorkerTemplateFileName(flowType: FlowType | string): string {
  return DEFAULT_WORKER_TEMPLATE_BY_FLOW[flowType] ?? `${flowType}.md`;
}

/**
 * Baseline mode when no template-aware override applies (ADR-018).
 * `dev`, `review-pr`, and `merge-main` fall through to interactive — the
 * dispatch wizard promotes them to autonomous only when an interactive
 * sibling template exists (see selectedTemplateMode).
 */
export function modeForFlow(flowType: FlowType): DispatchRunMode {
  if (flowType === 'pr-complete') return 'autonomous';
  return flowType === 'fix-bug' ? 'autonomous' : 'interactive';
}

export function interactiveWorkerTemplateOption(
  options: ReadonlyArray<WorkerTemplateOption>,
): WorkerTemplateOption | undefined {
  return options.find(
    (option) => option.variant === 'interactive' || /-interactive\.md$/.test(option.fileName),
  );
}

/**
 * Derive run mode from flow + selected worker template — same rules as dispatch wizard.
 * Default `dev.md` is autonomous when an interactive sibling template exists.
 */
export function selectedTemplateMode(
  flowType: FlowType | null,
  options: ReadonlyArray<WorkerTemplateOption>,
  selectedFileName: string,
): DispatchRunMode {
  if (!flowType) return 'interactive';
  const selected = options.find((option) => option.fileName === selectedFileName);
  if (selected?.variant === 'interactive' || /-interactive\.md$/.test(selected?.fileName ?? '')) {
    return 'interactive';
  }
  if (selected?.isDefault && interactiveWorkerTemplateOption(options)) return 'autonomous';
  return modeForFlow(flowType);
}

export function resolveRunCreateMode(input: {
  flowType: FlowType;
  mode?: RunCreateMode | null;
  taskTemplateFileName?: string | null;
  templateOptions?: ReadonlyArray<WorkerTemplateOption>;
}): RunCreateMode {
  if (
    input.mode === 'interactive' ||
    input.mode === 'autonomous' ||
    input.mode === 'validation'
  ) {
    return input.mode;
  }
  const selectedFileName =
    input.taskTemplateFileName ??
    input.templateOptions?.find((option) => option.isDefault)?.fileName ??
    defaultWorkerTemplateFileName(input.flowType);
  if (input.templateOptions?.length) {
    return selectedTemplateMode(input.flowType, input.templateOptions, selectedFileName);
  }
  return modeForFlow(input.flowType);
}
