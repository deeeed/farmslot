import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  farmslotRoot,
  getOrchestratorTaskRoot,
  getProjectField,
  isHttpFetchForbiddenPort,
  isIgnoredPoolFile,
  isMockModeProject,
  loadProjectVars,
  normalizeRawRuntimeCapabilities,
  type RawProjectJson,
  resolveProjectRuntimeDir,
  resolveProjectTaskDirName,
  resolveTaskRelDir,
  validateCommandEnvConfig,
  validateExecutionTemplatesConfig,
  validatePrepareConfig,
  validateRuntimeCapabilitiesConfig,
} from './config.js';

test('prepare core and capability providers validate while legacy profiles remain valid', () => {
  const legacy: RawProjectJson = {
    prepare: { default: 'full', profiles: { full: { phases: ['git', 'deps'] } } },
  };
  assert.doesNotThrow(() => validatePrepareConfig(legacy, 'legacy-project.json'));

  const migrated: RawProjectJson = {
    prepare: {
      core: { phases: ['git', 'fixtures', 'deps'] },
      compatibility_profile: 'full',
      profiles: { full: { phases: ['git', 'fixtures', 'deps', 'preflight', 'health'] } },
    },
    slot_actions: {
      'browser-start': { label: 'start', command: 'start' },
      'browser-health': { label: 'health', command: 'health' },
      'browser-stop': { label: 'stop', command: 'stop' },
    },
    runtime_capabilities: {
      providers: {
        'browser-cdp': {
          label: 'Browser',
          version: '1',
          share_policy: 'exclusive',
          cost: {
            class: 'high',
            resources: [{ id: 'cdp-port', access: 'exclusive', kind: 'port' }],
          },
          actions: {
            acquire: { kind: 'slot-action', action_id: 'browser-start' },
            health: { kind: 'slot-action', action_id: 'browser-health' },
            release: { kind: 'slot-action', action_id: 'browser-stop' },
          },
          release_effects: ['stop browser'],
        },
      },
    },
  };
  assert.doesNotThrow(() => validatePrepareConfig(migrated, 'migrated-project.json'));
  assert.doesNotThrow(() => validateRuntimeCapabilitiesConfig(migrated, 'migrated-project.json'));
  assert.equal(
    normalizeRawRuntimeCapabilities(migrated.runtime_capabilities)?.providers['browser-cdp']
      ?.sharePolicy,
    'exclusive',
  );
});

test('capability validation rejects unstable ids, missing actions, and dependency cycles', () => {
  const project = (providers: NonNullable<RawProjectJson['runtime_capabilities']>['providers']) =>
    ({ runtime_capabilities: { providers } }) as RawProjectJson;
  const provider = {
    label: 'Capability',
    version: '1',
    share_policy: 'shared',
    cost: { class: 'low', resources: [] },
    actions: {
      acquire: { kind: 'slot-action' as const, action_id: 'missing' },
      health: { kind: 'slot-action' as const, action_id: 'missing' },
      release: { kind: 'slot-action' as const, action_id: 'missing' },
    },
    release_effects: ['release'],
  };
  assert.throws(
    () => validateRuntimeCapabilitiesConfig(project({ Bad_ID: provider }), 'project.json'),
    /runtime capability id/,
  );
  assert.throws(
    () => validateRuntimeCapabilitiesConfig(project({ good: provider }), 'project.json'),
    /must name an existing slot action/,
  );

  const action = { label: 'action', command: 'true' };
  const cyclic = project({
    a: { ...provider, dependencies: ['b'] },
    b: { ...provider, dependencies: ['a'] },
  });
  cyclic.slot_actions = { missing: action };
  assert.throws(
    () => validateRuntimeCapabilitiesConfig(cyclic, 'project.json'),
    /dependency cycle/,
  );
});

