import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';

import { Methods } from '@farmslot/protocol';
import {
  type ExecutionKind,
  performanceActionClass,
  PerformanceRecorder,
} from '@farmslot/protocol/performance';

export const gatewayPerformance = new PerformanceRecorder('gateway');
interface RequestCost {
  method: string;
  metrics: PerformanceRecorder;
  bytes?: number;
  failed: boolean;
  exec: number;
  node: number;
  wait: number;
  lag: number;
  active: boolean;
}
const current = new AsyncLocalStorage<RequestCost>();
const active = new Set<RequestCost>();
const knownMethods = new Set<string>(Object.values(Methods));
const loop = monitorEventLoopDelay({ resolution: 20 });
let sampling: ReturnType<typeof setInterval> | undefined;
/** The server owns sampling; closing a fixture server must release its timer. */
export function startPerformanceSampling(): () => void {
  if (sampling) return () => {};
  loop.enable();
  sampling = setInterval(() => {
    const lag = Number.isFinite(loop.max) ? loop.max / 1e9 : 0;
    gatewayPerformance.observe('farmslot_event_loop_lag_seconds', {}, lag);
    for (const cost of active) cost.lag = Math.max(cost.lag, lag);
    loop.reset();
  }, 1000);
  sampling.unref();
  return () => {
    clearInterval(sampling);
    sampling = undefined;
    loop.disable();
  };
}
export async function measureGatewayRequest<T>(
  method: string,
  operation: () => Promise<T>,
  metrics = gatewayPerformance,
): Promise<T> {
  const cost: RequestCost = {
    method,
    metrics,
    failed: false,
    exec: 0,
    node: 0,
    wait: 0,
    lag: 0,
    active: true,
  };
  const started = performance.now();
  active.add(cost);
  return current.run(cost, async () => {
    try {
      return await operation();
    } catch (error) {
      cost.failed = true;
      throw error;
    } finally {
      cost.active = false;
      active.delete(cost);
      const duration = (performance.now() - started) / 1000;
      const labels = { method, action_class: performanceActionClass(method) };
      metrics.observe('farmslot_rpc_duration_seconds', labels, duration);
      if (cost.bytes !== undefined)
        metrics.observe('farmslot_rpc_response_bytes', labels, cost.bytes);
      if (cost.failed) metrics.increment('farmslot_rpc_errors_total', labels);
      metrics.observe('farmslot_event_loop_lag_seconds', labels, cost.lag);
      if (duration > 2)
        console.warn(
          '[performance] slow RPC',
          JSON.stringify({
            method: knownMethods.has(method) ? method : '_unknown',
            outcome: cost.failed ? 'error' : 'ok',
            seconds: duration,
            bytes: cost.bytes,
            execSeconds: cost.exec,
            nodeSeconds: cost.node,
            nodeWaitSeconds: cost.wait,
            loopLagSeconds: cost.lag,
          }),
        );
    }
  });
}
/** Work a request starts without awaiting is background work, not part of the request's cost. */
export function outsideGatewayRequest<T>(operation: () => T): T {
  return current.exit(operation);
}
export function recordGatewayResponse(bytes: number, ok: boolean): void {
  const cost = current.getStore();
  if (!cost?.active) return;
  cost.bytes = bytes;
  cost.failed = !ok;
}
export function executionKind(executable: string, argv: readonly string[] = []): ExecutionKind {
  const name = path.basename(executable);
  if (name === 'git' || name === 'tmux' || name === 'ssh' || name === 'node') return name;
  if (name === 'bash' || name === 'sh' || name === 'zsh') {
    const declared =
      argv[0] === '-c'
        ? argv[1]?.match(/^\s*(?:command\s+)?(git|tmux|ssh|node)(?:\s|$)/)?.[1]
        : undefined;
    if (declared === 'git' || declared === 'tmux' || declared === 'ssh' || declared === 'node')
      return declared;
    return 'shell';
  }
  return 'other';
}
export function measureManagedOperation<T>(
  type: 'exec' | 'node' | 'wait',
  kind: ExecutionKind,
  operation: () => Promise<T>,
): Promise<T> {
  const cost = current.getStore();
  const metrics = cost?.metrics ?? gatewayPerformance;
  const start = performance.now();
  const finish = () => {
    const labels = { method: cost?.active ? cost.method : '_background', kind };
    const elapsed = (performance.now() - start) / 1000;
    if (type !== 'wait')
      metrics.increment(
        type === 'exec' ? 'farmslot_exec_calls_total' : 'farmslot_node_calls_total',
        labels,
      );
    metrics.increment(
      type === 'exec'
        ? 'farmslot_exec_seconds_total'
        : type === 'node'
          ? 'farmslot_node_seconds_total'
          : 'farmslot_node_wait_seconds_total',
      labels,
      elapsed,
    );
    if (cost?.active) cost[type === 'exec' ? 'exec' : type === 'node' ? 'node' : 'wait'] += elapsed;
  };
  try {
    const request = operation();
    // Observe both settlements; the original Promise retains its rejection and scheduling.
    void request.then(finish, finish);
    return request;
  } catch (error) {
    finish();
    throw error;
  }
}
