/** Manual source-consumer proof. Writes only into the proof slot's separate cwd. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

const kind = process.argv[2];
assert.ok(['action', 'copy', 'health', 'control', 'watch', 'worker'].includes(kind));
assert.equal(basename(process.cwd()), 'source-proof-worktree');
const receiptPath = process.env.FARMSLOT_SOURCE_RECEIPT;
const digest = process.env.FARMSLOT_SOURCE_LOCK_DIGEST;
assert.ok(receiptPath && digest);
const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
assert.equal(receipt.lock.digest, digest);
assert.equal(receipt.receipt.lockDigest, digest);
assert.equal(process.env.FARMSLOT_SOURCE_PACK_ID, 'proof-pack');
assert.equal(
  receipt.roots['proof-pack'] + '/scripts/sources-validation/fixture/probe.mjs',
  new URL(import.meta.url).pathname,
);
const result = {
  kind,
  lockDigest: digest,
  nodeId: receipt.receipt.nodeId,
  commits: receipt.receipt.sources.map((source) => source.commit),
};
writeFileSync(`source-${kind}.json`, JSON.stringify(result) + '\n');
console.log(JSON.stringify(result));
