import { Methods } from '../rpc/registry.js';

import {
  type ClientPerformanceReport,
  type ClientPerformanceReportResult,
  type ClientPerformanceWindow,
  HISTOGRAM_METRICS,
  type PerformanceActionClass,
  type PerformanceCounter,
  type PerformanceCounterName,
  type PerformanceGauge,
  type PerformanceHistogram,
  type PerformanceHistogramName,
  type PerformanceLabels,
  type PerformanceSide,
  type PerformanceSnapshot,
} from './types.js';
const MAX_SERIES = 8192;
const MAX_QUERIES = 128;
const MAX_REPORTERS = 32;
const REPORT_CHUNK = 128;
interface HistogramState extends Omit<PerformanceHistogram, 'buckets'> {
  bins: number[];
}
interface State {
  histograms: Map<string, HistogramState>;
  counters: Map<string, PerformanceCounter>;
  dropped: number;
}
interface QueryRate {
  id: string;
  method: string;
  second: number;
  bins: number[];
}
interface RecorderOptions {
  clock?: () => number;
  methods?: ReadonlySet<string>;
}
const empty = (): State => ({ histograms: new Map(), counters: new Map(), dropped: 0 });
const id = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const key = (name: string, l: PerformanceLabels) =>
  [name, l.method, l.side, l.action_class, l.kind, l.cache_source, l.query].join('|');
