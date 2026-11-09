import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  RUNNER_OBSERVABILITY_SOURCE_FILES,
  verifySupportBundle,
} from '../../../../scripts/lib/runner-observability-bundle.mjs';

import { runLaunchPreflight } from './worker-preflight.js';
import { expected, probe } from './worker-source-preflight.test-support.js';

test('selected CLI package mismatch warns without retrying or refusing launch', async () => {
  const value = await expected();
  value.cliVersion = '0.0.0-fixture';
  const result = await probe(value);
  assert.equal(result.status, 'unverified');
  assert.equal(result.retry, false);
  assert.match(result.detail, /Package version warning/);
  assert.match(result.detail, /CLI resolved .*expected 0.0.0-fixture/);
  await runLaunchPreflight([{ name: 'code', inspect: async () => result }], {
    assertCurrent() {},
    record() {},
    wait: async () => assert.fail('A package-version warning must not retry'),
  });
});

test('the selected CLI reports its actual wire declaration for gateway comparison', async () => {
  const value = await expected();
  value.cliVersion = '0.0.0-fixture';
  const result = await probe(value);
  assert.notEqual(result.status, 'mismatch');
  assert.equal(typeof result.peerVersions?.protocolVersion, 'string');
  assert.equal(typeof result.peerVersions?.minimumProtocolVersion, 'string');
});

test('a legacy task with no retained source binding remains explicitly unverified', async () => {
  const result = await probe(await expected());
  assert.equal(result.status, 'unverified');
  assert.equal(result.retry, false);
  assert.match(result.detail, /No retained task source receipt/);
});

for (const validReceipt of [true, false]) {
  test(`protocol 0.77.2 versus 0.77.1 warns and still checks ${validReceipt ? 'valid' : 'invalid'} retained provenance`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'worker-source-version-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const protocol = path.join(root, 'node_modules/@farmslot/protocol');
    const runtime = path.join(root, 'runtime');
    const taskDir = path.join(root, 'task');
    for (const dir of [protocol, path.join(runtime, 'dist'), path.join(taskDir, 'artifacts')])
      await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ name: '@farmslot/cli', version: '0.3.0' }),
    );
    const cli = path.join(root, 'cli.mjs');
    await writeFile(cli, '');
    await writeFile(
      path.join(protocol, 'package.json'),
      JSON.stringify({
        name: '@farmslot/protocol',
        version: '0.77.2',
        type: 'module',
        main: 'index.js',
      }),
    );
    await writeFile(
      path.join(protocol, 'index.js'),
      "export const PROTOCOL_VERSION = '0.77.2'; export const MINIMUM_PROTOCOL_VERSION = '0.76.0';\n",
    );
    await writeFile(
      path.join(runtime, 'package.json'),
      JSON.stringify({
        name: '@farmslot/agent-runtime',
        version: '0.42.0',
        minimumRuntimeVersion: '0.42.0',
        type: 'module',
      }),
    );
    await writeFile(
      path.join(runtime, 'dist/index.js'),
      `
import { writeFileSync } from 'node:fs';
export function verifyTaskExecutionProvenance(taskDir, binding) {
  writeFileSync(taskDir + '/verified.json', JSON.stringify(binding));
  ${validReceipt ? '' : "throw Object.assign(new Error('Retained input changed'), { code: 'TASK_PROVENANCE_INVALID', exitCode: 5 });"}
}
`,
    );
    const identity = { runId: 'retained-run' };
    await writeFile(
      path.join(taskDir, 'artifacts/harness-provenance.json'),
      JSON.stringify({ bindingIdentity: identity }),
    );
    const value = await expected();
    Object.assign(value, {
      cliVersion: '0.3.0',
      protocolVersion: '0.77.1',
      taskDir,
      runtimeScript: path.join(runtime, 'scripts/task-init-cli.mjs'),
    });
    const result = await probe(value, cli);
    assert.deepEqual(
      JSON.parse(await readFile(path.join(taskDir, 'verified.json'), 'utf8')),
      identity,
    );
    assert.match(result.detail, /protocol package resolved 0.77.2; expected 0.77.1/);
    if (validReceipt) {
      assert.equal(result.status, 'verified');
      assert.match(result.detail, /retained pack\/template\/library bytes match/);
    } else {
      assert.equal(result.status, 'mismatch');
      assert.match(result.detail, /TASK_PROVENANCE_INVALID/);
    }
  });
}

