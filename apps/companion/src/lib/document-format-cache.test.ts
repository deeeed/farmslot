import assert from 'node:assert/strict';

import { formatDocument } from './document-format';
import { documentFormatCache } from './document-format-cache';

const format = documentFormatCache(2);
const plan = format('plan.md', '# Plan\n- one');
assert.deepEqual(plan, formatDocument('plan.md', '# Plan\n- one'));
// The same document returns the same blocks, so a memoized renderer can skip it.
assert.equal(format('plan.md', '# Plan\n- one'), plan);
// The title is part of the key: JSON and markdown parse the same body differently.
assert.notEqual(format('plan.json', '# Plan\n- one'), plan);

// Bounded: a third document evicts the least recently used one.
const lru = documentFormatCache(2);
const a = lru('a.md', 'a');
const b = lru('b.md', 'b');
assert.equal(lru('a.md', 'a'), a); // a is now the most recent
lru('c.md', 'c'); // evicts b
assert.equal(lru('a.md', 'a'), a);
assert.notEqual(lru('b.md', 'b'), b);
