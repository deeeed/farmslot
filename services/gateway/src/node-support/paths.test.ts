import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveNodeSupportPaths } from './paths.js';

const root = '/repo/farmslot';

test('simple project with repo-local hooks needs no node support', () => {
  const result = resolveNodeSupportPaths(
    'simple-farm',
    {
      hooks: {
        preflight: 'yarn install && yarn dev',
        health_check: 'curl -fsS http://localhost:3000/health',
      },
    },
    root,
  );

  assert.deepEqual(result.paths, []);
  assert.deepEqual(result.undeclaredHookPaths, []);
});

test('declared node support paths are normalized and include root scripts for project support', () => {
  const result = resolveNodeSupportPaths(
    'example-mobile-farm',
    {
      node_support: {
        paths: [
          'projects/example-mobile-farm/scripts/',
          'projects/example-mobile-farm/project.json',
        ],
      },
      hooks: {},
    },
    root,
  );

  assert.deepEqual(result.declaredPaths, [
    'projects/example-mobile-farm/project.json',
    'projects/example-mobile-farm/scripts',
    'scripts',
  ]);
  assert.deepEqual(result.paths, result.declaredPaths);
});

test('legacy farmslot_dir hook refs are inferred for migration', () => {
  const result = resolveNodeSupportPaths(
    'example-browser-farm',
    {
      hooks: {
        preflight:
          'bash {{farmslot_dir}}/projects/example-browser-farm/setup/preflight.sh {{slot_id}}',
      },
    },
    root,
  );

  assert.deepEqual(result.paths, [
    'projects/example-browser-farm/project.json',
    'projects/example-browser-farm/setup',
    'scripts',
  ]);
  assert.deepEqual(result.undeclaredHookPaths, result.paths);
});

test('explicit declarations cover legacy hook refs', () => {
  const result = resolveNodeSupportPaths(
    'example-browser-farm',
    {
      node_support: {
        paths: ['projects/example-browser-farm/setup'],
      },
      hooks: {
        preflight:
          'bash {{farmslot_dir}}/projects/example-browser-farm/setup/preflight.sh {{slot_id}}',
      },
    },
    root,
  );

  assert.deepEqual(result.undeclaredHookPaths, []);
});

test('node_support_dir hook refs require the same explicit coverage', () => {
  const result = resolveNodeSupportPaths(
    'example-mobile-farm',
    {
      hooks: {
        preflight:
          'bash {{node_support_dir}}/projects/example-mobile-farm/scripts/preflight.sh {{repo}}',
      },
    },
    root,
  );

  assert.deepEqual(result.undeclaredHookPaths, [
    'projects/example-mobile-farm/project.json',
    'projects/example-mobile-farm/scripts',
    'scripts',
  ]);
});