test('posture retention config validates, normalizes, and leaves keep_warm_ms-only projects valid', () => {
  const slotActions = {
    'browser-start': { label: 'start', command: 'start' },
    'browser-health': { label: 'health', command: 'health' },
    'browser-stop': { label: 'stop', command: 'stop' },
  };
  const provider = {
    label: 'Browser',
    version: '1',
    share_policy: 'exclusive' as const,
    cost: { class: 'high', resources: [{ id: 'cdp-port', access: 'exclusive' as const }] },
    actions: {
      acquire: { kind: 'slot-action' as const, action_id: 'browser-start' },
      health: { kind: 'slot-action' as const, action_id: 'browser-health' },
      release: { kind: 'slot-action' as const, action_id: 'browser-stop' },
    },
    release_effects: ['stop browser'],
  };
  const project = (runtime: NonNullable<RawProjectJson['runtime_capabilities']>) =>
    ({ slot_actions: slotActions, runtime_capabilities: runtime }) as RawProjectJson;

  // keep_warm_ms alone stays valid and normalizes without a posture block.
  const warmOnly = project({
    providers: { 'browser-cdp': { ...provider, keep_warm_ms: 600_000 } },
  });
  assert.doesNotThrow(() => validateRuntimeCapabilitiesConfig(warmOnly, 'project.json'));
  const warmOnlyNormalized = normalizeRawRuntimeCapabilities(warmOnly.runtime_capabilities);
  assert.equal(warmOnlyNormalized?.providers['browser-cdp']?.keepWarmMs, 600_000);
  assert.equal(warmOnlyNormalized?.providers['browser-cdp']?.retention, undefined);
  assert.equal(warmOnlyNormalized?.posture, undefined);

  const configured = project({
    providers: {
      'browser-cdp': { ...provider, retention: { 'operator-wait': 'warm', terminal: 'stop' } },
    },
    posture: { defaults: { 'operator-wait': 'stop' } },
  });
  assert.doesNotThrow(() => validateRuntimeCapabilitiesConfig(configured, 'project.json'));
  const normalized = normalizeRawRuntimeCapabilities(configured.runtime_capabilities);
  assert.deepEqual(normalized?.providers['browser-cdp']?.retention, {
    'operator-wait': 'warm',
    terminal: 'stop',
  });
  assert.deepEqual(normalized?.posture, { defaults: { 'operator-wait': 'stop' } });

  assert.throws(
    () =>
      validateRuntimeCapabilitiesConfig(
        project({
          providers: { 'browser-cdp': provider },
          posture: { defaults: { parked: 'stop' } },
        }),
        'project.json',
      ),
    /is not a configurable posture/,
  );
  assert.throws(
    () =>
      validateRuntimeCapabilitiesConfig(
        project({
          providers: { 'browser-cdp': { ...provider, retention: { 'operator-wait': 'keep' } } },
        }),
        'project.json',
      ),
    /must be retain, warm, stop/,
  );
  assert.throws(
    () =>
      validateRuntimeCapabilitiesConfig(
        project({
          providers: { 'browser-cdp': { ...provider, retention: { terminal: 'retain' } } },
        }),
        'project.json',
      ),
    /"terminal" cannot be retain/,
  );
});

test('isMockModeProject detects external mock_mode flag', () => {
  assert.equal(isMockModeProject({ external: { mock_mode: true } } as any), true);
  assert.equal(isMockModeProject({} as any), false);
});

