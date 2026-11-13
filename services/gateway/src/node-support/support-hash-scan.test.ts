import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

// Counts the legacy path lookups one support-hash scan makes.
let legacyLookups = 0;
const farmPaths = await import('@farmslot/protocol/node/farm-paths');
mock.module('@farmslot/protocol/node/farm-paths', {
  namedExports: {
    ...farmPaths,
    legacyRemoteFarmPaths: (...args: Parameters<typeof farmPaths.legacyRemoteFarmPaths>) => {
      legacyLookups++;
      return farmPaths.legacyRemoteFarmPaths(...args);
    },
  },
});
const { makeRun } = await import('../run-engine/test-fixtures.js');
const { referencedNodeSupportHashes } = await import('./activation.js');

test('one support-hash scan looks up the legacy support root once, however many strings it reads', () => {
  const hash = (index: number) => index.toString(16).padStart(64, '0');
  const runs = Array.from({ length: 200 }, (_, index) =>
    makeRun({
      id: `run-${index}`,
      steps: [
        {
          name: 'prepare',
          status: 'done',
          outputs: {
            legacy: `cd ~/farmslot-node/support/${hash(index)}/bin`,
            current: `/farm/support/${hash(index + 1000)}`,
            note: 'no support path here',
          },
        },
      ],
    }),
  );
  legacyLookups = 0;
  const hashes = referencedNodeSupportHashes(runs, '/farm/support');
  assert.equal(legacyLookups, 1);
  assert.equal(hashes.length, 400, 'both roots still match in every run');
  assert.ok(hashes.includes(hash(0)) && hashes.includes(hash(1199)));
});
