import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

import { canonicalResourceJson } from '../client-cache/keys.js';
import type { Run } from '../contracts/runs.js';

const encoder = new TextEncoder();

/** The portable version of a run.list row exactly as served by the gateway. */
export function runListVersion(row: Run): string {
  return bytesToHex(sha256(encoder.encode(canonicalResourceJson(row))));
}