test('execution-template config accepts portable sources/defaults and rejects unsafe roots', () => {
  const valid: RawProjectJson = {
    execution_templates: {
      sources: [
        {
          id: 'package:canonical',
          kind: 'package',
          root: { env: 'CANONICAL_ROOT' },
          subpath: 'references/templates',
        },
        {
          id: 'team:trading',
          kind: 'workspace',
          root: { projectPath: 'libraries/trading' },
          subpath: 'checklists',
          domains: ['trading'],
        },
      ],
      defaults: [
        {
          when: {
            flow: 'fix-bug',
            platform: 'mobile',
            runMode: 'autonomous',
            domain: 'trading',
          },
          templateId: 'fix-bug/autonomous.mobile',
        },
      ],
    },
  };
  assert.doesNotThrow(() => validateExecutionTemplatesConfig(valid, 'project.json'));

  assert.throws(
    () =>
      validateExecutionTemplatesConfig(
        {
          execution_templates: {
            sources: [
              {
                id: 'bad',
                kind: 'package',
                root: { projectPath: '../outside' },
              },
            ],
          },
        },
        'project.json',
      ),
    /safe relative path/,
  );
  assert.throws(
    () =>
      validateExecutionTemplatesConfig(
        {
          execution_templates: {
            sources: [{ id: 'bad', kind: 'project' as never, root: { env: 'ROOT' } }],
          },
        },
        'project.json',
      ),
    /kind must be/,
  );
});

test('command_env validates domain names and environment mutation shapes', () => {
  assert.doesNotThrow(() =>
    validateCommandEnvConfig(
      {
        command_env: {
          set: { SHARED: 'literal' },
          domains: { trading: { unset: ['OLD'], set: { LIBRARY: '{{repo}}' } } },
        },
      },
      'project.json',
    ),
  );
  assert.throws(
    () =>
      validateCommandEnvConfig(
        { command_env: { domains: { 'Bad Domain': { set: { VALUE: 'x' } } } } },
        'project.json',
      ),
    /domains key/,
  );
  assert.throws(
    () =>
      validateCommandEnvConfig(
        { command_env: { domains: { trading: { set: { 'BAD-NAME': 'x' } } } } },
        'project.json',
      ),
    /valid environment names/,
  );
});

test('isHttpFetchForbiddenPort flags CDP ports that Node fetch refuses', () => {
  assert.equal(isHttpFetchForbiddenPort(6665), true);
  assert.equal(isHttpFetchForbiddenPort(6666), true);
  assert.equal(isHttpFetchForbiddenPort(7665), false);
  assert.equal(isHttpFetchForbiddenPort(7666), false);
});

test('getOrchestratorTaskRoot uses sandbox path for mock projects', () => {
  assert.equal(
    getOrchestratorTaskRoot('farmslot-farm', {
      external: { mock_mode: true },
      task_dir: '.sandbox/farmslot-farm/worker-task',
    } as any),
    path.join(farmslotRoot, '.sandbox', 'farmslot-farm', 'tasks'),
  );
});

test('getOrchestratorTaskRoot uses projects path for normal projects', () => {
  assert.equal(
    getOrchestratorTaskRoot('example-mobile-farm', {} as any),
    path.join(farmslotRoot, 'projects', 'example-mobile-farm', 'tasks'),
  );
});

test('resolveProjectTaskDirName prefers task_dir then paths.artifact_dir then default', () => {
  assert.equal(
    resolveProjectTaskDirName({
      task_dir: 'custom/tasks',
      paths: { artifact_dir: 'temp/tasks' },
    } as any),
    'custom/tasks',
  );
  assert.equal(
    resolveProjectTaskDirName({ paths: { artifact_dir: 'temp/tasks' } } as any),
    'temp/tasks',
  );
  assert.equal(resolveProjectTaskDirName({} as any), '.task');
});

test('resolveTaskRelDir derives task-relative directories from task roots', () => {
  assert.equal(
    resolveTaskRelDir(
      path.join(farmslotRoot, 'projects', 'demo-project', 'tasks', 'feature', 'TASK.md'),
      path.join(farmslotRoot, 'projects', 'demo-project', 'tasks'),
    ),
    'feature',
  );
});

test('resolveTaskRelDir rejects task files outside the task root', () => {
  assert.equal(
    resolveTaskRelDir(
      path.join(farmslotRoot, 'projects', 'other-project', 'tasks', 'feature', 'TASK.md'),
      path.join(farmslotRoot, 'projects', 'demo-project', 'tasks'),
    ),
    null,
  );
});