// ADR-049 Amendment 3: the Code drift probe re-checks the frozen required skill set.
async function requiredSkillsFixture(
  t: import('node:test').TestContext,
  options: { runtimeChecks: boolean; requiredSkills?: unknown; check?: unknown },
) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'worker-source-skills-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = path.join(root, 'runtime');
  const taskDir = path.join(root, 'repo/temp/tasks/dev/run');
  for (const dir of [
    path.join(runtime, 'dist'),
    path.join(taskDir, 'artifacts'),
    path.join(taskDir, 'inputs'),
  ])
    await mkdir(dir, { recursive: true });
  const real = await expected();
  await writeFile(
    path.join(runtime, 'package.json'),
    JSON.stringify({
      name: '@farmslot/agent-runtime',
      version: '0.45.0',
      minimumRuntimeVersion: '0.42.0',
      type: 'module',
    }),
  );
  await writeFile(
    path.join(runtime, 'dist/index.js'),
    `import { writeFileSync } from 'node:fs';
export function verifyTaskExecutionProvenance() {}
${options.runtimeChecks ? `export function checkRequiredSkills(repo, set) { writeFileSync(${JSON.stringify(path.join(root, 'checked.json'))}, JSON.stringify({ repo, set })); return ${JSON.stringify(options.check)}; }` : ''}
`,
  );
  await writeFile(
    path.join(taskDir, 'artifacts/harness-provenance.json'),
    JSON.stringify({ bindingIdentity: null }),
  );
  await writeFile(
    path.join(taskDir, 'inputs/handoff.json'),
    JSON.stringify({
      schemaVersion: 1,
      ...(options.requiredSkills ? { requiredSkills: options.requiredSkills } : {}),
    }),
  );
  const value = {
    ...real,
    taskDir,
    repoRoot: path.join(root, 'repo'),
    runtimeScript: path.join(runtime, 'scripts/task-init-cli.mjs'),
  };
  return { root, value };
}

const frozenSet = {
  schemaVersion: 1,
  selection: { flow: 'dev', platform: 'ios', domain: '' },
  rules: ['mobile-testing'],
  skills: [
    {
      name: 'mms-mobile-testing',
      rules: ['mobile-testing'],
      files: [{ path: '.agents/skills/mms-mobile-testing/SKILL.md', sha256: 'c'.repeat(64) }],
    },
  ],
};

test('a removed required skill file is a code mismatch that refuses launch', async (t) => {
  const { root, value } = await requiredSkillsFixture(t, {
    runtimeChecks: true,
    requiredSkills: frozenSet,
    check: {
      status: 'missing',
      missing: [
        {
          skill: 'mms-mobile-testing',
          path: '.agents/skills/mms-mobile-testing/SKILL.md',
          reason: 'missing',
        },
      ],
    },
  });
  const result = await probe(value);
  assert.equal(result.status, 'mismatch');
  assert.match(
    result.detail,
    /Required skill mms-mobile-testing: \.agents\/skills\/mms-mobile-testing\/SKILL\.md is missing/,
  );
  assert.deepEqual(JSON.parse(await readFile(path.join(root, 'checked.json'), 'utf8')), {
    repo: value.repoRoot,
    set: frozenSet,
  });
});

test('frozen required skills that still match their digests verify', async (t) => {
  const { value } = await requiredSkillsFixture(t, {
    runtimeChecks: true,
    requiredSkills: frozenSet,
    check: { status: 'pass', missing: [] },
  });
  const result = await probe(value);
  assert.equal(result.status, 'verified');
});

test('an older runtime that cannot check a frozen required set stays unverified', async (t) => {
  const { value } = await requiredSkillsFixture(t, {
    runtimeChecks: false,
    requiredSkills: frozenSet,
  });
  const result = await probe(value);
  assert.equal(result.status, 'unverified');
  assert.equal(result.retry, false);
  assert.match(result.detail, /cannot check the frozen required skill set/);
});

test('a task without a required skill set verifies as before', async (t) => {
  const { value } = await requiredSkillsFixture(t, { runtimeChecks: false });
  const plain = await probe(value);
  assert.equal(plain.status, 'verified', plain.detail);
});

test('an invalid frozen required skill record is a mismatch', async (t) => {
  const { value } = await requiredSkillsFixture(t, {
    runtimeChecks: true,
    requiredSkills: { schemaVersion: 1, skills: [{ name: 'mms-mobile-testing' }] },
    check: { status: 'pass', missing: [] },
  });
  const result = await probe(value);
  assert.equal(result.status, 'mismatch');
  assert.match(result.detail, /invalid requiredSkills record/);
});

test('runner bundle mismatch refuses even without a legacy task source receipt', async () => {
  const value = {
    ...(await expected()),
    runnerObservability: {
      sourceDir: path.resolve(import.meta.dirname, '../../../..'),
      hash: 'f'.repeat(64),
    },
  };
  const result = await probe(value);
  assert.equal(result.status, 'mismatch');
  assert.match(result.detail, /RUNNER_OBSERVABILITY_BUNDLE_MISMATCH/);
});

test('matching runner bytes report their hash while legacy source receipt remains unverified', async () => {
  const sourceDir = path.resolve(import.meta.dirname, '../../../..');
  const bundle = await verifySupportBundle(sourceDir, undefined, RUNNER_OBSERVABILITY_SOURCE_FILES);
  const value = { ...(await expected()), runnerObservability: { sourceDir, hash: bundle.hash } };
  const result = await probe(value);
  assert.equal(result.runnerObservabilityHash, bundle.hash);
  assert.equal(result.status, 'unverified');
  assert.match(result.detail, /No retained task source receipt/);
});
