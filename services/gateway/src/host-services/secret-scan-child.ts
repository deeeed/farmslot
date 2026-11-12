// host-services/secret-scan-child.ts — the publication secret scan process the gateway forks.
// It runs under the gateway's own loader (fork inherits execArgv), so the scanner resolves here
// exactly as in the gateway. It holds only the scanner: a small module graph and a small RSS.
import { createHash } from 'node:crypto';

import { scanForFloorSecrets } from '@farmslot/handoff/scrub';

import { isPublicationScanRequest, type PublicationScanReply } from './secret-scan-protocol.js';

// Repeated publication checks still validate frozen bytes. Cache only clean
// text hashes to avoid rescanning the same immutable logs at each boundary.
const cleanTextHashes = new Set<string>();
const MAX_CLEAN_TEXT_HASHES = 256;

function firstSecretHits(texts: string[]) {
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

const send = process.send?.bind(process);
if (!send) throw new Error('The publication secret scanner runs only as a forked gateway child.');
// The gateway is gone: nothing is left to scan for.
process.on('disconnect', () => process.exit(0));
process.on('message', (message: unknown) => {
  // A request without a usable id cannot be answered; the gateway refuses its scans on the exit.
  if (!isPublicationScanRequest(message)) process.exit(2);
  let reply: PublicationScanReply;
  try {
    reply = { id: message.id, hits: firstSecretHits(message.texts) };
  } catch (error) {
    // The gateway refuses publication on this reply, as it did on a thrown scan error.
    reply = { id: message.id, error: error instanceof Error ? error.message : String(error) };
  }
  send(reply);
});