test('resolveTaskRelDir supports alternate task filenames when requested', () => {
  assert.equal(
    resolveTaskRelDir(
      path.join(farmslotRoot, 'projects', 'demo-project', 'tasks', 'feature', 'SELF-REVIEW.md'),
      path.join(farmslotRoot, 'projects', 'demo-project', 'tasks'),
      'SELF-REVIEW.md',
    ),
    'feature',
  );
});

test('loadProjectVars resolves documented recipe_dir default and rejects other placeholders in paths', async (t) => {
  const project = `paths-placeholder-config-${process.pid}`;
  const projectDir = path.join(farmslotRoot, 'projects', project);
  await mkdir(projectDir, { recursive: true });
  t.after(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });
  await writeFile(
    path.join(projectDir, 'project.json'),
    JSON.stringify({
      name: project,
      paths: { runtime_dir: '.agent', recipe_dir: '{{runtime_dir}}/recipes' },
    }),
  );
  const pv = await loadProjectVars(project);
  assert.equal(pv.recipeDir, '.agent/recipes');

  for (const paths of [
    { runtime_dir: '{{smuggled}}/state' },
    { artifact_dir: 'x/{{smuggled}}' },
    { recipe_dir: '{{smuggled}}/recipes' },
  ]) {
    const invalidProject = `${project}-${Object.keys(paths)[0]}`;
    const invalidDir = path.join(farmslotRoot, 'projects', invalidProject);
    await mkdir(invalidDir, { recursive: true });
    t.after(async () => {
      await rm(invalidDir, { recursive: true, force: true });
    });
    await writeFile(
      path.join(invalidDir, 'project.json'),
      JSON.stringify({ name: invalidProject, paths }),
    );
    await assert.rejects(
      () => loadProjectVars(invalidProject),
      /must not contain template placeholders.*\{\{smuggled\}\}/,
    );
  }
});

test('loadProjectVars validates auto_recovery disabled_patterns as string array', async (t) => {
  const project = `auto-recovery-config-${process.pid}`;
  const projectDir = path.join(farmslotRoot, 'projects', project);
  await mkdir(projectDir, { recursive: true });
  t.after(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });
  await writeFile(
    path.join(projectDir, 'project.json'),
    JSON.stringify({
      name: project,
      auto_recovery: {
        enabled: true,
        maxAttempts: 1,
        allowedSteps: ['prepare'],
        allowedCategories: ['infra'],
        disabled_patterns: ['devserver-crashed'],
        llm: { enabled: false, dailyUsdCap: 0 },
      },
    }),
  );
  await assert.doesNotReject(() => loadProjectVars(project));
  const invalidProject = `${project}-invalid`;
  const invalidDir = path.join(farmslotRoot, 'projects', invalidProject);
  await mkdir(invalidDir, { recursive: true });
  t.after(async () => {
    await rm(invalidDir, { recursive: true, force: true });
  });
  await writeFile(
    path.join(invalidDir, 'project.json'),
    JSON.stringify({ name: invalidProject, auto_recovery: { disabled_patterns: ['ok', 42] } }),
  );
  await assert.rejects(
    () => loadProjectVars(invalidProject),
    /auto_recovery\.disabled_patterns must be a string\[\]/,
  );
});

test('loadProjectVars rejects unknown auto_recovery categories', async (t) => {
  const project = `auto-recovery-category-${process.pid}`;
  const projectDir = path.join(farmslotRoot, 'projects', project);
  await mkdir(projectDir, { recursive: true });
  t.after(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });
  await writeFile(
    path.join(projectDir, 'project.json'),
    JSON.stringify({ name: project, auto_recovery: { allowedCategories: ['flaky'] } }),
  );
  await assert.rejects(
    () => loadProjectVars(project),
    /auto_recovery\.allowedCategories contains an unknown failure category/,
  );
});

