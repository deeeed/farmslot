/** Reject removed contracts before records can silently lose their review configuration. */
export function assertCurrentReviewConfiguration(value: unknown, label: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  for (const key of [
    'reviewDepth',
    'pendingReviewPlan',
    'reviews',
    'reviewScope',
    'crossRunner',
    'requireCrossRunner',
    'reviewSessionPolicy',
    'reviewSessionIntent',
  ]) {
    if (Object.hasOwn(record, key))
      throw new Error(
        `${label}.${key} was removed. Convert stored review configuration to reviewPolicy, reviewSequence and WARM/COLD mode before retrying.`,
      );
  }
}
