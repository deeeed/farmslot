/** The runner adapter's decision on the serialized request, independent of the launch choice. */
export type EffectiveReasoning =
  | { mode: 'omitted' }
  | { mode: 'disabled' }
  | { mode: 'level'; level: string };

/** A request receipt belongs to one saved conversation and selected model. */
export interface RunnerReasoningReceipt {
  sessionId: string;
  provider: string;
  model: string;
  /** Launch model spelling validated by the adapter, including any runner-owned suffix. */
  selectedModel: string;
  observedAt: string;
  /** Gateway attempt bound when the launch receipt was captured. */
  attemptStartedAt?: string;
  reasoning: EffectiveReasoning;
}

export function isEffectiveReasoning(value: unknown): value is EffectiveReasoning {
  if (!value || typeof value !== 'object' || !('mode' in value)) return false;
  return (
    value.mode === 'omitted' ||
    value.mode === 'disabled' ||
    (value.mode === 'level' &&
      'level' in value &&
      typeof value.level === 'string' &&
      value.level.trim().length > 0)
  );
}
