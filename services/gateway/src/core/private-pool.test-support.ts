// Import first, for its side effect: this test file's pool configs live in a private directory
// (FARMSLOT_POOL_DIR), never the checkout's shared <root>/pool. Test files run in parallel in one
// checkout, so a pool file one of them writes there shows up in every other file's slot lookups
// (an "allowed slot not found" in backlog/store.test.ts, for one). Write fixture pool files under
// poolDirectory() or `privatePool`; the test runner fails a run that adds anything to the shared
// pool directory. The private pool starts with the checkout's committed demo pools, which tests
// address by slot (demo-work-1, demo-ff-1, ...).
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after } from 'node:test';

const COMMITTED_POOLS = ['example.json', 'farmslot-demo.json'];
const checkoutPool = path.resolve(import.meta.dirname, '../../../../pool');

export const privatePool = mkdtempSync(path.join(tmpdir(), 'farmslot-pool-'));
for (const file of COMMITTED_POOLS)
  if (existsSync(path.join(checkoutPool, file)))
    copyFileSync(path.join(checkoutPool, file), path.join(privatePool, file));
process.env.FARMSLOT_POOL_DIR = privatePool;
after(() => rmSync(privatePool, { recursive: true, force: true }));
