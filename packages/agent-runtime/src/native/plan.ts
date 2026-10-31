import type { NativePlanStep, NativeSessionPlan } from '@farmslot/protocol';

/**
 * A runner's working steps as a checklist. `textKey` names a step's text: Codex `step`, ACP
 * `content`. Codex reports `inProgress` and ACP `in_progress`; any other status is pending.
 */
export function nativeChecklist(
  steps: unknown,
  textKey: 'step' | 'content',
  note?: unknown,
): NativeSessionPlan {
  return {
    kind: 'checklist',
    steps: (Array.isArray(steps) ? steps : []).flatMap((step: unknown): NativePlanStep[] => {
      const value = step && typeof step === 'object' ? (step as Record<string, unknown>) : {};
      const text = value[textKey];
      if (typeof text !== 'string') return [];
      const status =
        value.status === 'completed'
          ? 'completed'
          : value.status === 'inProgress' || value.status === 'in_progress'
            ? 'in-progress'
            : 'pending';
      return [{ text, status }];
    }),
    ...(typeof note === 'string' && note ? { text: note } : {}),
  };
}
