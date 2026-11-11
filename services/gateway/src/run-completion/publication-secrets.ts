import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import type { FloorHit } from '@farmslot/handoff/scrub';

import type {
  PublicationScanReply,
  PublicationScanRequest,
} from './publication-secret-scan-worker.js';

/** A refusal must survive optional rendering fallbacks without exposing secret bytes. */
export class PublicationSecretError extends Error {
  constructor(hits: FloorHit[]) {
    super(
      `Publication blocked by secret values: ${hits.map(({ kind, fingerprint }) => `${kind} ${fingerprint}`).join(', ')}. Remove secrets from the producer, rerun the recipe, then refresh the gate package.`,
    );
    this.name = 'PublicationSecretError';
  }
}

/** Scans waiting on the worker; one more refuses instead of queueing without bound. */
export const MAX_PENDING_PUBLICATION_SCANS = 32;

interface PendingScan {
  resolve(hits: FloorHit[]): void;
  reject(error: Error): void;
}

interface ScanWorker {
  worker: Worker;
  pending: Map<number, PendingScan>;
}

let current: ScanWorker | undefined;
let nextScanId = 0;

function failScans(scan: ScanWorker, error: Error): void {
  if (current === scan) current = undefined;
  for (const request of scan.pending.values()) request.reject(error);
  scan.pending.clear();
}

/**
 * One scan worker, started on first use. A scan of a large log takes seconds,
 * which held the gateway's event loop. The worker holds the process open only
 * while a scan is waiting.
 */
function scanWorker(): ScanWorker {
  if (current) return current;
  const extension = path.extname(fileURLToPath(import.meta.url));
  const worker = new Worker(
    new URL(`./publication-secret-scan-worker${extension}`, import.meta.url),
  );
  const scan: ScanWorker = { worker, pending: new Map() };
  worker.on('message', (reply: PublicationScanReply) => {
    const request = scan.pending.get(reply.id);
    scan.pending.delete(reply.id);
    if (!scan.pending.size) worker.unref();
    if (reply.hits) request?.resolve(reply.hits);
    else request?.reject(new Error(`Publication secret scan failed: ${reply.error}`));
  });
  worker.on('error', (error) => failScans(scan, error));
  worker.on('exit', (code) =>
    failScans(scan, new Error(`The publication secret scanner exited with code ${code}.`)),
  );
  current = scan;
  return scan;
}

/**
 * Resolves only after every text was scanned. Refuses on secret values, and on
 * any failure to complete the scan, so nothing publishes unscanned.
 */
export async function assertPublicationTextSafe(...texts: string[]): Promise<void> {
  const scan = scanWorker();
  if (scan.pending.size >= MAX_PENDING_PUBLICATION_SCANS)
    throw new Error(
      `Publication secret scanning is saturated: ${MAX_PENDING_PUBLICATION_SCANS} scans are waiting.`,
    );
  const id = nextScanId++;
  const hits = new Promise<FloorHit[]>((resolve, reject) =>
    scan.pending.set(id, { resolve, reject }),
  );
  scan.worker.ref();
  scan.worker.postMessage({ id, texts } satisfies PublicationScanRequest);
  const found = await hits;
  if (found.length) throw new PublicationSecretError(found);
}

/** Stops the scan worker at gateway shutdown; waiting scans refuse. */
export async function stopPublicationSecretScanner(): Promise<void> {
  const scan = current;
  if (!scan) return;
  failScans(scan, new Error('Publication secret scanning stopped.'));
  await scan.worker.terminate();
}
