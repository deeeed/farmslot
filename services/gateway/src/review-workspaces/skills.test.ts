import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  collectReviewWorkspaceSupport,
  type FrozenReviewWorkspaceSupport,
  type ReviewWorkspaceSupportConfig,
  reviewWorkspaceSupportEnvironment,
  verifyReviewWorkspaceSupport,
} from './skills.js';

const exec = promisify(execFile);
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'review-support-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = { projectConfig: path.join(root, 'pack/project.json') };
  await mkdir(path.dirname(project.projectConfig));
  const skill = path.join(root, 'skill');
  const library = path.join(root, 'library');
  const runtime = path.join(root, 'installed');
  await mkdir(path.join(skill, 'references'), { recursive: true });
  await mkdir(library);
  await mkdir(path.join(runtime, 'dist'), { recursive: true });
  await mkdir(path.join(runtime, 'node_modules/dependency'), { recursive: true });
  await writeFile(
    path.join(skill, 'skill.md'),
    '---\nname: source-name\n---\nCanonical instructions. Read references/rules.md.\n',
  );
  await writeFile(path.join(skill, 'references/rules.md'), 'Canonical source rule.\n');
  await writeFile(path.join(library, 'policy.md'), 'Library version one.\n');
  await writeFile(
    path.join(runtime, 'package.json'),
    JSON.stringify({
      name: '@example/review-runtime',
      version: '1.0.0',
      type: 'module',
      dependencies: { dependency: '1.0.0' },
    }),
  );
  await writeFile(
    path.join(runtime, 'node_modules/dependency/package.json'),
    JSON.stringify({ name: 'dependency', version: '1.0.0', main: 'index.js' }),
  );
  await writeFile(
    path.join(runtime, 'node_modules/dependency/index.js'),
    'module.exports = "offline dependency";\n',
  );
  await writeFile(
    path.join(runtime, 'dist/cli.js'),
    'import value from "dependency"; import fs from "node:fs"; console.log(JSON.stringify({value, library:fs.readFileSync(process.env.REVIEW_LIBRARY+"/policy.md","utf8"),args:process.argv.slice(2)}));\n',
  );
  const config: ReviewWorkspaceSupportConfig = {
    skills: [{ name: 'team-review', root: { env: 'REVIEW_SKILL' }, entry: 'skill.md' }],
    libraries: [{ name: 'team', root: { env: 'REVIEW_LIBRARY_SOURCE' } }],
    runtime: { name: 'review-tool', root: { env: 'REVIEW_RUNTIME' }, entry: 'dist/cli.js' },
    environment: { REVIEW_LIBRARY: '{{support}}/libraries/team' },
  };
  return {
    root,
    project,
    config,
    skill,
    library,
    runtime,
    env: { REVIEW_SKILL: skill, REVIEW_LIBRARY_SOURCE: library, REVIEW_RUNTIME: runtime },
  };
}
async function materialize(support: FrozenReviewWorkspaceSupport, target: string) {
  for (const file of support.files) {
    const absolute = path.join(target, file.relativePath);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, Buffer.from(file.contentBase64, 'base64'));
    await chmod(absolute, file.mode);
  }
}

test('frozen canonical skills, dependencies and library work offline after original sources disappear', async (t) => {
  const f = await fixture(t);
  const support = await collectReviewWorkspaceSupport(f.project, f.config, { env: f.env });
  const output = path.join(f.root, 'task/artifacts');
  const immutable = path.join(f.root, 'frozen support');
  await mkdir(output, { recursive: true });
  await materialize(support, immutable);
  assert.equal(
    await readFile(path.join(immutable, 'skills/team-review/SKILL.md'), 'utf8'),
    await readFile(path.join(f.skill, 'skill.md'), 'utf8'),
  );
  assert.equal(
    support.manifest.sources.find((source) => source.kind === 'runtime')?.packages?.length,
    2,
  );
  await Promise.all([
    rm(f.runtime, { recursive: true }),
    rm(f.library, { recursive: true }),
    rm(f.skill, { recursive: true }),
  ]);
  const environment = reviewWorkspaceSupportEnvironment(
    support,
    immutable,
    [output],
    process.env.PATH!,
  );
  const env = { ...process.env, ...environment.set };
  for (const key of environment.unset) delete env[key];
  const result = await exec(
    path.join(immutable, 'bin/review-tool'),
    ['checklist', '--out', path.join(output, 'checklist.md')],
    { env },
  );
  assert.deepEqual(JSON.parse(result.stdout), {
    value: 'offline dependency',
    library: 'Library version one.\n',
    args: ['checklist', '--out', path.join(output, 'checklist.md')],
  });
});

