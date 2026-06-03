// methods/dispatch/task-flow-key.ts — Map task profile flow labels to project default keys.

export function flowTypeToKey(flowType: string): string {
  if (!flowType) return '';
  if (flowType.includes('review')) return 'review';
  if (flowType.includes('fix')) return 'fix';
  if (flowType.includes('dev')) return 'dev';
  return '';
}