test('loadProjectVars validates publication_review snake_case config', async (t) => {
  const project = `publication-review-config-${process.pid}`;
  const projectDir = path.join(farmslotRoot, 'projects', project);
  await mkdir(projectDir, { recursive: true });
  t.after(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });
  await writeFile(
    path.join(projectDir, 'project.json'),
    JSON.stringify({
      name: project,
      publication_review: {
        dev: { minimum_independent_reviews: 0, require_cross_runner: false },
        'fix-bug': { minimum_independent_reviews: 1 },
      },
    }),
  );
  await assert.doesNotReject(() => loadProjectVars(project));

  const invalidProject = `${project}-invalid`;
  const invalidDir = path.join(farmslotRoot, 'projects', invalidProject);
  await mkdir(invalidDir, { recursive: true });
  t.after(async () => {
    await rm(invalidDir, { recursive: true, force: true });
  });
  await writeFile(
    path.join(invalidDir, 'project.json'),
    JSON.stringify({
      name: invalidProject,
      publication_review: { dev: { minimum_independent_reviews: -1 } },
    }),
  );
  await assert.rejects(
    () => loadProjectVars(invalidProject),
    /publication_review\.dev\.minimum_independent_reviews must be a non-negative integer/,
  );
});

test('loadProjectVars validates roadmap farmslot_command config', async (t) => {
  const project = `roadmap-config-${process.pid}`;
  const projectDir = path.join(farmslotRoot, 'projects', project);
  await mkdir(projectDir, { recursive: true });
  t.after(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });
  await writeFile(
    path.join(projectDir, 'project.json'),
    JSON.stringify({
      name: project,
      roadmap: {
        farmslot_command: 'yarn workspace @farmslot/cli farmslot',
      },
    }),
  );
  const vars = await loadProjectVars(project);
  assert.equal(vars.roadmap?.farmslotCommand, 'yarn workspace @farmslot/cli farmslot');

  const invalidProject = `${project}-invalid`;
  const invalidDir = path.join(farmslotRoot, 'projects', invalidProject);
  await mkdir(invalidDir, { recursive: true });
  t.after(async () => {
    await rm(invalidDir, { recursive: true, force: true });
  });
  await writeFile(
    path.join(invalidDir, 'project.json'),
    JSON.stringify({ name: invalidProject, roadmap: { farmslot_command: 42 } }),
  );
  await assert.rejects(
    () => loadProjectVars(invalidProject),
    /roadmap\.farmslot_command must be a string/,
  );
});

const PREPARE_CONFIG_PATH = 'projects/test/project.json';

function prepareJson(prepare: unknown) {
  return { name: 'test', prepare } as Parameters<typeof validatePrepareConfig>[0];
}

test('validatePrepareConfig accepts a full profile set with fallback chain', () => {
  assert.doesNotThrow(() =>
    validatePrepareConfig(
      prepareJson({
        default: 'full',
        profiles: {
          full: { phases: ['git', 'fixtures', 'deps', 'preflight', 'health'] },
          relaunch: {
            label: 'Switch branch + relaunch app',
            phases: ['git', 'fixtures', 'preflight', 'health'],
            hooks: { preflight: 'bash relaunch.sh {{slot_id}}' },
            requires: ['deps_current', 'dev_server_up'],
            fallback: 'full',
          },
          attach: { phases: ['health'], requires: ['health_ok'], fallback: 'relaunch' },
        },
      }),
      PREPARE_CONFIG_PATH,
    ),
  );
});

test('validatePrepareConfig is a no-op without a prepare block', () => {
  assert.doesNotThrow(() => validatePrepareConfig({ name: 'test' }, PREPARE_CONFIG_PATH));
});

