export const PERFORMANCE_BUDGETS = {
  'cached-paint': 0.1,
  'interactive-read': 0.25,
  'gate-action': 2,
  'background-refresh': 5,
} as const;
export type PerformanceActionClass = keyof typeof PERFORMANCE_BUDGETS;
export type PerformanceSide = 'gateway' | 'command-center' | 'companion' | 'cli';
export type ClientPerformanceSide = Exclude<PerformanceSide, 'gateway'>;
export type ExecutionKind = 'git' | 'tmux' | 'ssh' | 'node' | 'shell' | 'other';
export const DURATION_BUCKETS = [
  0.001, 0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.15, 0.25, 0.5, 1, 2, 5, 10, 20, 30, 60, 120, 180,
  300, 600, 3600,
];
export const BYTE_BUCKETS = [
  0, 1024, 4096, 16384, 65536, 131072, 262144, 524288, 1048576, 2097152, 4194304, 8388608, 16777216,
];
export const AGE_BUCKETS = [1, 5, 10, 30, 60, 300, 900, 3600, 21600, 86400, 604800];
export const HISTOGRAM_METRICS = {
  farmslot_rpc_duration_seconds: DURATION_BUCKETS,
  farmslot_rpc_response_bytes: BYTE_BUCKETS,
  farmslot_event_loop_lag_seconds: DURATION_BUCKETS,
  farmslot_client_cached_paint_seconds: DURATION_BUCKETS,
  farmslot_client_visible_read_seconds: DURATION_BUCKETS,
  farmslot_native_text_render_seconds: DURATION_BUCKETS,
  farmslot_client_background_refresh_seconds: DURATION_BUCKETS,
  farmslot_client_blocking_refresh_seconds: DURATION_BUCKETS,
  farmslot_client_cache_age_seconds: AGE_BUCKETS,
} as const;
export const COUNTER_METRICS = [
  'farmslot_rpc_errors_total',
  'farmslot_exec_calls_total',
  'farmslot_exec_seconds_total',
  'farmslot_node_calls_total',
  'farmslot_node_seconds_total',
  'farmslot_node_wait_seconds_total',
  'farmslot_client_cache_reads_total',
  'farmslot_client_stale_reads_total',
  'farmslot_client_blocking_reads_total',
  'farmslot_client_unknown_age_total',
  'farmslot_client_unmeasured_paints_total',
  'farmslot_client_report_failures_total',
] as const;
export const GAUGE_METRICS = ['farmslot_client_rereads_per_minute'] as const;
export type PerformanceHistogramName = keyof typeof HISTOGRAM_METRICS;
export type PerformanceCounterName = (typeof COUNTER_METRICS)[number];
export type PerformanceGaugeName = (typeof GAUGE_METRICS)[number];
export interface PerformanceLabels {
  method?: string;
  side?: PerformanceSide;
  action_class?: PerformanceActionClass;
  kind?: ExecutionKind;
  cache_source?: 'memory' | 'stored' | 'network' | 'unknown';
  query?: string;
}
export interface PerformanceHistogram {
  name: PerformanceHistogramName;
  labels: PerformanceLabels;
  buckets: number[];
  count: number;
  sum: number;
  max: number;
}
export interface PerformanceCounter {
  name: PerformanceCounterName;
  labels: PerformanceLabels;
  value: number;
}
export interface PerformanceGauge {
  name: PerformanceGaugeName;
  labels: PerformanceLabels;
  value: number;
}
export interface ClientPerformanceWindow {
  id: string;
  side: ClientPerformanceSide;
  startedAtMs: number;
  observedAtMs: number;
  receivedAtMs: number;
}
export interface PerformanceSnapshot {
  clientWindows?: ClientPerformanceWindow[];
  version: 1;
  startedAtMs: number;
  observedAtMs: number;
  histograms: PerformanceHistogram[];
  counters: PerformanceCounter[];
  gauges: PerformanceGauge[];
  dropped: number;
}
export interface ClientPerformanceReport extends PerformanceSnapshot {
  sourceId: string;
  sequence: number;
  side: ClientPerformanceSide;
}
export interface ClientPerformanceReportResult {
  accepted: boolean;
  duplicate?: boolean;
  reason?: 'source-expired' | 'sequence-gap' | 'invalid-report';
}
export interface PerformanceBudgetVerdict {
  metric: PerformanceHistogramName;
  cacheSource?: PerformanceLabels['cache_source'];
  method?: string;
  actionClass: PerformanceActionClass;
  source: string;
  count: number;
  withinBudget: number;
  budgetSeconds: number;
  status: 'pass' | 'fail' | 'unmeasured';
}
