import assert from 'node:assert/strict';
import test from 'node:test';

import { FakeControllerHost } from '../../testing/fake-controller-host.js';
import { litText } from '../../testing/lit-text.js';
import { readHideTestsPref, writeHideTestsPref } from '../../utils/diff-test-filter.js';

import { DiffTestFilterController } from './diff-test-filter-controller.js';

const files = [
  { path: 'src/app.ts', additions: 4, deletions: 1 },
  { path: 'src/app.test.ts', additions: 9, deletions: 0 },
  { path: 'src/test-utils/render.ts', additions: 3, deletions: 0 },
  { path: 'src/stamped.ts', additions: 1, deletions: 0, kind: 'test' as const },
];

function controlsText(filter: DiffTestFilterController): string {
  return litText(filter.renderControls(filter.split(files).summary)).replace(/\s+/g, ' ');
}

test('a connected filter follows the shared preference and hands off through onChange', () => {
  const initial = readHideTestsPref();
  const host = new FakeControllerHost();
  let changes = 0;
  const filter = new DiffTestFilterController(host, {
    onChange: () => {
      changes += 1;
    },
  });
  assert.equal(host.controllers.length, 1, 'the controller registers itself');

  try {
    host.connect();
    writeHideTestsPref(!initial);
    assert.equal(filter.hideTests, !initial);
    assert.equal(host.updates, 1);
    assert.equal(changes, 1);

    host.disconnect();
    writeHideTestsPref(initial);
    assert.equal(filter.hideTests, !initial, 'a disconnected host stops listening');
    assert.equal(changes, 1);

    host.connect();
    assert.equal(filter.hideTests, initial, 'reconnecting re-reads the preference');
    filter.toggle();
    assert.equal(readHideTestsPref(), !initial);
    assert.equal(filter.hideTests, !initial);
  } finally {
    host.disconnect();
    writeHideTestsPref(initial);
  }
});

test('split hides stamped and matched tests, keeps the pinned path and counts what is left', () => {
  const filter = new DiffTestFilterController(new FakeControllerHost());
  filter.hideTests = false;
  assert.equal(filter.split(files).visible.length, 4);

  filter.hideTests = true;
  const split = filter.split(files);
  assert.deepEqual(
    split.visible.map((file) => file.path),
    ['src/app.ts', 'src/test-utils/render.ts'],
  );
  assert.equal(split.hiddenCount, 2);
  assert.equal(split.visibleAdditions, 7);
  assert.deepEqual(
    filter.split(files, 'src/app.test.ts').visible.map((file) => file.path),
    ['src/app.ts', 'src/app.test.ts', 'src/test-utils/render.ts'],
  );
});

test('the project test globs decide for unstamped files', () => {
  let patterns: readonly string[] | null = ['**/test-utils/**'];
  const filter = new DiffTestFilterController(new FakeControllerHost(), {
    patterns: () => patterns,
  });
  filter.hideTests = true;
  assert.deepEqual(
    filter.split(files).visible.map((file) => file.path),
    ['src/app.ts', 'src/app.test.ts'],
    'only the project glob applies; the stamped kind still wins',
  );
  assert.equal(filter.hides('pkg/test-utils/a.ts'), true);
  assert.equal(filter.hides('src/app.test.ts'), false);

  const first = filter.matcher;
  assert.equal(filter.matcher, first, 'the matcher is reused while the globs are unchanged');
  patterns = null;
  assert.equal(filter.hides('src/app.test.ts'), true, 'no project globs: the defaults apply');

  filter.hideTests = false;
  assert.equal(filter.hides('src/app.test.ts'), false, 'nothing is hidden while tests show');
});

test('renderControls offers hide/show with the test count, and nothing without tests', () => {
  const filter = new DiffTestFilterController(new FakeControllerHost());
  filter.hideTests = false;
  assert.match(controlsText(filter), /2 test files · 56% of lines/);
  assert.match(controlsText(filter), /Hide tests/);

  filter.hideTests = true;
  assert.match(controlsText(filter), /Show tests \(2\)/);

  assert.equal(litText(filter.renderControls(filter.split([files[0]]).summary)), '');
});