export class PerformanceRecorder {
  readonly side: PerformanceSide;
  readonly clock: () => number;
  private readonly activity = new Set<() => void>();
  onActivity(listener: () => void): () => void {
    this.activity.add(listener);
    return () => this.activity.delete(listener);
  }
  private changed(): void {
    for (const listener of this.activity) listener();
  }
  private methods: ReadonlySet<string>;
  private startedAtMs = Date.now();
  private all = empty();
  private delta = empty();
  private sourceId = id();
  private sequence = 0;
  private report?: ClientPerformanceReport;
  private reporters = new Map<
    string,
    { sequence: number; ordinal: number; window: ClientPerformanceWindow }
  >();
  private reporterOrdinal = 0;
  private rates = new Map<string, QueryRate>();
  private queryOrdinal = 0;
  private queryIds = new WeakMap<object, string>();
  private scopeVersion = 0;
  get epoch(): number {
    return this.scopeVersion;
  }
  resetScope(): void {
    this.scopeVersion++;
    this.all = empty();
    this.delta = empty();
    this.report = undefined;
    this.rates.clear();
    this.queryIds = new WeakMap();
    this.sourceId = id();
    this.sequence = 0;
    this.startedAtMs = Date.now();
  }
  private reportedGauges = new Map<string, { gauge: PerformanceGauge; expires: number }>();
  constructor(side: PerformanceSide, options: RecorderOptions = {}) {
    this.side = side;
    this.clock = options.clock ?? (() => performance.now() / 1000);
    this.methods = options.methods ?? new Set(Object.values(Methods));
  }
  private labels(input: PerformanceLabels): PerformanceLabels {
    return {
      ...input,
      side: input.side ?? this.side,
      ...(input.method
        ? {
            method:
              this.methods.has(input.method) || input.method === '_background'
                ? input.method
                : '_unknown',
          }
        : {}),
    };
  }
  observe(name: PerformanceHistogramName, input: PerformanceLabels, value: number): void {
    if (!Number.isFinite(value) || value < 0) {
      this.all.dropped++;
      this.delta.dropped++;
      return;
    }
    const labels = this.labels(input),
      identity = key(name, labels),
      bounds = HISTOGRAM_METRICS[name];
    let index = bounds.findIndex((bound) => value <= bound);
    if (index < 0) index = bounds.length;
    const update = (state: State) => {
      let row = state.histograms.get(identity);
      if (!row) {
        if (state.histograms.size + state.counters.size >= MAX_SERIES) {
          state.dropped++;
          return;
        }
        row = {
          name,
          labels,
          bins: Array<number>(bounds.length + 1).fill(0),
          count: 0,
          sum: 0,
          max: 0,
        };
        state.histograms.set(identity, row);
      }
      row.bins[index]++;
      row.count++;
      row.sum += value;
      row.max = Math.max(row.max, value);
    };
    update(this.all);
    if (this.side !== 'gateway') update(this.delta);
    this.changed();
  }
  increment(name: PerformanceCounterName, input: PerformanceLabels, value = 1): void {
    if (!Number.isFinite(value) || value < 0) {
      this.all.dropped++;
      this.delta.dropped++;
      return;
    }
    const labels = this.labels(input),
      identity = key(name, labels);
    const update = (state: State) => {
      const row = state.counters.get(identity);
      if (row) row.value += value;
      else if (state.histograms.size + state.counters.size < MAX_SERIES)
        state.counters.set(identity, { name, labels, value });
      else state.dropped++;
    };
    update(this.all);
    if (this.side !== 'gateway') update(this.delta);
    this.changed();
  }
  private rotate(rate: QueryRate, second: number): void {
    const elapsed = Math.max(0, second - rate.second);
    if (elapsed >= 60) rate.bins.fill(0);
    else for (let i = 1; i <= elapsed; i++) rate.bins[(rate.second + i) % 60] = 0;
    rate.second = second;
  }
  reread(method: string, identity: object): void {
    let queryKey = this.queryIds.get(identity);
    if (!queryKey) {
      queryKey = `q${++this.queryOrdinal}`;
      this.queryIds.set(identity, queryKey);
    }
    const second = Math.floor(this.clock());
    let rate = this.rates.get(queryKey);
    if (!rate) {
      if (this.rates.size >= MAX_QUERIES) {
        const oldest = this.rates.keys().next().value;
        if (oldest !== undefined) this.rates.delete(oldest);
      }
      rate = { id: queryKey, method, second, bins: Array<number>(60).fill(0) };
    }
    this.rotate(rate, second);
    rate.bins[second % 60]++;
    this.rates.delete(queryKey);
    this.rates.set(queryKey, rate);
    this.changed();
  }
  private snapshotState(state: State): PerformanceSnapshot {
    const histograms = [...state.histograms.values()].map((row) => {
      let cumulative = 0;
      return {
        name: row.name,
        labels: { ...row.labels },
        buckets: row.bins.map((count) => (cumulative += count)),
        count: row.count,
        sum: row.sum,
        max: row.max,
      };
    });
    const gauges: PerformanceGauge[] = [...this.rates.values()].map((rate) => ({
      name: 'farmslot_client_rereads_per_minute',
      labels: this.labels({ method: rate.method, query: rate.id }),
      value: (this.rotate(rate, Math.floor(this.clock())), rate.bins.reduce((a, b) => a + b, 0)),
    }));
    return {
      version: 1,
      clientWindows: [...this.reporters.values()].map((row) => ({ ...row.window })),
      startedAtMs: this.startedAtMs,
      observedAtMs: Date.now(),
      histograms,
      counters: [...state.counters.values()].map((row) => ({ ...row, labels: { ...row.labels } })),
      gauges: [
        ...gauges,
        ...[...this.reportedGauges.values()]
          .filter((row) => row.expires > Date.now())
          .map((row) => row.gauge),
      ],
      dropped: state.dropped,
    };
  }
  snapshot(): PerformanceSnapshot {
    return this.snapshotState(this.all);
  }
  beginReport(): ClientPerformanceReport | undefined {
    if (this.side === 'gateway') return undefined;
    if (this.report) return this.report;
    if (!this.delta.histograms.size && !this.delta.counters.size && !this.delta.dropped)
      return undefined;
    const selected = empty();
    let remaining = REPORT_CHUNK;
    const histogramLimit = this.delta.counters.size ? REPORT_CHUNK / 2 : REPORT_CHUNK;
    for (const [k, v] of this.delta.histograms) {
      if (selected.histograms.size >= histogramLimit) break;
      remaining--;
      selected.histograms.set(k, v);
      this.delta.histograms.delete(k);
    }
    if (remaining > 0)
      for (const [k, v] of this.delta.counters) {
        if (!remaining--) break;
        selected.counters.set(k, v);
        this.delta.counters.delete(k);
      }
    selected.dropped = this.delta.dropped;
    this.delta.dropped = 0;
    this.report = {
      ...this.snapshotState(selected),
      sourceId: this.sourceId,
      sequence: ++this.sequence,
      side: this.side,
    };
    return this.report;
  }
  acknowledge(sequence: number): void {
    if (this.report?.sequence === sequence) this.report = undefined;
  }
  expireReportSource(): void {
    if (this.report) {
      const discarded = this.report.histograms.reduce((sum, row) => sum + row.count, 0);
      this.all.dropped += discarded;
      this.delta.dropped += discarded + this.report.dropped;
    }
    this.report = undefined;
    this.sourceId = id();
    this.sequence = 0;
  }
  mergeReport(
    authenticatedSource: string,
    report: ClientPerformanceReport,
  ): ClientPerformanceReportResult {
    const identity = `${authenticatedSource}:${report.sourceId}`;
    const previous = this.reporters.get(identity);
    if (previous && report.sequence <= previous.sequence)
      return { accepted: true, duplicate: true };
    if (!previous && report.sequence !== 1) return { accepted: false, reason: 'source-expired' };
    if (previous && report.sequence !== previous.sequence + 1)
      return { accepted: false, reason: 'sequence-gap' };
    if (
      report.histograms.some((row) => {
        const bounds = HISTOGRAM_METRICS[row.name];
        return (
          !bounds ||
          row.buckets.length !== bounds.length + 1 ||
          row.buckets.at(-1) !== row.count ||
          row.buckets.some(
            (n, i) => !Number.isFinite(n) || n < 0 || (i > 0 && n < row.buckets[i - 1]),
          ) ||
          !Number.isFinite(row.sum) ||
          row.sum < 0 ||
          !Number.isFinite(row.max) ||
          row.max < 0
        );
      })
    )
      return { accepted: false, reason: 'invalid-report' };
    if (this.reporters.size >= MAX_REPORTERS && !previous) {
      const oldest = this.reporters.keys().next().value;
      if (oldest !== undefined) this.reporters.delete(oldest);
    }
    const ordinal = previous?.ordinal ?? ++this.reporterOrdinal;
    const checkpoint = {
      sequence: report.sequence,
      ordinal,
      window: {
        id: `p${ordinal}`,
        side: report.side,
        startedAtMs: report.startedAtMs,
        observedAtMs: report.observedAtMs,
        receivedAtMs: Date.now(),
      },
    };
    this.reporters.delete(identity);
    this.reporters.set(identity, checkpoint);
    for (const row of report.histograms) {
      const labels = this.labels({ ...row.labels, side: report.side }),
        identity = key(row.name, labels);
      let target = this.all.histograms.get(identity);
      if (!target) {
        if (this.all.histograms.size + this.all.counters.size >= MAX_SERIES) {
          this.all.dropped += row.count;
          continue;
        }
        target = {
          name: row.name,
          labels,
          bins: row.buckets.map(() => 0),
          count: 0,
          sum: 0,
          max: 0,
        };
        this.all.histograms.set(identity, target);
      }
      let previous = 0;
      row.buckets.forEach((count, i) => {
        target.bins[i] += count - previous;
        previous = count;
      });
      target.count += row.count;
      target.sum += row.sum;
      target.max = Math.max(target.max, row.max);
    }
    for (const row of report.counters)
      this.increment(row.name, { ...row.labels, side: report.side }, row.value);
    for (const row of report.gauges) {
      const labels = this.labels({
        ...row.labels,
        side: report.side,
        query: `p${checkpoint.ordinal}_${row.labels.query ?? 'all'}`,
      });
      if (
        this.reportedGauges.size >= MAX_QUERIES &&
        !this.reportedGauges.has(key(row.name, labels))
      ) {
        const oldest = this.reportedGauges.keys().next().value;
        if (oldest !== undefined) this.reportedGauges.delete(oldest);
      }
      this.reportedGauges.set(key(row.name, labels), {
        gauge: { ...row, labels },
        expires: Date.now() + 60000,
      });
    }
    this.all.dropped += report.dropped;
    return { accepted: true };
  }
}
export async function measureClientRequest<T>(
  metrics: PerformanceRecorder,
  method: string,
  actionClass: PerformanceActionClass,
  request: (received: (bytes: number) => void) => Promise<T>,
): Promise<T> {
  const epoch = metrics.epoch;
  const started = metrics.clock();
  let bytes: number | undefined;
  let failed = false;
  try {
    return await request((value) => {
      bytes = value;
    });
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    if (epoch === metrics.epoch) {
      const labels = { method, action_class: actionClass };
      metrics.observe('farmslot_rpc_duration_seconds', labels, metrics.clock() - started);
      if (bytes !== undefined) metrics.observe('farmslot_rpc_response_bytes', labels, bytes);
      if (failed) metrics.increment('farmslot_rpc_errors_total', labels);
    }
  }
}