test('validatePrepareConfig rejects structural errors', () => {
  assert.throws(
    () => validatePrepareConfig(prepareJson([]), PREPARE_CONFIG_PATH),
    /prepare must be an object/,
  );
  assert.throws(
    () => validatePrepareConfig(prepareJson({}), PREPARE_CONFIG_PATH),
    /must define core or at least one profile/,
  );
  assert.throws(
    () => validatePrepareConfig(prepareJson({ profiles: {} }), PREPARE_CONFIG_PATH),
    /must define core or at least one profile/,
  );
  assert.throws(
    () =>
      validatePrepareConfig(
        prepareJson({ profiles: { Bad_Name: { phases: ['git'] } } }),
        PREPARE_CONFIG_PATH,
      ),
    /key "Bad_Name" is invalid/,
  );
  assert.throws(
    () =>
      validatePrepareConfig(
        prepareJson({
          core: { phases: ['git'] },
          profiles: { core: { phases: ['git', 'deps'] } },
        }),
        PREPARE_CONFIG_PATH,
      ),
    /reserved profile "core"/,
  );
});

test('validatePrepareConfig rejects bad phases', () => {
  assert.throws(
    () =>
      validatePrepareConfig(
        prepareJson({ profiles: { full: { phases: [] } } }),
        PREPARE_CONFIG_PATH,
      ),
    /phases must be a non-empty array/,
  );
  assert.throws(
    () =>
      validatePrepareConfig(
        prepareJson({ profiles: { full: { phases: ['git', 'compile'] } } }),
        PREPARE_CONFIG_PATH,
      ),
    /unknown phase "compile"/,
  );
  assert.throws(
    () =>
      validatePrepareConfig(
        prepareJson({ profiles: { full: { phases: ['git', 'git'] } } }),
        PREPARE_CONFIG_PATH,
      ),
    /phases contains duplicates/,
  );
});

test('validatePrepareConfig rejects bad requires and missing fallback', () => {
  assert.throws(
    () =>
      validatePrepareConfig(
        prepareJson({ profiles: { full: { phases: ['git'], requires: ['cdp_up'] } } }),
        PREPARE_CONFIG_PATH,
      ),
    /unknown check "cdp_up"/,
  );
  assert.throws(
    () =>
      validatePrepareConfig(
        prepareJson({ profiles: { full: { phases: ['git'], requires: ['health_ok'] } } }),
        PREPARE_CONFIG_PATH,
      ),
    /declares requires but no fallback profile/,
  );
});

test('validatePrepareConfig accepts the artifact_available requirement with a fallback', () => {
  assert.doesNotThrow(() =>
    validatePrepareConfig(
      prepareJson({
        default: 'runway',
        profiles: {
          'ensure-js-runtime': { phases: ['git', 'deps'] },
          runway: {
            phases: ['git', 'preflight'],
            requires: ['artifact_available'],
            fallback: 'ensure-js-runtime',
          },
        },
      }),
      PREPARE_CONFIG_PATH,
    ),
  );
});

test('validatePrepareConfig rejects bad fallback references and cycles', () => {
  assert.throws(
    () =>
      validatePrepareConfig(
        prepareJson({ profiles: { full: { phases: ['git'], fallback: 'missing' } } }),
        PREPARE_CONFIG_PATH,
      ),
    /fallback must name an existing profile/,
  );
  assert.throws(
    () =>
      validatePrepareConfig(
        prepareJson({ profiles: { full: { phases: ['git'], fallback: 'full' } } }),
        PREPARE_CONFIG_PATH,
      ),
    /fallback must not be itself/,
  );
  assert.throws(
    () =>
      validatePrepareConfig(
        prepareJson({
          profiles: {
            a: { phases: ['git'], requires: ['health_ok'], fallback: 'b' },
            b: { phases: ['git'], requires: ['health_ok'], fallback: 'a' },
          },
        }),
        PREPARE_CONFIG_PATH,
      ),
    /fallback chain from "a" contains a cycle/,
  );
});

