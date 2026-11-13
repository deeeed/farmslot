// call-timings — where one `call` spent its time: each phase's wall and CPU
// time and the child processes this process started in it, plus counts of the
// work a call should do once (runner builds, provenance snapshots, live adapter
// bundles). The call writes them to call-timings.json in its directory, returns
// them as `timings` in --json and prints one summary line.

import { AsyncLocalStorage } from 'node:async_hooks';
import childProcess from 'node:child_process';
import diagnosticsChannel from 'node:diagnostics_channel';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';

export const CALL_TIMINGS_FILE = 'call-timings.json';

export type CallWork =
  | 'createRunner'
  | 'runnerPreflight'
  | 'provenanceSnapshot'
  | 'liveAdapterBuilt'
  | 'liveAdapterCached';

export interface CallPhaseTiming {
  name: string;
  wallMs: number;
  cpuMs: number;
  // Child processes this process started during the phase; their own children are not counted.
  processes: number;
}

export interface CallTimings {
  schemaVersion: 1;
  // From this process's start (Node bootstrap and imports included) to the report.
  wallMs: number;
  cpuMs: number;
  processes: number;
  // The action node's own time, from trace.json.
  nodeMs?: number;
  phases: CallPhaseTiming[];
  work: Record<CallWork, number>;
}

interface OpenPhase {
  name: string;
  wallStart: number;
  cpuStart: number;
  processStart: number;
}

const recorders = new AsyncLocalStorage<CallTimingRecorder>();

function cpuMs(): number {
  const usage = process.cpuUsage();
  return (usage.user + usage.system) / 1000;
}

export class CallTimingRecorder {
  readonly #phases: CallPhaseTiming[] = [];
  readonly #work: Record<CallWork, number> = {
    createRunner: 0,
    runnerPreflight: 0,
    provenanceSnapshot: 0,
    liveAdapterBuilt: 0,
    liveAdapterCached: 0,
  };
  #processes = 0;
  #open: OpenPhase;

  constructor() {
    // Everything before the command ran: Node's own start, the imports and dispatch.
    const wall = performance.now();
    const cpu = cpuMs();
    this.#phases.push({ name: 'bootstrap', wallMs: wall, cpuMs: cpu, processes: 0 });
    this.#open = { name: 'resolve', wallStart: wall, cpuStart: cpu, processStart: 0 };
  }

  /** End the running phase and start `name`. */
  phase(name: string): void {
    this.#close();
    this.#open = {
      name,
      wallStart: performance.now(),
      cpuStart: cpuMs(),
      processStart: this.#processes,
    };
  }

  count(work: CallWork): void {
    this.#work[work] += 1;
  }

  processStarted(): void {
    this.#processes += 1;
  }

  /** The timings so far, with the running phase closed at this moment. */
  snapshot(nodeMs?: number): CallTimings {
    const wall = performance.now();
    const cpu = cpuMs();
    const open: CallPhaseTiming = {
      name: this.#open.name,
      wallMs: wall - this.#open.wallStart,
      cpuMs: cpu - this.#open.cpuStart,
      processes: this.#processes - this.#open.processStart,
    };
    return {
      schemaVersion: 1,
      wallMs: round(wall),
      cpuMs: round(cpu),
      processes: this.#processes,
      ...(nodeMs !== undefined ? { nodeMs } : {}),
      phases: [...this.#phases, open].map((phase) => ({
        ...phase,
        wallMs: round(phase.wallMs),
        cpuMs: round(phase.cpuMs),
      })),
      work: { ...this.#work },
    };
  }

  #close(): void {
    this.#phases.push({
      name: this.#open.name,
      wallMs: performance.now() - this.#open.wallStart,
      cpuMs: cpuMs() - this.#open.cpuStart,
      processes: this.#processes - this.#open.processStart,
    });
  }
}

function round(value: number): number {
  return Math.round(value);
}

/** Run `body` with `recorder` receiving the work counts and child processes it causes. */
export function withCallTimings<T>(
  recorder: CallTimingRecorder,
  body: () => Promise<T>,
): Promise<T> {
  trackChildProcesses();
  return recorders.run(recorder, body);
}

/** Count `work` against the running call, if any. */
export function countCallWork(work: CallWork): void {
  recorders.getStore()?.count(work);
}

let tracking = false;

// Asynchronous children reach the `child_process` diagnostics channel. Node has
// no channel for spawnSync, so its three synchronous entry points are wrapped;
// syncBuiltinESMExports makes ESM importers see the wrappers too. Each start is
// attributed to the call whose async context started it.
function trackChildProcesses(): void {
  if (tracking) return;
  tracking = true;
  diagnosticsChannel.subscribe('child_process', () => recorders.getStore()?.processStarted());
  for (const name of ['spawnSync', 'execSync', 'execFileSync'] as const) {
    const counted = new Proxy(childProcess[name], {
      apply(target, thisArg, args) {
        recorders.getStore()?.processStarted();
        return Reflect.apply(target, thisArg, args);
      },
    });
    Object.defineProperty(childProcess, name, { value: counted });
  }
  syncBuiltinESMExports();
}

export function writeCallTimings(artifactsDir: string, timings: CallTimings): string {
  const file = path.join(path.resolve(artifactsDir), CALL_TIMINGS_FILE);
  fs.writeFileSync(file, `${JSON.stringify(timings, null, 2)}\n`);
  return file;
}

/** `7.4s (node 0.6s): bootstrap 0.3 · preflight 2.5 · … · 85 processes · runner 1× · provenance 2×` */
export function formatCallTimings(timings: CallTimings): string {
  const seconds = (ms: number) => (ms / 1000).toFixed(1);
  const phases = timings.phases
    .filter((phase) => phase.wallMs >= 50)
    .map((phase) => `${phase.name} ${seconds(phase.wallMs)}`)
    .join(' · ');
  const node = timings.nodeMs !== undefined ? ` (node ${seconds(timings.nodeMs)}s)` : '';
  return (
    `${seconds(timings.wallMs)}s${node}: ${phases} · ${timings.processes} processes` +
    ` · runner ${timings.work.createRunner}× · provenance ${timings.work.provenanceSnapshot}×`
  );
}
