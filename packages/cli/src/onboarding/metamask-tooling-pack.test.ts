import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { type RawProjectJson, validateRuntimeCapabilitiesConfig } from '@farmslot/slot-config';

import { projectName, projectShortName, validatePackDir } from './pack.js';

const { lintWorkerTemplateStructure } = createRequire(import.meta.url)(
  '@farmslot/agent-runtime/scripts/worker-terminal-contract.cjs',
) as { lintWorkerTemplateStructure: (content: string) => string[] };

const pack = fileURLToPath(new URL('../../../../packs/metamask-tooling/', import.meta.url));
const PROJECTS = ['metamask-harness-farm', 'metamask-recipe-perps-farm'] as const;
const SHARED_FILES = ['scripts/tooling.sh', 'scripts/resolve-harness.mjs', 'setup/ios.sh'];

function readProject(name: string): RawProjectJson {
  return JSON.parse(readFileSync(join(pack, 'projects', name, 'project.json'), 'utf8'));
}

function scratch(t: test.TestContext, prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function tooling(args: string[], env: Record<string, string> = {}) {
  return spawnSync('bash', [join(pack, 'projects', PROJECTS[0], 'scripts/tooling.sh'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 4000,
  });
}

test('the tooling pack passes real onboarding validation without operator pool configuration', () => {
  const result = validatePackDir(pack, join(tmpdir(), 'metamask-tooling-no-operator-pool'));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.pack?.projects.map(projectName), [...PROJECTS]);
  assert.deepEqual(result.pack?.projects.map(projectShortName), ['mmh', 'mmrp']);
  assert.ok(result.pack?.projects.every((project) => project.platform === 'ios'));
});

test('each project validates its runtime capabilities and declares a QA profile', () => {
  for (const name of PROJECTS) {
    const project = readProject(name);
    assert.doesNotThrow(() => validateRuntimeCapabilitiesConfig(project, `${name}/project.json`));
    assert.equal(project.qa?.profiles[0]?.template_id, 'qa/tooling');
  }
});

test('each project owns a distinct sibling Mobile checkout and never names a product farm slot', () => {
  const mobile = PROJECTS.map((name) => readProject(name).reference_repos?.mobile?.local_name);
  assert.deepEqual(mobile, ['mmh-mobile', 'mmrp-mobile']);
  for (const name of PROJECTS) {
    const text = readFileSync(join(pack, 'projects', name, 'project.json'), 'utf8');
    assert.doesNotMatch(text, /metamask-mobile-farm|metamask-mobile-\d|-mm-\d/);
    assert.match(text, /"mobile-runtime"[\s\S]*\{\{mobile_repo\}\}/);
  }
});

test('project commands use the support root every lifecycle path expands', () => {
  // Onboarding's bash lifecycle, resources and slot actions expand farmslot_dir;
  // gateway prepare remaps it to the node bundle. node_support_dir is not expanded there.
  for (const name of PROJECTS) {
    const text = readFileSync(join(pack, 'projects', name, 'project.json'), 'utf8');
    assert.doesNotMatch(text, /node_support_dir/i);
    assert.match(
      text,
      new RegExp(`\\{\\{farmslot_dir\\}\\}/projects/${name}/scripts/tooling\\.sh`),
    );
  }
});

test('marking and runtimes use the published provider and a pinned library, not the slot checkout', () => {
  for (const name of PROJECTS) {
    const recipe = readProject(name).recipe;
    assert.deepEqual(recipe?.provider.root, { env: 'MM_HARNESS_PACKAGE_ROOT' });
    assert.equal(recipe?.provider.package, '@deeeed/metamask-harness');
    assert.match(recipe?.libraries?.[0]?.revision ?? '', /^[0-9a-f]{40}$/);
  }
});

test('the shared lifecycle scripts are identical in both projects', () => {
  for (const file of SHARED_FILES) {
    const [first, second] = PROJECTS.map((name) =>
      readFileSync(join(pack, 'projects', name, file), 'utf8'),
    );
    assert.equal(second, first, file);
  }
});

test('worker templates keep the generated TASK.md out and name the explicit candidate', () => {
  for (const name of PROJECTS) {
    for (const flow of ['dev', 'fix-bug', 'qa']) {
      const content = readFileSync(
        join(pack, 'projects', name, 'templates/worker', `${flow}.md`),
        'utf8',
      );
      assert.deepEqual(lintWorkerTemplateStructure(content), [], `${name} ${flow}`);
      assert.match(content, /\[DETERMINISTIC: ci\.local_check\]/);
      assert.match(content, /\{\{MOBILE_REPO\}\}/);
      assert.match(
        content,
        name === PROJECTS[0] ? /\{\{REPO\}\}\/bin\/mm-harness run/ : /--library perps=\{\{REPO\}\}/,
      );
    }
  }
});

test('the resolver refuses a harness root inside the slot checkout', (t) => {
  const root = scratch(t, 'mt-resolver-');
  const checkout = join(root, 'checkout');
  const harness = join(checkout, 'harness');
  mkdirSync(join(harness, 'bin'), { recursive: true });
  writeFileSync(
    join(harness, 'package.json'),
    JSON.stringify({ name: '@deeeed/metamask-harness', bin: { 'mm-harness': 'bin/mm-harness' } }),
  );
  writeFileSync(join(harness, 'bin/mm-harness'), '#!/bin/sh\n', { mode: 0o755 });
  const resolver = join(pack, 'projects', PROJECTS[0], 'scripts/resolve-harness.mjs');
  const run = (env: string, target: string) =>
    spawnSync(process.execPath, [resolver, '--published', target], {
      encoding: 'utf8',
      env: { ...process.env, MM_HARNESS_PACKAGE_ROOT: env },
      timeout: 4000,
    });
  const inside = run(harness, checkout);
  assert.equal(inside.status, 1);
  assert.match(inside.stderr, /not the slot checkout/);
  mkdirSync(join(root, 'other'));
  const published = run(harness, join(root, 'other'));
  assert.equal(published.status, 0, published.stderr);
  assert.match(published.stdout, /bin\/mm-harness$/);
});

test('lifecycle commands refuse a missing, unexpanded or self-referencing Mobile checkout', (t) => {
  const root = scratch(t, 'mt-mobile-');
  const repo = join(root, 'mmh-1');
  mkdirSync(join(repo, '.git'), { recursive: true });
  const bin = join(root, 'bin');
  mkdirSync(bin);
  // A stand-in for the configured Node 22 directory; the router checks the major version.
  symlinkSync(process.execPath, join(bin, 'node'));
  const env = { FARMSLOT_NODE22_BIN: bin };
  const major = process.versions.node.split('.')[0];
  const boot = (mobile: string) =>
    tooling(['mobile-boot', 'harness', repo, mobile, '9400', 'mmh-1', 'slot', root], env);
  if (major !== '22') {
    assert.match(boot(join(root, 'mmh-mobile')).stderr, /Node 22 is required/);
    return;
  }
  assert.match(boot('').stderr, /no owned Mobile checkout/);
  assert.match(boot('{{mobile_repo}}').stderr, /no owned Mobile checkout/);
  assert.match(boot(join(root, 'mmh-mobile')).stderr, /owned Mobile checkout is missing/);
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'metamask' }));
  assert.match(boot(repo).stderr, /must not be the tooling checkout/);
  mkdirSync(join(root, 'other'));
  writeFileSync(join(root, 'other/package.json'), JSON.stringify({ name: 'not-metamask' }));
  assert.match(boot(join(root, 'other')).stderr, /is not a MetaMask Mobile checkout/);
});

