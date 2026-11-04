import { HISTOGRAM_METRICS, type PerformanceLabels, type PerformanceSnapshot } from './types.js';
function escapeLabel(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll('"', '\\"');
}
interface PrometheusLabels extends PerformanceLabels {
  source?: string;
}
function labels(value: PrometheusLabels, bound?: string): string {
  const pairs = Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}="${escapeLabel(String(v))}"`);
  if (bound !== undefined) pairs.push(`le="${bound}"`);
  return pairs.length ? `{${pairs.join(',')}}` : '';
}
export function renderPrometheus(snapshot: PerformanceSnapshot): string {
  const output: string[] = [];
  const declared = new Set<string>();
  function type(name: string, kind: string): void {
    if (!declared.has(name)) {
      declared.add(name);
      output.push(`# TYPE ${name} ${kind}`);
    }
  }
  for (const row of snapshot.histograms) {
    type(row.name, 'histogram');
    const bounds = HISTOGRAM_METRICS[row.name];
    row.buckets.forEach((count, i) =>
      output.push(`${row.name}_bucket${labels(row.labels, String(bounds[i] ?? '+Inf'))} ${count}`),
    );
    output.push(
      `${row.name}_count${labels(row.labels)} ${row.count}`,
      `${row.name}_sum${labels(row.labels)} ${row.sum}`,
    );
    type(`${row.name}_max`, 'gauge');
    output.push(`${row.name}_max${labels(row.labels)} ${row.max}`);
  }
  for (const row of snapshot.counters) {
    type(row.name, 'counter');
    output.push(`${row.name}${labels(row.labels)} ${row.value}`);
  }
  for (const row of snapshot.gauges) {
    type(row.name, 'gauge');
    output.push(`${row.name}${labels(row.labels)} ${row.value}`);
  }
  for (const window of snapshot.clientWindows ?? []) {
    const source = labels({ side: window.side, source: window.id });
    for (const [name, value] of [
      ['farmslot_client_window_start_seconds', window.startedAtMs],
      ['farmslot_client_window_observed_seconds', window.observedAtMs],
      ['farmslot_client_window_received_seconds', window.receivedAtMs],
    ] as const) {
      type(name, 'gauge');
      output.push(`${name}${source} ${value / 1000}`);
    }
  }
  type('farmslot_metrics_dropped_total', 'counter');
  output.push(`farmslot_metrics_dropped_total ${snapshot.dropped}`);
  return output.join('\n') + '\n';
}
