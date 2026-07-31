import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { resolveNodeSupportPaths } from './paths.js';

const root = '/repo/farmslot';

test('farmslot farm declares remote prepare support and keeps sandbox lifecycle checkout-local', () => {
  const configPath = new URL('../../../../projects/farmslot-farm/project.json', import.meta.url);
  const projectJson = JSON.parse(readFileSync(configPath, 'utf8')) as Parameters<
    typeof resolveNodeSupportPaths
  >[1] & {
    prepare?: { profiles?: Record<string, { hooks?: Record<string, string> }> };
  };
  const result = resolveNodeSupportPaths('farmslot-farm', projectJson, root);

  for (const expectedPath of [
    'projects/farmslot-farm/project.json',
    'projects/farmslot-farm/setup',
    'scripts',
  ]) {
    assert.ok(result.paths.includes(expectedPath), `missing ${expectedPath}`);
  }
  assert.deepEqual(result.undeclaredHookPaths, []);

  const profiles = projectJson.prepare?.profiles;
  assert.match(profiles?.sandbox?.hooks?.preflight ?? '', /\{\{repo\}\}/);
  assert.doesNotMatch(profiles?.sandbox?.hooks?.preflight ?? '', /\{\{node_support_dir\}\}/);
  assert.doesNotMatch(profiles?.sandbox?.hooks?.preflight ?? '', /\{\{primary_repo\}\}/);
  assert.match(profiles?.['companion-warm']?.hooks?.preflight ?? '', /\{\{node_support_dir\}\}/);

  for (const hookName of ['health_check', 'dev_server_check', 'teardown'] as const) {
    assert.match(String(projectJson.hooks?.[hookName] ?? ''), /\{\{repo\}\}/);
    assert.doesNotMatch(String(projectJson.hooks?.[hookName] ?? ''), /\{\{primary_repo\}\}/);
  }
});

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

test('farm-side refs hidden behind project vars are inferred', () => {
  const result = resolveNodeSupportPaths(
    'example-browser-farm',
    {
      vars: {
        support_cmd:
          'bash {{farmslot_dir}}/projects/example-browser-farm/setup/preflight.sh {{slot_id}}',
      },
      hooks: {
        preflight: '{{support_cmd}}',
      },
    },
    root,
  );

  assert.deepEqual(result.paths, [
    'projects/example-browser-farm/project.json',
    'projects/example-browser-farm/setup',
    'scripts',
  ]);
});

test('repo-local project vars do not require node support', () => {
  const result = resolveNodeSupportPaths(
    'simple-farm',
    {
      vars: {
        test_cmd: 'yarn test',
      },
      hooks: {
        preflight: '{{test_cmd}}',
      },
    },
    root,
  );

  assert.deepEqual(result.paths, []);
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

test('cross-project hook refs bundle the referenced project support', () => {
  const result = resolveNodeSupportPaths(
    'example-browser-farm',
    {
      hooks: {
        post_merge_install:
          'bash {{farmslot_dir}}/projects/example-mobile-farm/scripts/ensure-skills-local.sh {{repo}}',
      },
    },
    root,
  );

  assert.deepEqual(result.paths, [
    'projects/example-mobile-farm/project.json',
    'projects/example-mobile-farm/scripts',
    'scripts',
  ]);
});

test('cross-project support can be declared explicitly', () => {
  const result = resolveNodeSupportPaths(
    'example-browser-farm',
    {
      node_support: {
        paths: ['projects/example-mobile-farm/scripts'],
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

test('prepare profile hook refs are included in node support inference', () => {
  const result = resolveNodeSupportPaths(
    'example-mobile-farm',
    {
      prepare: {
        profiles: {
          sandbox: {
            hooks: {
              preflight:
                'bash {{node_support_dir}}/projects/example-mobile-farm/scripts/preflight.sh',
            },
          },
        },
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

test('declared node support paths cannot escape the supported roots', () => {
  assert.throws(
    () =>
      resolveNodeSupportPaths(
        'example-mobile-farm',
        { node_support: { paths: ['../outside'] }, hooks: {} },
        root,
      ),
    /path escapes Farmslot/,
  );

  assert.throws(
    () =>
      resolveNodeSupportPaths(
        'example-mobile-farm',
        { node_support: { paths: ['/tmp/outside'] }, hooks: {} },
        root,
      ),
    /path must be relative/,
  );

  assert.throws(
    () =>
      resolveNodeSupportPaths(
        'example-mobile-farm',
        { node_support: { paths: ['unrelated/support'] }, hooks: {} },
        root,
      ),
    /expected scripts or projects\/<project>/,
  );
});

test('legacy hook inference rejects escaping project refs', () => {
  assert.throws(
    () =>
      resolveNodeSupportPaths(
        'example-mobile-farm',
        {
          hooks: {
            preflight: 'bash {{farmslot_dir}}/projects/example-mobile-farm/../../outside.sh',
          },
        },
        root,
      ),
    /path escapes Farmslot/,
  );

  assert.throws(
    () =>
      resolveNodeSupportPaths(
        'example-mobile-farm',
        {
          hooks: {
            preflight: 'bash {{farmslot_dir}}/projects/../pool/secret.sh',
          },
        },
        root,
      ),
    /path escapes Farmslot/,
  );

  assert.throws(
    () =>
      resolveNodeSupportPaths(
        'example-mobile-farm',
        {
          hooks: {
            preflight: 'bash /repo/farmslot/projects/other-farm/../../pool/secret.sh',
          },
        },
        root,
      ),
    /path escapes Farmslot/,
  );

  assert.throws(
    () =>
      resolveNodeSupportPaths(
        'example-mobile-farm',
        {
          hooks: {
            preflight: 'cd {{farmslot_dir}}/projects/other-farm',
          },
        },
        root,
      ),
    /Invalid hook support reference in example-mobile-farm: .*expected projects\/<project>/,
  );
});
