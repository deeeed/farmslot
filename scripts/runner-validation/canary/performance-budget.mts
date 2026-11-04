import {
  performanceBudgetVerdicts,
  type PerformanceSnapshot,
} from '../../../packages/protocol/src/performance/index.js';
export function judgePerformanceWorkload(snapshot: PerformanceSnapshot) {
  const verdicts = performanceBudgetVerdicts(snapshot).filter(
    (v) => v.source !== 'gateway' && ['cached-paint', 'background-refresh'].includes(v.actionClass),
  );
  const required = [
    ...['command-center', 'companion'].flatMap((side) =>
      ['cached-paint', 'background-refresh'].map((actionClass) => ({ side, actionClass })),
    ),
  ];
  const coverage = required.map((want) => ({
    ...want,
    measured: verdicts.some(
      (v) => v.source === want.side && v.actionClass === want.actionClass && v.count >= 20,
    ),
  }));
  for (const side of ['command-center', 'companion'])
    for (const source of ['stored', 'memory'])
      coverage.push({
        side,
        actionClass: `cached-paint/${source}`,
        measured: snapshot.histograms.some(
          (h) =>
            h.name === 'farmslot_client_cached_paint_seconds' &&
            h.labels.side === side &&
            h.labels.cache_source === source &&
            h.count >= 20,
        ),
      });
  for (const method of ['family.observability.get', 'fleet.status', 'decision.resolve'])
    coverage.push({
      side: 'gateway',
      actionClass: method,
      measured: snapshot.histograms.some(
        (h) =>
          h.name === 'farmslot_rpc_duration_seconds' && h.labels.method === method && h.count >= 20,
      ),
    });
  const gatewayBudgets = snapshot.histograms
    .filter(
      (h) =>
        h.name === 'farmslot_rpc_duration_seconds' &&
        ['family.observability.get', 'fleet.status', 'decision.resolve'].includes(
          h.labels.method ?? '',
        ),
    )
    .map((h) => ({
      ...h,
      labels: {
        ...h.labels,
        action_class:
          h.labels.method === 'decision.resolve'
            ? ('gate-action' as const)
            : ('interactive-read' as const),
      },
    }));
  const allVerdicts = [
    ...verdicts,
    ...performanceBudgetVerdicts({ ...snapshot, histograms: gatewayBudgets }),
  ];
  const differences = [
    ...coverage.filter((c) => !c.measured).map((c) => `unmeasured ${c.side}/${c.actionClass}`),
    ...allVerdicts
      .filter((v) => v.status !== 'pass')
      .map((v) => `${v.status} ${v.source}/${v.actionClass}/${v.method}`),
  ];
  return { coverage, verdicts: allVerdicts, differences };
}
