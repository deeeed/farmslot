import { histogramPercentile, performanceBudgetVerdicts } from './histogram.js';
import type {
  PerformanceActionClass,
  PerformanceLabels,
  PerformanceSide,
  PerformanceSnapshot,
} from './types.js';
export interface SlowAction {
  cacheSource?: PerformanceLabels['cache_source'];
  phase: string;
  bytesMeasured: boolean;
  budgetSeconds?: number;
  budgetStatus?: string;
  processesMeasured: boolean;
  method: string;
  side: PerformanceSide;
  actionClass?: PerformanceActionClass;
  count: number;
  p50: number;
  p95: number;
  max: number;
  bytes: number;
  execCount: number;
  execSeconds: number;
  nodeCount: number;
  nodeSeconds: number;
  nodeWaitSeconds: number;
  loopLagSeconds: number;
  causes: string[];
}
export function slowestActions(snapshot: PerformanceSnapshot): SlowAction[] {
  const costs = new Map<string, Map<string, number>>();
  const identity = (labels: PerformanceLabels) =>
    `${labels.side ?? 'gateway'}|${labels.method ?? '_unknown'}`;
  const add = (labels: PerformanceLabels, name: string, value: number, max = false) => {
    const key = identity(labels);
    let values = costs.get(key);
    if (!values) {
      values = new Map();
      costs.set(key, values);
    }
    values.set(
      name,
      max ? Math.max(values.get(name) ?? 0, value) : (values.get(name) ?? 0) + value,
    );
  };
  for (const counter of snapshot.counters) add(counter.labels, counter.name, counter.value);
  for (const histogram of snapshot.histograms) {
    if (histogram.name === 'farmslot_rpc_response_bytes')
      add(histogram.labels, 'bytes', histogram.sum);
    if (histogram.name === 'farmslot_event_loop_lag_seconds')
      add(histogram.labels, 'lag', histogram.max, true);
  }
  const phases = {
    farmslot_rpc_duration_seconds: 'RPC',
    farmslot_client_cached_paint_seconds: 'Cached paint',
    farmslot_client_visible_read_seconds: 'Visible read',
    farmslot_client_background_refresh_seconds: 'Background refresh',
    farmslot_client_blocking_refresh_seconds: 'Blocking refresh',
  };
  const verdictKey = (name: string, labels: PerformanceLabels) =>
    [
      name,
      labels.side ?? 'gateway',
      labels.method ?? '_unknown',
      labels.action_class,
      labels.cache_source,
    ].join('|');
  const verdicts = new Map(
    performanceBudgetVerdicts(snapshot).map((v) => [
      [v.metric, v.source, v.method ?? '_unknown', v.actionClass, v.cacheSource].join('|'),
      v,
    ]),
  );
  return snapshot.histograms
    .filter((r) => Object.hasOwn(phases, r.name))
    .map((row) => {
      const phase = phases[row.name as keyof typeof phases];
      const bytesMeasured = row.name === 'farmslot_rpc_duration_seconds';
      const verdict = verdicts.get(verdictKey(row.name, row.labels));
      const { method = '_unknown', side = 'gateway', action_class } = row.labels;
      const values = costs.get(identity(row.labels));
      const value = (name: string) => values?.get(name) ?? 0;
      const bytes = bytesMeasured ? value('bytes') : 0,
        execCount = value('farmslot_exec_calls_total'),
        execSeconds = value('farmslot_exec_seconds_total');
      const nodeCount = value('farmslot_node_calls_total'),
        nodeSeconds = value('farmslot_node_seconds_total'),
        nodeWaitSeconds = value('farmslot_node_wait_seconds_total');
      const loopLagSeconds = value('lag');
      const causes: string[] = [];
      if (bytes / row.count > 131072) causes.push('payload');
      if (execCount) causes.push('spawned processes');
      if (nodeSeconds || nodeWaitSeconds) causes.push('node wait');
      if (loopLagSeconds > 0.1) causes.push('event-loop stall');
      if (!causes.length) causes.push(bytesMeasured ? 'inspect handler' : phase);
      return {
        cacheSource: row.labels.cache_source,
        phase,
        bytesMeasured,
        budgetSeconds: verdict?.budgetSeconds,
        budgetStatus: verdict?.status,
        processesMeasured: side === 'gateway',
        method,
        side,
        actionClass: action_class,
        count: row.count,
        p50: histogramPercentile(row, 0.5),
        p95: histogramPercentile(row, 0.95),
        max: row.max,
        bytes,
        execCount,
        execSeconds,
        nodeCount,
        nodeSeconds,
        nodeWaitSeconds,
        loopLagSeconds,
        causes,
      };
    })
    .sort((a, b) => b.p95 - a.p95 || b.max - a.max);
}
