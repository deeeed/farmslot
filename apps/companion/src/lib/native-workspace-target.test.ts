import assert from 'node:assert/strict';
import test from 'node:test';

import {
  nativeFileLocation,
  nativeFileRouteParams,
  nativeFileRouteTarget,
  nativeLinkedFileLocation,
} from './native-workspace-target';

const cwd = '/Users/me/repo';

test('file links resolve to a path in the session folder, with their line', () => {
  assert.deepEqual(nativeFileLocation('src/demo.ts:3', cwd), { path: 'src/demo.ts', line: 3 });
  assert.deepEqual(nativeFileLocation('./src/demo.ts#L12', cwd), { path: 'src/demo.ts', line: 12 });
  assert.deepEqual(nativeFileLocation('/Users/me/repo/notes/plan.md', cwd), {
    path: 'notes/plan.md',
  });
  assert.deepEqual(nativeFileLocation('<src/a b.ts:4:2>', cwd), { path: 'src/a b.ts', line: 4 });
});

test('links outside the folder, and web links, are not files of the session', () => {
  assert.equal(nativeFileLocation('/Users/me/other/x.ts', cwd), null);
  assert.equal(nativeFileLocation('../x.ts', cwd), null);
  assert.equal(nativeFileLocation('https://example.com/a.ts', cwd), null);
  assert.equal(nativeFileLocation('#heading', cwd), null);
});

test('route params round-trip, including the worker pin', () => {
  const worker = { runId: 'r', contextId: 'c', generation: 'g', leaseId: 'l' };
  const params = nativeFileRouteParams(
    { sessionId: 's', executionNodeId: 'local', cwd, worker },
    { path: 'src/demo.ts', line: 3 },
  );
  assert.deepEqual(nativeFileRouteTarget(params), {
    target: { sessionId: 's', executionNodeId: 'local', worker },
    cwd,
    location: { path: 'src/demo.ts', line: 3 },
  });
  assert.equal(nativeFileRouteTarget({ sessionId: 's', path: 'a.ts' }), null);
  assert.deepEqual(
    nativeFileRouteTarget({ sessionId: 's', executionNodeId: 'n', path: 'a.ts', line: 'x' })
      ?.location,
    { path: 'a.ts' },
  );
});

test('links inside an opened markdown file resolve like message links', () => {
  // An absolute path inside the session folder opens; one outside it does not.
  assert.deepEqual(
    nativeLinkedFileLocation('/Users/me/repo/src/demo.ts:32', 'notes/plan.md', cwd),
    {
      path: 'src/demo.ts',
      line: 32,
    },
  );
  assert.equal(nativeLinkedFileLocation('/Users/me/other/x.ts', 'notes/plan.md', cwd), null);
  // A relative link resolves against the linking file's folder, and may not leave the session.
  assert.deepEqual(nativeLinkedFileLocation('../src/demo.ts:32', 'notes/plan.md', cwd), {
    path: 'src/demo.ts',
    line: 32,
  });
  assert.deepEqual(nativeLinkedFileLocation('todo.md', 'notes/plan.md', cwd), {
    path: 'notes/todo.md',
  });
  assert.equal(nativeLinkedFileLocation('../../x.ts', 'notes/plan.md', cwd), null);
  // Without the session folder an absolute link cannot be placed.
  assert.equal(
    nativeLinkedFileLocation('/Users/me/repo/src/demo.ts', 'notes/plan.md', undefined),
    null,
  );
});
