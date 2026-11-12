import { type ChildProcess, fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import type { FloorHit } from '@farmslot/handoff/scrub';

import { registerHostOperations } from '../observability/performance.js';

import { isPublicationScanReply, type PublicationScanRequest } from './secret-scan-protocol.js';

export interface SecretScanService {
  /** Scans publication texts for secret values. Operation: secretScan.publication */
  publication(...texts: string[]): Promise<FloorHit[]>;
  /** Stops the scan process at shutdown; waiting scans refuse. */
  stop(): Promise<void>;
}

/** Stable operation names for metric attribution by the integrator. */
export const secretScanOperations = {
  publication: 'secretScan.publication',
} as const;
registerHostOperations(Object.values(secretScanOperations));

/** Scans waiting on the scan process; one more refuses instead of queueing without bound. */
export const MAX_PENDING_PUBLICATION_SCANS = 32;

interface PendingScan {
  resolve(hits: FloorHit[]): void;
  reject(error: Error): void;
}

interface ScanProcess {
  child: ChildProcess;
  pending: Map<number, PendingScan>;
}

let current: ScanProcess | undefined;
let nextScanId = 0;

function childEntry(): string {
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  return fileURLToPath(new URL(`./secret-scan-child.${extension}`, import.meta.url));
}

function running(child: ChildProcess): boolean {
  return child.pid !== undefined && child.exitCode === null && child.signalCode === null;
}

/** Holds the gateway process open only while a scan is waiting. */
function holdOpen(child: ChildProcess, hold: boolean): void {
  if (hold) {
    child.ref();
    child.channel?.ref();
  } else {
    child.unref();
    child.channel?.unref();
  }
}

function failScans(scan: ScanProcess, error: Error): void {
  if (current === scan) current = undefined;
  for (const request of scan.pending.values()) request.reject(error);
  scan.pending.clear();
  // A scanner that misbehaved is not reused; its exit lands here again with nothing pending.
  if (running(scan.child)) scan.child.kill('SIGKILL');
}

/**
 * One scan process, started on first use. A scan of a large log takes seconds, which held the
 * gateway's event loop. It is a fork, not a worker thread: a fork runs under the gateway's own
 * loader on every Node version, so the scanner resolves to the same module as in the gateway.
 */
function scanProcess(): ScanProcess {
  if (current) return current;
  const child = fork(childEntry(), [], {
    execArgv: process.execArgv,
    env: process.env,
    // Structured clone, not JSON: a multi-megabyte log crosses without a JSON round trip.
    serialization: 'advanced',
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const scan: ScanProcess = { child, pending: new Map() };
  child.on('message', (message: unknown) => {
    if (!isPublicationScanReply(message)) {
      failScans(scan, new Error('The publication secret scanner sent an invalid reply.'));
      return;
    }
    const request = scan.pending.get(message.id);
    scan.pending.delete(message.id);
    if (!scan.pending.size) holdOpen(child, false);
    if (message.hits) request?.resolve(message.hits);
    else request?.reject(new Error(`Publication secret scan failed: ${message.error}`));
  });
  child.on('error', (error) => failScans(scan, error));
  child.on('exit', (code, signal) =>
    failScans(
      scan,
      new Error(`The publication secret scanner exited with code ${code ?? signal ?? 'unknown'}.`),
    ),
  );
  current = scan;
  return scan;
}

const secretScan: SecretScanService = {
  publication(...texts: string[]): Promise<FloorHit[]> {
    const scan = scanProcess();
    if (scan.pending.size >= MAX_PENDING_PUBLICATION_SCANS)
      return Promise.reject(
        new Error(
          `Publication secret scanning is saturated: ${MAX_PENDING_PUBLICATION_SCANS} scans are waiting.`,
        ),
      );
    const id = nextScanId++;
    const hits = new Promise<FloorHit[]>((resolve, reject) =>
      scan.pending.set(id, { resolve, reject }),
    );
    holdOpen(scan.child, true);
    scan.child.send({ id, texts } satisfies PublicationScanRequest, (error) => {
      if (error) failScans(scan, error);
    });
    return hits;
  },

  async stop(): Promise<void> {
    const scan = current;
    if (!scan) return;
    const exited = new Promise<void>((resolve) => {
      if (!running(scan.child)) return resolve();
      scan.child.once('exit', () => resolve());
      // An idle scan process is unreferenced; keep the gateway up until its exit arrives.
      holdOpen(scan.child, true);
    });
    // Rejects the waiting scans and kills the scan process.
    failScans(scan, new Error('Publication secret scanning stopped.'));
    await exited;
  },
};

export default secretScan;
