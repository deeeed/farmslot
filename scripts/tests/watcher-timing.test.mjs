import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// FSR-09: regressions in these watcher fixtures must advance a test clock or await events.
test('watcher regressions do not wait out the Chokidar coalescer', async () => {
  for (const file of [
    'services/gateway/src/resources/configuration-changes.test.ts',
    'services/gateway/src/resources/fleet-writer-publication.test.ts',
    'services/gateway/src/fleet/status-bindings.test.ts',
    'services/gateway/src/tasks/watcher-subtask.test.ts',
    'scripts/tests/darwin-file-watch.test.mjs',
  ]) {
    const source = await readFile(new URL('../../' + file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /(?:delay|setTimeout)\s*\([^\n]*\b60\b/, file);
  }
});
