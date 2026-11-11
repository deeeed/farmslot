import { createHash } from 'node:crypto';
import { parentPort } from 'node:worker_threads';

import { type FloorHit, scanForFloorSecrets } from '@farmslot/handoff/scrub';

/** One publication scan: the texts publication would carry, in order. */
export interface PublicationScanRequest {
  id: number;
  texts: string[];
}

/** The hits of the first text holding secret values (none when all are clean), or why the scan failed. */
export interface PublicationScanReply {
  id: number;
  hits?: FloorHit[];
  error?: string;
}

// Repeated publication checks still validate frozen bytes. Cache only clean
// text hashes to avoid rescanning the same immutable logs at each boundary.
const cleanTextHashes = new Set<string>();
const MAX_CLEAN_TEXT_HASHES = 256;

function firstSecretHits(texts: string[]): FloorHit[] {
  for (const text of texts) {
    const digest = createHash('sha256').update(text).digest('hex');
    if (cleanTextHashes.has(digest)) continue;
    const hits = scanForFloorSecrets(text);
    if (hits.length) return hits;
    cleanTextHashes.add(digest);
    if (cleanTextHashes.size > MAX_CLEAN_TEXT_HASHES) {
      const oldest = cleanTextHashes.values().next();
      if (!oldest.done) cleanTextHashes.delete(oldest.value);
    }
  }
  return [];
}

const port = parentPort;
if (!port) throw new Error('The publication secret scanner runs only as a worker thread.');
port.on('message', ({ id, texts }: PublicationScanRequest) => {
  let reply: PublicationScanReply;
  try {
    reply = { id, hits: firstSecretHits(texts) };
  } catch (error) {
    // The caller refuses publication on this reply, as it did on a thrown scan error.
    reply = { id, error: error instanceof Error ? error.message : String(error) };
  }
  port.postMessage(reply);
});