test('validatePrepareConfig rejects unknown default profile', () => {
  assert.throws(
    () =>
      validatePrepareConfig(
        prepareJson({ default: 'fast', profiles: { full: { phases: ['git'] } } }),
        PREPARE_CONFIG_PATH,
      ),
    /prepare\.default must name an existing profile/,
  );
});

test('loadProjectVars validates the prepare block', async (t) => {
  const project = `prepare-config-${process.pid}`;
  const projectDir = path.join(farmslotRoot, 'projects', project);
  await mkdir(projectDir, { recursive: true });
  t.after(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });
  await writeFile(
    path.join(projectDir, 'project.json'),
    JSON.stringify({
      name: project,
      prepare: { profiles: { full: { phases: ['git', 'health'], requires: ['health_ok'] } } },
    }),
  );
  await assert.rejects(() => loadProjectVars(project), /declares requires but no fallback profile/);
});

test('resolveProjectRuntimeDir reads paths.runtime_dir from project.json', async (t) => {
  const project = `runtime-dir-${process.pid}`;
  const projectDir = path.join(farmslotRoot, 'projects', project);
  await mkdir(projectDir, { recursive: true });
  t.after(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });
  await writeFile(
    path.join(projectDir, 'project.json'),
    JSON.stringify({
      name: project,
      paths: { runtime_dir: 'temp/recipe/runtime' },
    }),
  );

  assert.equal(await resolveProjectRuntimeDir(project), 'temp/recipe/runtime');
  assert.equal(await resolveProjectRuntimeDir(null), '.agent');
  assert.equal(await resolveProjectRuntimeDir('missing-project-xyz'), '.agent');
});

test('isIgnoredPoolFile hides the demo pool unless FARMSLOT_DEMO_POOL=1', () => {
  const prev = process.env.FARMSLOT_DEMO_POOL;
  try {
    delete process.env.FARMSLOT_DEMO_POOL;
    assert.equal(isIgnoredPoolFile('example.json'), true);
    assert.equal(isIgnoredPoolFile('notes.md'), true);
    assert.equal(isIgnoredPoolFile('agent-contexts-12345.json'), true);
    assert.equal(isIgnoredPoolFile('farmslot-demo.json'), true);
    assert.equal(isIgnoredPoolFile('macbook.json'), false);
    process.env.FARMSLOT_DEMO_POOL = '1';
    assert.equal(isIgnoredPoolFile('farmslot-demo.json'), false);
  } finally {
    if (prev === undefined) delete process.env.FARMSLOT_DEMO_POOL;
    else process.env.FARMSLOT_DEMO_POOL = prev;
  }
});

test('numeric and boolean project fields reach shell callers', () => {
  // These are read via `farmslot internal project-field` and then folded into
  // `${VAR:-<default>}`. Returning '' for a number meant every configured
  // numeric value silently lost to the hardcoded default —
  // metamask-extension-farm sets timeouts.build_manifest_s=600 and preflight
  // used 180 for every build, then reported the resulting timeout as "a real
  // source/build error".
  const projectJson = {
    name: 'demo-farm',
    timeouts: { build_manifest_s: 600, zero_s: 0 },
    flags: { enabled: true, disabled: false },
    nested: { obj: { a: 1 }, list: [1, 2] },
  } as unknown as Parameters<typeof getProjectField>[0];

  assert.equal(getProjectField(projectJson, 'timeouts.build_manifest_s'), '600');
  assert.equal(getProjectField(projectJson, 'timeouts.zero_s'), '0');
  assert.equal(getProjectField(projectJson, 'flags.enabled'), 'true');
  assert.equal(getProjectField(projectJson, 'flags.disabled'), 'false');
  assert.equal(getProjectField(projectJson, 'name'), 'demo-farm');

  // Objects and arrays have no single shell value and stay empty.
  assert.equal(getProjectField(projectJson, 'nested.obj'), '');
  assert.equal(getProjectField(projectJson, 'nested.list'), '');
  assert.equal(getProjectField(projectJson, 'missing.path'), '');
});
