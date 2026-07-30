import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FAST_REPO_STEPS,
  FAST_TARGETS,
  filterMatches,
  PATH_FILTERS,
  pathMatches,
  selectTargets,
  stepsForTarget,
  TARGET_STEPS,
} from './lib/path-filters.mjs';

test('directory globs match the directory itself and its descendants only', () => {
  assert.equal(pathMatches('services/gateway', 'services/gateway/**'), true);
  assert.equal(pathMatches('services/gateway/src/server.ts', 'services/gateway/**'), true);
  assert.equal(pathMatches('services/gateway-extra/src/a.ts', 'services/gateway/**'), false);
  assert.equal(pathMatches('services/node/src/a.ts', 'services/gateway/**'), false);
});

test('exact patterns do not match by prefix and `**` matches everything', () => {
  assert.equal(pathMatches('package.json', 'package.json'), true);
  assert.equal(pathMatches('apps/command-center/package.json', 'package.json'), false);
  assert.equal(pathMatches('anything/at/all.txt', '**'), true);
});

test('filterMatches is true when any changed file hits any pattern', () => {
  assert.equal(filterMatches(['docs/README.md'], PATH_FILTERS.gateway), false);
  assert.equal(
    filterMatches(['docs/README.md', 'services/gateway/src/server.ts'], PATH_FILTERS.gateway),
    true,
  );
});

test('a gateway change selects exactly the targets that depend on it', () => {
  const { matched } = selectTargets(['services/gateway/src/server.ts'], { full: true });
  assert.deepEqual(matched, ['repo', 'command_center', 'docs', 'gateway']);
});

test('an unaffected file selects only the repo-wide target', () => {
  const { matched } = selectTargets(['docs/ROADMAP.md'], { full: true });
  assert.deepEqual(matched, ['repo']);
});

test('selection is deterministic and order-independent for the same change set', () => {
  const files = ['packages/protocol/src/types.ts', 'apps/companion/src/App.tsx'];
  const first = selectTargets(files, { full: true });
  const second = selectTargets([...files].reverse(), { full: true });
  assert.deepEqual(first, second);
  assert.deepEqual(first, selectTargets(files, { full: true }));
  assert.deepEqual(first.matched, [
    'repo',
    'command_center',
    'companion',
    'docs',
    'cli',
    'expo_recipe',
    'protocol',
    'recipe_harness',
    'gateway',
    'node',
  ]);
});

test('fast mode runs only the fast targets and defers the rest to CI', () => {
  const files = ['services/gateway/src/server.ts'];
  const fast = selectTargets(files);
  assert.deepEqual(fast.active, ['repo']);
  assert.deepEqual(fast.skipped, ['command_center', 'docs', 'gateway']);

  const full = selectTargets(files, { full: true });
  assert.deepEqual(full.active, full.matched);
  assert.deepEqual(full.skipped, []);
});

test('an empty change set selects nothing', () => {
  assert.deepEqual(selectTargets([]), { matched: [], active: [], skipped: [] });
});

test('the repo target trades full steps for the cheap meta gates in fast mode', () => {
  assert.deepEqual(stepsForTarget('repo'), FAST_REPO_STEPS);
  assert.deepEqual(stepsForTarget('repo', { full: true }), TARGET_STEPS.repo);
  assert.ok(
    stepsForTarget('repo').length < TARGET_STEPS.repo.length,
    'the fast lane must be a strict subset of the full repo lane',
  );
  assert.deepEqual(stepsForTarget('gateway'), TARGET_STEPS.gateway);
  assert.deepEqual(stepsForTarget('unknown-target'), []);
});

test('every path-filter target has runnable steps and fast targets exist', () => {
  for (const target of Object.keys(PATH_FILTERS)) {
    const steps = TARGET_STEPS[target];
    assert.ok(Array.isArray(steps) && steps.length > 0, `${target} has no steps`);
    for (const [label, command] of steps) {
      assert.ok(typeof label === 'string' && label.length > 0);
      assert.ok(Array.isArray(command) && command.length > 0, `${target}/${label} needs a command`);
    }
  }
  for (const target of FAST_TARGETS) {
    assert.ok(target in PATH_FILTERS, `fast target ${target} is not a declared path filter`);
  }
});
