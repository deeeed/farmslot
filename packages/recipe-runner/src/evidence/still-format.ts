import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import type { EvidenceStillFormat } from '@farmslot/protocol';

import { readFileWithinRoot, writeFileWithinRoot } from '../core/path.js';

/**
 * Publishes a recorder's PNG still in the run's still format (ADR-062 Amendment 17): lossy
 * WebP at quality 85, replacing the PNG, or the PNG unchanged.
 */
export async function publishEvidenceStill(
  root: string,
  pngPath: string,
  format: EvidenceStillFormat,
): Promise<{ path: string; mimeType: string }> {
  if (format === 'png') return { path: pngPath, mimeType: 'image/png' };
  const webpPath = pngPath.replace(/(\.png)?$/, '.webp');
  try {
    await writeFileWithinRoot(
      root,
      webpPath,
      await encodeWebp(await readFileWithinRoot(root, pngPath)),
    );
  } finally {
    // The WebP is the evidence: no PNG original is kept, also when encoding fails.
    await rm(path.join(root, pngPath), { force: true });
  }
  return { path: webpPath, mimeType: 'image/webp' };
}

interface Pending {
  resolve(webp: Uint8Array): void;
  reject(error: Error): void;
}

let worker: Worker | undefined;
let nextId = 0;
const pending = new Map<number, Pending>();

/**
 * Encoding runs on a worker thread, so recorders sharing this process keep their frame pace.
 * The worker holds the process open only while an encode is pending.
 */
function encodeWebp(png: Uint8Array): Promise<Uint8Array> {
  const id = nextId++;
  const result = new Promise<Uint8Array>((resolve, reject) => pending.set(id, { resolve, reject }));
  const started = encoder();
  started.ref();
  started.postMessage({ id, png });
  return result;
}

function encoder(): Worker {
  if (worker) return worker;
  const built = new URL('./webp-encoder-worker.js', import.meta.url);
  const started = existsSync(fileURLToPath(built)) ? new Worker(built) : sourceWorker();
  started.on('message', (message: { id: number; webp?: Uint8Array; error?: string }) => {
    const request = pending.get(message.id);
    pending.delete(message.id);
    if (pending.size === 0) started.unref();
    if (message.webp) request?.resolve(message.webp);
    else request?.reject(new Error(`WebP encoding failed: ${message.error}`));
  });
  started.on('error', (error) => {
    worker = undefined;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  });
  worker = started;
  return started;
}

/**
 * A source run (tests, dev) has only the .ts file next to this one, so tsx loads it. tsx is
 * resolved here: an eval worker would resolve it from the process's working directory.
 */
function sourceWorker(): Worker {
  const tsx = JSON.stringify(import.meta.resolve('tsx/esm/api'));
  const source = JSON.stringify(new URL('./webp-encoder-worker.ts', import.meta.url).href);
  return new Worker(
    `import(${tsx}).then(({ register }) => { register(); return import(${source}); });`,
    { eval: true },
  );
}
