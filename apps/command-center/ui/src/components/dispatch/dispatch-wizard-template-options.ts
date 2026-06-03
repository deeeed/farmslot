import type { FlowType, WorkerTemplateOption } from '@farmslot/protocol';

export interface TemplateOptionsState {
  options: WorkerTemplateOption[];
  error: string;
  selectedFileName: string;
}

export function templateOptionsRequestKey(project: string, flowType: FlowType): string {
  return `${project}:${flowType}`;
}

export function clearTemplateOptionsState(): TemplateOptionsState {
  return { options: [], error: '', selectedFileName: '' };
}

export function deriveTemplateOptionsState(
  options: WorkerTemplateOption[],
  selectedFileName: string,
): TemplateOptionsState {
  const currentStillValid = options.some((option) => option.fileName === selectedFileName);
  if (currentStillValid) {
    return { options, error: '', selectedFileName };
  }
  return {
    options,
    error: '',
    selectedFileName:
      options.find((option) => option.isDefault)?.fileName ?? options[0]?.fileName ?? '',
  };
}