test('library changes and environment binding changes each produce a different immutable identity', async (t) => {
  const f = await fixture(t);
  const first = await collectReviewWorkspaceSupport(f.project, f.config, { env: f.env });
  const repeated = await collectReviewWorkspaceSupport(f.project, f.config, { env: f.env });
  assert.equal(first.manifest.sha256, repeated.manifest.sha256);
  await writeFile(path.join(f.library, 'policy.md'), 'Library version two.\n');
  const changed = await collectReviewWorkspaceSupport(f.project, f.config, { env: f.env });
  assert.notEqual(first.manifest.sha256, changed.manifest.sha256);
  assert.equal(
    Buffer.from(
      first.files.find((file) => file.relativePath === 'libraries/team/policy.md')!.contentBase64,
      'base64',
    ).toString(),
    'Library version one.\n',
  );
  const binding = await collectReviewWorkspaceSupport(
    f.project,
    { ...f.config, environment: { ...f.config.environment, MODE: 'other' } },
    { env: f.env },
  );
  assert.notEqual(binding.manifest.sha256, changed.manifest.sha256);
});

test('missing runtime dependencies fail closed instead of using an ancestor installation', async (t) => {
  const f = await fixture(t);
  await rm(path.join(f.runtime, 'node_modules/dependency'), { recursive: true });
  await mkdir(path.join(f.root, 'node_modules/dependency'), { recursive: true });
  await writeFile(
    path.join(f.root, 'node_modules/dependency/package.json'),
    '{"name":"dependency","version":"1.0.0"}',
  );
  await assert.rejects(
    collectReviewWorkspaceSupport(f.project, f.config, { env: f.env }),
    /dependency is missing/,
  );
});

test('symlink escapes, entry traversal and installer commands are refused before launch', async (t) => {
  const f = await fixture(t);
  await symlink(f.library, path.join(f.skill, 'external-library'));
  await assert.rejects(
    collectReviewWorkspaceSupport(f.project, f.config, { env: f.env }),
    /refuses symlinked/,
  );
  await rm(path.join(f.skill, 'external-library'));
  await assert.rejects(
    collectReviewWorkspaceSupport(
      f.project,
      { ...f.config, skills: [{ ...f.config.skills![0], entry: '../library/policy.md' }] },
      { env: f.env },
    ),
    /confined relative/,
  );
  await writeFile(path.join(f.runtime, 'install.sh'), '#!/bin/sh\nnpm install\n');
  await assert.rejects(
    collectReviewWorkspaceSupport(
      f.project,
      { ...f.config, runtime: { ...f.config.runtime!, entry: 'install.sh' } },
      { env: f.env },
    ),
    /compiled Node entry/,
  );
});

test('support configuration cannot redirect runtime loading or overlap writable outputs', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    collectReviewWorkspaceSupport(
      f.project,
      { ...f.config, environment: { NODE_OPTIONS: '--require /unfrozen.js' } },
      { env: f.env },
    ),
    /environment binding/,
  );
  await assert.rejects(
    collectReviewWorkspaceSupport(
      f.project,
      { ...f.config, libraries: [{ name: '../escape', root: { env: 'REVIEW_LIBRARY_SOURCE' } }] },
      { env: f.env },
    ),
    /safe names/,
  );
  await assert.rejects(
    collectReviewWorkspaceSupport(f.project, f.config, { env: {} }),
    /sources unavailable/,
  );
  const support = await collectReviewWorkspaceSupport(f.project, f.config, { env: f.env });
  assert.throws(
    () => reviewWorkspaceSupportEnvironment(support, '/task/inputs/support', ['/task'], '/usr/bin'),
    /separate from every writable/,
  );
  assert.throws(
    () => reviewWorkspaceSupportEnvironment(support, '/support', ['/support/output'], '/usr/bin'),
    /separate from every writable/,
  );
  assert.equal(
    reviewWorkspaceSupportEnvironment(support, '/immutable/support', ['/task'], '/usr/bin').set
      .GIT_CEILING_DIRECTORIES,
    '/immutable/support',
  );
});

test('persisted support detects byte, metadata and environment tampering', async (t) => {
  const f = await fixture(t);
  const original = await collectReviewWorkspaceSupport(f.project, f.config, { env: f.env });
  verifyReviewWorkspaceSupport(JSON.parse(JSON.stringify(original)), original.manifest.sha256);
  const changedBytes = structuredClone(original);
  changedBytes.files[0].contentBase64 = Buffer.from('tampered').toString('base64');
  assert.throws(
    () => verifyReviewWorkspaceSupport(changedBytes, original.manifest.sha256),
    /recorded bytes/,
  );
  const changedEnvironment = structuredClone(original);
  changedEnvironment.manifest.environment.REVIEW_LIBRARY = '/unfrozen';
  assert.throws(
    () => verifyReviewWorkspaceSupport(changedEnvironment, original.manifest.sha256),
    /manifest/,
  );
  const changedMode = structuredClone(original);
  changedMode.files[0].mode = 0o777;
  assert.throws(
    () => verifyReviewWorkspaceSupport(changedMode, original.manifest.sha256),
    /manifest/,
  );
  assert.throws(() => verifyReviewWorkspaceSupport(original, '0'.repeat(64)), /admitted digest/);
});