test('a second slot of the same project cannot claim or stop another slot Mobile checkout', (t) => {
  if (process.versions.node.split('.')[0] !== '22') return;
  const root = scratch(t, 'mt-owner-');
  const repo = join(root, 'mmh-2');
  mkdirSync(join(repo, '.git'), { recursive: true });
  const mobile = join(root, 'mmh-mobile');
  mkdirSync(join(mobile, 'temp/recipe/runtime'), { recursive: true });
  writeFileSync(join(mobile, 'package.json'), JSON.stringify({ name: 'metamask' }));
  writeFileSync(
    join(mobile, 'temp/recipe/runtime/farmslot-owner'),
    'metamask-harness-farm/mini-mmh-1\n',
  );
  const fixture = join(root, 'wallet-fixture.json');
  writeFileSync(fixture, '{}');
  const bin = join(root, 'bin');
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, 'node'));
  // A published harness outside the slot checkout; refusals happen before it runs.
  const harness = join(root, 'published');
  mkdirSync(join(harness, 'bin'), { recursive: true });
  writeFileSync(
    join(harness, 'package.json'),
    JSON.stringify({ name: '@deeeed/metamask-harness', bin: { 'mm-harness': 'bin/mm-harness' } }),
  );
  writeFileSync(join(harness, 'bin/mm-harness'), '#!/bin/sh\necho ran "$@"\n', { mode: 0o755 });
  const env = { FARMSLOT_NODE22_BIN: bin, MM_HARNESS_PACKAGE_ROOT: harness };
  const fixtureRun = tooling(
    ['mobile-fixture', 'harness', repo, mobile, fixture, 'mini-mmh-2'],
    env,
  );
  assert.equal(fixtureRun.status, 1);
  assert.match(fixtureRun.stderr, /owned by metamask-harness-farm\/mini-mmh-1/);
  const stop = tooling(['mobile-stop', 'harness', repo, mobile, '9400', 'sim', 'mini-mmh-2'], env);
  assert.equal(stop.status, 0, stop.stderr);
  assert.match(stop.stdout, /nothing to stop/);
  assert.doesNotMatch(stop.stdout, /^ran /m);
  const owner = tooling(['mobile-stop', 'harness', repo, mobile, '9400', 'sim', 'mini-mmh-1'], env);
  assert.equal(owner.status, 0, owner.stderr);
  assert.match(owner.stdout, /^ran stop --adapter mobile --port 9400/m);
});

test('teardown without an owned Mobile checkout stops nothing and succeeds', (t) => {
  const root = scratch(t, 'mt-teardown-');
  const repo = join(root, 'mmrp-1');
  mkdirSync(join(repo, '.git'), { recursive: true });
  const result = tooling([
    'mobile-stop',
    'recipe-perps',
    repo,
    join(root, 'mmrp-mobile'),
    '9400',
    'mmrp-1',
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no owned Mobile checkout to stop/);
});

test('the candidate selection names the slot checkout explicitly for each project', (t) => {
  const root = scratch(t, 'mt-candidate-');
  const repo = join(root, 'tool');
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(join(repo, 'bin'));
  writeFileSync(join(repo, 'bin/mm-harness'), '#!/bin/sh\n', { mode: 0o755 });
  writeFileSync(join(repo, 'recipe-library.json'), '{}');
  const real = spawnSync('pwd', ['-P'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
  assert.equal(
    tooling(['candidate', 'harness', repo]).stdout,
    `MM_HARNESS_CANDIDATE=${real}/bin/mm-harness\n`,
  );
  assert.equal(
    tooling(['candidate', 'recipe-perps', repo]).stdout,
    `RECIPE_LIBRARY_CANDIDATE=perps=${real}\n`,
  );
});
