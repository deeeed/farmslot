import {
  type ClientPerformanceReport,
  COUNTER_METRICS,
  GAUGE_METRICS,
  HISTOGRAM_METRICS,
} from './types.js';
const object = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const number = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const integer = (v: unknown): v is number => number(v) && Number.isSafeInteger(v);
const bounded = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-zA-Z0-9_.-]{1,80}$/.test(v);
function labels(v: unknown): boolean {
  if (
    !object(v) ||
    Object.keys(v).some(
      (k) => !['method', 'side', 'action_class', 'kind', 'cache_source', 'query'].includes(k),
    )
  )
    return false;
  return Object.entries(v).every(
    ([k, x]) =>
      x === undefined ||
      (k === 'side'
        ? ['command-center', 'companion', 'cli'].includes(String(x))
        : k === 'action_class'
          ? ['cached-paint', 'interactive-read', 'gate-action', 'background-refresh'].includes(
              String(x),
            )
          : k === 'kind'
            ? ['git', 'tmux', 'ssh', 'node', 'shell', 'other'].includes(String(x))
            : k === 'cache_source'
              ? ['memory', 'stored', 'network', 'unknown'].includes(String(x))
              : k === 'query'
                ? typeof x === 'string' && /^q[0-9]+$/.test(x)
                : bounded(x)),
  );
}
export function isClientPerformanceReport(v: unknown): v is ClientPerformanceReport {
  if (
    !object(v) ||
    v.version !== 1 ||
    !bounded(v.sourceId) ||
    !integer(v.sequence) ||
    v.sequence < 1 ||
    !['command-center', 'companion', 'cli'].includes(String(v.side)) ||
    !number(v.startedAtMs) ||
    !number(v.observedAtMs) ||
    !integer(v.dropped)
  )
    return false;
  if (
    !Array.isArray(v.histograms) ||
    !Array.isArray(v.counters) ||
    !Array.isArray(v.gauges) ||
    v.histograms.length + v.counters.length > 128 ||
    v.gauges.length > 128
  )
    return false;
  return (
    v.histograms.every(
      (r) =>
        object(r) &&
        typeof r.name === 'string' &&
        Object.hasOwn(HISTOGRAM_METRICS, r.name) &&
        labels(r.labels) &&
        integer(r.count) &&
        number(r.sum) &&
        number(r.max) &&
        Array.isArray(r.buckets) &&
        r.buckets.every(integer),
    ) &&
    v.counters.every(
      (r) =>
        object(r) &&
        COUNTER_METRICS.some((n) => n === r.name) &&
        labels(r.labels) &&
        number(r.value),
    ) &&
    v.gauges.every(
      (r) =>
        object(r) && GAUGE_METRICS.some((n) => n === r.name) && labels(r.labels) && number(r.value),
    )
  );
}
