import {
  HISTOGRAM_METRICS,
  PERFORMANCE_BUDGETS,
  type PerformanceBudgetVerdict,
  type PerformanceHistogram,
  type PerformanceSnapshot,
} from './types.js';

/** UI estimate only. Budget verdicts use the exact threshold bucket. */
export function histogramPercentile(histogram: PerformanceHistogram, quantile: number): number {
  if (!histogram.count) return 0;
  const index = histogram.buckets.findIndex(
    (count) => count >= Math.ceil(histogram.count * quantile),
  );
  return HISTOGRAM_METRICS[histogram.name][index] ?? histogram.max;
}
export function performanceBudgetVerdicts(
  snapshot: PerformanceSnapshot,
): PerformanceBudgetVerdict[] {
  return snapshot.histograms.flatMap((histogram) => {
    const actionClass = histogram.labels.action_class;
    if (
      !actionClass ||
      histogram.name.endsWith('_bytes') ||
      histogram.name.endsWith('_age_seconds')
    )
      return [];
    const budgetSeconds = PERFORMANCE_BUDGETS[actionClass];
    const index = HISTOGRAM_METRICS[histogram.name].findIndex((value) => value === budgetSeconds);
    const withinBudget = histogram.buckets[index] ?? 0;
    return [
      {
        metric: histogram.name,
        cacheSource: histogram.labels.cache_source,
        method: histogram.labels.method,
        actionClass,
        source: histogram.labels.side ?? 'unknown',
        count: histogram.count,
        withinBudget,
        budgetSeconds,
        status:
          histogram.count < 20 || snapshot.dropped > 0
            ? 'unmeasured'
            : withinBudget * 20 >= histogram.count * 19
              ? 'pass'
              : 'fail',
      },
    ];
  });
}
