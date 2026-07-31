import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { digestRecipeDocument } from '@farmslot/protocol';

import { getOrchestratorTaskRoot, type RawProjectJson } from '../core/config.js';

import {
  appendRecipePlaybackOptions,
  assertSlotProjectMatchesRequestedProject,
  canRecipeRerunOnSlot,
  expandRecipeProjectHookTemplate,
  expandRecipeRunHookTemplate,
  recipeReplayHealthReady,
  recipeRunOptionsForProject,
  recipeRunUnsupportedOptionWarnings,
  resolveRecipeArtifactRootForSlot,
  resolveSlotRecipePath,
  resolveSlotRecipePathCandidates,
  selectExistingRecipePathCandidate,
  validateRecipeProjectHookOutput,
  validateRecipeRunArtifactPackageOutput,
  validateRecipeRunHookTemplate,
} from './recipe.js';

const projectJson = {
  task_dir: 'tasks',
} as RawProjectJson;

function createSlotVars(): import('../core/config.js').SlotVars {
  return {
    slotId: 'runner-browser-1',
    machine: 'runner-local',
    platform: 'chrome-extension',
    host: 'localhost',
    sshUser: 'example',
    osType: 'darwin',
    claudePath: '',
    codexPath: '',
    opencodePath: '',
    cursorPath: '',
    grokPath: '',
    dispatchCmd: '',
    recycleCmd: '',
    repo: '/repo',
    session: 'mme-1',
    slotMode: 'dispatch',
    slotEnabled: true,
    sshTarget: 'localhost',
    remoteRepo: '/repo',
    projectName: 'demo-project',
    resourceVars: {
      adb_serial: 'emulator-5554',
      cdp_port: '9222',
      platform: 'chrome-extension',
      simulator: 'iPhone 16',
      slot_id: 'runner-browser-1',
    },
  };
}

test('validateRecipeRunHookTemplate requires explicit Recipe v1 input and output placeholders', () => {
  assert.doesNotThrow(() =>
    validateRecipeRunHookTemplate(
      'node runner.js --recipe {{recipe_path}} --artifacts-dir {{artifacts_dir}}',
    ),
  );
  assert.throws(
    () => validateRecipeRunHookTemplate('node runner.js --recipe {{recipe_path}}'),
    /\{\{artifacts_dir\}\}/,
  );
  assert.throws(
    () => validateRecipeRunHookTemplate('node runner.js --artifacts-dir {{artifacts_dir}}'),
    /\{\{recipe_path\}\}/,
  );
});

test('expandRecipeRunHookTemplate expands slot, run, and shell-safe recipe paths', () => {
  assert.equal(
    expandRecipeRunHookTemplate(
      'cd {{repo}} && node runner.js --recipe {{recipe_path}} --artifacts-dir {{artifacts_dir}} --cdp-port {{cdp_port}} --slot {{slot_id}} --runtime {{runtime_dir}} --platform {{platform}} --simulator "{{simulator}}" --adb {{adb_serial}} --run {{run_id}} --recipe-run {{recipe_run_id}}',
      createSlotVars(),
      {
        projectName: 'demo-project',
        projectConfig: '/project.json',
        projectFixturesDir: '/fixtures',
        projectTemplatesDir: '/templates',
        projectJson: {},
        runtimeDir: '.agent',
        artifactDir: '.task',
        recipeDir: '.agent/recipes',
      },
      "'/repo/.task/run/recipe.json'",
      "'/repo/.task/run/artifacts/recipe-runs/manual-1'",
      { runId: 'run-123', recipeRunId: 'manual-1' },
    ),
    "cd /repo && node runner.js --recipe '/repo/.task/run/recipe.json' --artifacts-dir '/repo/.task/run/artifacts/recipe-runs/manual-1' --cdp-port 9222 --slot runner-browser-1 --runtime .agent --platform chrome-extension --simulator \"iPhone 16\" --adb emulator-5554 --run run-123 --recipe-run manual-1",
  );
});

test('expandRecipeProjectHookTemplate expands action manifest, doctor, and run hooks', () => {
  const slotVars = createSlotVars();
  const projectVars = {
    projectName: 'demo-project',
    projectConfig: '/project.json',
    projectFixturesDir: '/fixtures',
    projectTemplatesDir: '/templates',
    runtimeDir: '.agent',
    artifactDir: '.task',
    recipeDir: '.agent/recipes',
    projectJson: {
      hooks: {
        recipe_action_manifest:
          'cd {{repo}} && node runner.js manifest --platform {{platform}} --cdp-port {{cdp_port}} --slot {{slot_id}}',
        recipe_doctor:
          'cd {{repo}} && node runner.js doctor --json --runtime {{runtime_dir}} --simulator "{{simulator}}" --adb {{adb_serial}}',
        recipe_run:
          'cd {{repo}} && node runner.js run {{recipe_path}} --artifacts-dir {{artifacts_dir}} --cdp-port {{cdp_port}} --slot {{slot_id}}',
      },
    },
  };

  assert.deepEqual(
    expandRecipeProjectHookTemplate('recipe_action_manifest', projectVars, slotVars),
    {
      hook: 'recipe_action_manifest',
      command:
        'cd /repo && node runner.js manifest --platform chrome-extension --cdp-port 9222 --slot runner-browser-1',
    },
  );
  assert.deepEqual(expandRecipeProjectHookTemplate('recipe_doctor', projectVars, slotVars), {
    hook: 'recipe_doctor',
    command:
      'cd /repo && node runner.js doctor --json --runtime .agent --simulator "iPhone 16" --adb emulator-5554',
  });
  assert.deepEqual(
    expandRecipeProjectHookTemplate('recipe_run', projectVars, slotVars, {
      recipePath: '/repo/.task/recipe.json',
      artifactsDir: '/repo/.task/artifacts/recipe-runs/manual-1',
    }),
    {
      hook: 'recipe_run',
      command:
        "cd /repo && node runner.js run '/repo/.task/recipe.json' --artifacts-dir '/repo/.task/artifacts/recipe-runs/manual-1' --cdp-port 9222 --slot runner-browser-1",
    },
  );
  assert.throws(
    () => expandRecipeProjectHookTemplate('recipe_run', projectVars, slotVars),
    /requires recipePath/,
  );
});

test('recipe hook expansion rejects a missing slot Metro resource with manual pool guidance', () => {
  const slotVars = createSlotVars();
  const projectVars = {
    projectName: 'demo-project',
    projectConfig: '/project.json',
    projectFixturesDir: '/fixtures',
    projectTemplatesDir: '/templates',
    runtimeDir: '.agent',
    artifactDir: '.task',
    recipeDir: '.agent/recipes',
    projectJson: {
      hooks: {
        recipe_run:
          'runner --recipe {{recipe_path}} --artifacts-dir {{artifacts_dir}} --metro {{METRO_PORT}}',
      },
    },
  };

  assert.throws(
    () =>
      expandRecipeProjectHookTemplate('recipe_run', projectVars, slotVars, {
        recipePath: '/repo/recipe.json',
        artifactsDir: '/repo/artifacts',
      }),
    /runner-browser-1.*resources\.dev-server.*add the resource manually.*distinct port and metro_port/u,
  );
});

test('assertSlotProjectMatchesRequestedProject rejects hook execution against another project slot', () => {
  assert.doesNotThrow(() =>
    assertSlotProjectMatchesRequestedProject(createSlotVars(), 'demo-project'),
  );
  assert.throws(
    () => assertSlotProjectMatchesRequestedProject(createSlotVars(), 'other-project'),
    /belongs to project demo-project/,
  );
});

test('validateRecipeProjectHookOutput validates action manifest and doctor JSON gates', () => {
  assert.equal(
    validateRecipeProjectHookOutput(
      'recipe_action_manifest',
      JSON.stringify({
        $schema: 'https://farmslot.io/schemas/action-manifest-v1.schema.json',
        actions: {
          end: {
            description: 'Finish the recipe.',
            examples: [{ action: 'end', status: 'pass' }],
          },
        },
      }),
    ).status,
    'pass',
  );
  assert.equal(
    validateRecipeProjectHookOutput(
      'recipe_doctor',
      JSON.stringify({
        runner_protocol_version: 1,
        status: 'pass',
        checks: [{ id: 'runner', status: 'pass' }],
      }),
    ).status,
    'pass',
  );
  assert.equal(
    validateRecipeProjectHookOutput(
      'recipe_doctor',
      JSON.stringify({
        runner_protocol_version: 1,
        status: 'pass',
        checks: [{ id: 'runner', status: 'fail' }],
      }),
    ).status,
    'fail',
  );
  assert.equal(
    validateRecipeProjectHookOutput(
      'recipe_doctor',
      JSON.stringify({
        runner_protocol_version: 1,
        status: 'pass',
        checks: [{ id: 'runner' }],
      }),
    ).status,
    'fail',
  );
  assert.equal(validateRecipeProjectHookOutput('recipe_run', '').status, 'pass');
});

test('validateRecipeRunArtifactPackageOutput requires typed artifact manifest package', () => {
  const recipe = {
    $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
    description: 'Complete the artifact package proof.',
    workflow: {
      entry: 'done',
      nodes: { done: { action: 'end', status: 'pass' } },
    },
  };
  const summary = {
    status: 'pass',
    passed: 1,
    failed: 0,
    total: 1,
    cause_counts: { subject: 0, harness: 0, environment: 0, unknown: 0 },
  };
  const manifest = {
    version: 1,
    runStatus: 'pass',
    artifacts: [
      { path: 'recipe.json', type: 'recipe' },
      { path: 'summary.json', type: 'summary' },
      { path: 'trace.json', type: 'trace' },
    ],
  };
  const recipeResolution = {
    schema_version: 1,
    root: { ref: '$root', digest: digestRecipeDocument(recipe) },
    dependencies: [],
    edges: [],
  };
  const trace = [{ nodeId: 'done', action: 'end', ok: true, artifacts: [] }];

  const valid = validateRecipeRunArtifactPackageOutput({
    artifactPaths: [
      'artifact-manifest.json',
      'recipe.json',
      'recipe-resolution.json',
      'summary.json',
      'trace.json',
    ],
    recipe,
    recipeArtifactPresent: true,
    recipeResolution,
    trace,
    summary,
    manifest,
  });
  assert.equal(valid.status, 'pass', JSON.stringify(valid.checks));
  assert.equal(valid.recipe?.status, 'valid');

  const validWithoutCopiedRecipe = validateRecipeRunArtifactPackageOutput({
    artifactPaths: ['artifact-manifest.json', 'summary.json', 'trace.json'],
    recipe,
    recipeArtifactPresent: false,
    trace,
    summary,
    manifest: {
      ...manifest,
      artifacts: manifest.artifacts.filter((artifact) => artifact.path !== 'recipe.json'),
    },
  });
  assert.equal(validWithoutCopiedRecipe.status, 'pass', JSON.stringify(validWithoutCopiedRecipe));

  const listFailure = validateRecipeRunArtifactPackageOutput({
    artifactPaths: [],
    recipe,
    recipeArtifactPresent: true,
    recipeResolution,
    trace,
    summary,
    manifest,
    artifactListError: 'find maxBuffer exceeded',
  });
  assert.equal(listFailure.status, 'fail');
  assert.equal(
    listFailure.checks.find((check) => check.id === 'recipe_run.artifact_list')?.message,
    'Could not list recipe artifact package files: find maxBuffer exceeded',
  );
  assert.ok(
    listFailure.checks
      .filter((check) => check.id.startsWith('recipe_run.artifact.'))
      .every((check) => check.status === 'pass'),
  );
  assert.equal(listFailure.recipe?.status, 'valid');

  const statusMismatch = validateRecipeRunArtifactPackageOutput({
    artifactPaths: [
      'artifact-manifest.json',
      'recipe.json',
      'recipe-resolution.json',
      'summary.json',
      'trace.json',
    ],
    recipe,
    recipeArtifactPresent: true,
    recipeResolution,
    trace,
    summary: { ...summary, status: 'fail' },
    manifest,
  });
  assert.equal(statusMismatch.status, 'fail');
  assert.match(
    statusMismatch.checks.find((check) => check.id === 'recipe_run.manifest.status_matches_summary')
      ?.message ?? '',
    /summary=fail, manifest=pass/,
  );

  const missingManifest = validateRecipeRunArtifactPackageOutput({
    artifactPaths: ['recipe.json', 'recipe-resolution.json', 'summary.json', 'trace.json'],
    recipe,
    recipeArtifactPresent: true,
    recipeResolution,
    trace,
    summary,
    manifest: undefined,
    readErrors: { 'artifact-manifest.json': 'file missing' },
  });
  assert.equal(missingManifest.status, 'fail');
  const missingManifestCheck = missingManifest.checks.find(
    (check) => check.id === 'recipe_run.artifact.artifact-manifest.json',
  );
  assert.equal(missingManifestCheck?.message, 'artifact-manifest.json is missing.');
  assert.doesNotMatch(
    missingManifest.checks.find((check) => check.id === 'recipe_run.artifact_manifest.validation')
      ?.message ?? '',
    /artifact_package\.missing_manifest/,
  );
  assert.equal(
    missingManifest.checks.find((check) => check.id === 'recipe_run.artifact_manifest.validation')
      ?.status,
    'pass',
  );

  const malformedManifest = validateRecipeRunArtifactPackageOutput({
    artifactPaths: [
      'artifact-manifest.json',
      'recipe.json',
      'recipe-resolution.json',
      'summary.json',
      'trace.json',
    ],
    recipe,
    recipeArtifactPresent: true,
    recipeResolution,
    trace,
    summary,
    manifest: undefined,
    readErrors: { 'artifact-manifest.json': 'Unexpected token' },
  });
  assert.equal(malformedManifest.status, 'fail');
  assert.equal(
    malformedManifest.checks.find((check) => check.id === 'recipe_run.artifact_manifest.validation')
      ?.status,
    'pass',
  );

  const badRecipe = validateRecipeRunArtifactPackageOutput({
    artifactPaths: ['artifact-manifest.json', 'recipe.json', 'summary.json', 'trace.json'],
    recipe: undefined,
    recipeArtifactPresent: true,
    summary,
    manifest,
    readErrors: { 'recipe.json': 'Unexpected token' },
  });
  assert.equal(badRecipe.status, 'fail');
  assert.ok(badRecipe.checks.some((check) => check.id === 'recipe_run.artifact.recipe.json'));

  const missingRecipe = validateRecipeRunArtifactPackageOutput({
    artifactPaths: ['artifact-manifest.json', 'summary.json', 'trace.json'],
    recipe: undefined,
    recipeArtifactPresent: true,
    summary,
    manifest,
    readErrors: { 'recipe.json': 'file missing' },
  });
  assert.equal(missingRecipe.status, 'fail');
  assert.equal(
    missingRecipe.checks.find((check) => check.id === 'recipe_run.artifact.recipe.json')?.message,
    'recipe.json is missing.',
  );

  const staleManifest = validateRecipeRunArtifactPackageOutput({
    artifactPaths: [
      'artifact-manifest.json',
      'recipe.json',
      'recipe-resolution.json',
      'summary.json',
      'trace.json',
    ],
    recipe,
    recipeArtifactPresent: true,
    recipeResolution,
    trace,
    summary,
    manifest: { ...manifest, artifacts: [{ path: 'missing.png', type: 'screenshot' }] },
  });
  assert.equal(staleManifest.status, 'fail');
  assert.ok(
    staleManifest.recipe?.findings.some(
      (finding) => finding.code === 'artifact_manifest.missing_file',
    ),
  );
  assert.match(
    staleManifest.checks.find((check) => check.id === 'recipe_run.artifact_manifest.validation')
      ?.message ?? '',
    /artifact_manifest\.missing_file@artifacts\[0\]\.path/,
  );
});

test('validateRecipeRunArtifactPackageOutput requires exact recipe dependency evidence', () => {
  const recipe = {
    $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
    description: 'Run the reusable child proof.',
    workflow: {
      entry: 'call-x',
      nodes: {
        'call-x': {
          action: 'call',
          intent: 'Run the reusable child proof.',
          ref: 'example.child',
          next: 'done',
        },
        done: { action: 'end', status: 'pass' },
      },
    },
  };
  const child = {
    $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
    description: 'Complete the child proof.',
    workflow: {
      entry: 'done',
      nodes: {
        done: { action: 'end', status: 'pass' },
      },
    },
  };
  const childDigest = digestRecipeDocument(child);
  const childArtifact = `resolved-recipes/${childDigest.slice('sha256:'.length)}.recipe.json`;
  const recipeResolution = {
    schema_version: 1,
    root: { ref: '$root', digest: digestRecipeDocument(recipe) },
    dependencies: [
      {
        ref: 'example.child',
        source: 'test',
        file: 'recipes/example/child.recipe.json',
        digest: childDigest,
        artifact: childArtifact,
      },
    ],
    edges: [{ from: '$root', to: 'example.child' }],
  };
  const manifest = {
    version: 1,
    runStatus: 'pass',
    artifacts: [
      { path: 'recipe.json', type: 'recipe' },
      { path: 'recipe-resolution.json', type: 'json' },
      { path: childArtifact, type: 'recipe' },
      { path: 'summary.json', type: 'summary' },
      { path: 'trace.json', type: 'trace' },
    ],
  };
  const artifactPaths = [
    'artifact-manifest.json',
    'recipe.json',
    'recipe-resolution.json',
    childArtifact,
    'summary.json',
    'trace.json',
  ];

  const valid = validateRecipeRunArtifactPackageOutput({
    artifactPaths,
    recipe,
    recipeArtifactPresent: true,
    recipeResolution,
    resolvedRecipes: { [childDigest]: child },
    trace: [
      { nodeId: 'call-x/done', action: 'end', ok: true, artifacts: [] },
      {
        nodeId: 'call-x',
        action: 'call',
        intent: 'Run the reusable child proof.',
        ok: true,
        artifacts: [],
      },
      { nodeId: 'done', action: 'end', ok: true, artifacts: [] },
    ],
    summary: {
      status: 'pass',
      passed: 3,
      failed: 0,
      total: 3,
      cause_counts: { subject: 0, harness: 0, environment: 0, unknown: 0 },
    },
    manifest,
  });
  assert.equal(valid.status, 'pass', JSON.stringify(valid.recipe?.findings));

  const missingDependency = validateRecipeRunArtifactPackageOutput({
    artifactPaths,
    recipe,
    recipeArtifactPresent: true,
    recipeResolution,
    resolvedRecipes: {},
    summary: { status: 'fail', passed: 0, failed: 1, total: 1 },
    manifest: { ...manifest, runStatus: 'fail' },
  });
  assert.ok(
    missingDependency.recipe?.findings.some(
      (finding) => finding.code === 'artifact_package.missing_resolved_recipe',
    ),
  );

  const unreadable = validateRecipeRunArtifactPackageOutput({
    artifactPaths,
    recipe,
    recipeArtifactPresent: true,
    recipeResolution: undefined,
    summary: { status: 'pass', passed: 1, failed: 0, total: 1 },
    manifest,
    readErrors: { 'recipe-resolution.json': 'Unexpected token' },
  });
  assert.equal(unreadable.status, 'fail');
  assert.ok(
    unreadable.checks.some((check) => check.id === 'recipe_run.artifact.recipe-resolution.json'),
  );
});

test('resolveSlotRecipePath keeps bundled recipe paths within the current task directory', () => {
  const recipeArtifactRoot = '/repo/tasks/current-task';

  assert.equal(
    resolveSlotRecipePath(recipeArtifactRoot, 'recipe-library/recipes/demo/child.recipe.json'),
    '/repo/tasks/current-task/recipe-library/recipes/demo/child.recipe.json',
  );
});

test('resolveSlotRecipePath rejects sibling task escapes that share a string prefix', () => {
  assert.equal(resolveSlotRecipePath('/repo/tasks/foo', '../foo-other/recipe.json'), null);
});

test('resolveRecipeArtifactRootForSlot maps local selected recipe-run roots to the worker task artifacts tree', () => {
  const taskRoot = getOrchestratorTaskRoot('demo-project', projectJson);
  const runTaskFile = path.join(taskRoot, 'current-task', 'TASK.md');

  assert.equal(
    resolveRecipeArtifactRootForSlot(
      runTaskFile,
      '/repo/tasks/current-task',
      path.join(taskRoot, 'current-task', 'artifacts', 'recipe-runs', 'passing-run'),
    ),
    '/repo/tasks/current-task/artifacts/recipe-runs/passing-run',
  );
});

test('resolveSlotRecipePath strips the artifacts prefix when targeting a selected recipe-run root', () => {
  assert.equal(
    resolveSlotRecipePath(
      '/repo/tasks/current-task/artifacts/recipe-runs/passing-run',
      'artifacts/recipe-library/recipes/demo/child.recipe.json',
    ),
    '/repo/tasks/current-task/artifacts/recipe-runs/passing-run/recipe-library/recipes/demo/child.recipe.json',
  );
});

test('resolveSlotRecipePath preserves remote ~/... roots when targeting selected recipe-run paths', () => {
  assert.equal(
    resolveSlotRecipePath(
      '~/repo/tasks/current-task/artifacts/recipe-runs/passing-run',
      'artifacts/recipe-library/recipes/demo/child.recipe.json',
    ),
    '~/repo/tasks/current-task/artifacts/recipe-runs/passing-run/recipe-library/recipes/demo/child.recipe.json',
  );
});

test('resolveSlotRecipePathCandidates falls back to the task recipe package for selected runs', () => {
  const taskRoot = getOrchestratorTaskRoot('demo-project', projectJson);
  const runTaskFile = path.join(taskRoot, 'current-task', 'TASK.md');

  assert.deepEqual(
    resolveSlotRecipePathCandidates(
      runTaskFile,
      '/repo/tasks/current-task',
      path.join(taskRoot, 'current-task', 'artifacts', 'recipe-runs', 'passing-run'),
      undefined,
    ),
    [
      {
        recipePath: '/repo/tasks/current-task/artifacts/recipe-runs/passing-run/recipe.json',
        artifactRoot: '/repo/tasks/current-task/artifacts/recipe-runs/passing-run',
        source: 'selected-run',
      },
      {
        recipePath: '/repo/tasks/current-task/artifacts/recipe.json',
        artifactRoot: '/repo/tasks/current-task',
        source: 'current-package',
      },
    ],
  );
});

test('selectExistingRecipePathCandidate uses current package when live attempt lacks recipe.json', async () => {
  const selectedMissing = {
    recipePath: '/repo/tasks/current-task/artifacts/recipe-runs/passing-run/recipe.json',
    artifactRoot: '/repo/tasks/current-task/artifacts/recipe-runs/passing-run',
    source: 'selected-run' as const,
  };
  const currentPackage = {
    recipePath: '/repo/tasks/current-task/artifacts/recipe.json',
    artifactRoot: '/repo/tasks/current-task',
    source: 'current-package' as const,
  };

  assert.deepEqual(
    await selectExistingRecipePathCandidate(
      [selectedMissing, currentPackage],
      async (recipePath) => recipePath === currentPackage.recipePath,
    ),
    currentPackage,
  );
});

test('appendRecipePlaybackOptions leaves normal recipe command unchanged', () => {
  assert.equal(
    appendRecipePlaybackOptions('node validate-recipe.js --recipe recipe.json', {}),
    'node validate-recipe.js --recipe recipe.json',
  );
});

test('appendRecipePlaybackOptions appends typed slow playback flag', () => {
  assert.equal(
    appendRecipePlaybackOptions('node validate-recipe.js --recipe recipe.json', {
      playbackSlowMs: 1000,
    }),
    'node validate-recipe.js --recipe recipe.json --slow 1000',
  );
});

test('appendRecipePlaybackOptions appends opt-in video recording flag', () => {
  assert.equal(
    appendRecipePlaybackOptions('node validate-recipe.js --recipe recipe.json', {
      recordVideo: true,
    }),
    'node validate-recipe.js --recipe recipe.json --record-video=full-run',
  );
});

test('appendRecipePlaybackOptions preserves typed option ordering', () => {
  assert.equal(
    appendRecipePlaybackOptions('node validate-recipe.js --recipe recipe.json', {
      playbackSlowMs: 1000,
      recordVideo: true,
    }),
    'node validate-recipe.js --recipe recipe.json --slow 1000 --record-video=full-run',
  );
});

test('recipeRunOptionsForProject only passes options supported by the project hook', () => {
  assert.deepEqual(recipeRunOptionsForProject({}, { playbackSlowMs: 1000, recordVideo: true }), {});
  assert.deepEqual(
    recipeRunOptionsForProject(
      { recipe_run_supports_playback_slow: true, recipe_run_supports_video_recording: true },
      { playbackSlowMs: 1000, recordVideo: true },
    ),
    { playbackSlowMs: 1000, recordVideo: true },
  );
});

test('recipeRunUnsupportedOptionWarnings explains ignored replay options without failing', () => {
  assert.deepEqual(
    recipeRunUnsupportedOptionWarnings({}, { playbackSlowMs: 1000, recordVideo: true }),
    [
      'Slow playback requested, but this project has not set recipe_run_supports_playback_slow=true; running at normal speed.',
      'Video recording requested, but this project has not set recipe_run_supports_video_recording=true; replay will not include a video artifact.',
    ],
  );
  assert.deepEqual(
    recipeRunUnsupportedOptionWarnings(
      { recipe_run_supports_playback_slow: true, recipe_run_supports_video_recording: true },
      { playbackSlowMs: 1000, recordVideo: true },
    ),
    [],
  );
});

test('appendRecipePlaybackOptions preserves inclusive slow playback boundaries', () => {
  assert.equal(
    appendRecipePlaybackOptions('node validate-recipe.js --recipe recipe.json', {
      playbackSlowMs: 100,
    }),
    'node validate-recipe.js --recipe recipe.json --slow 100',
  );
  assert.equal(
    appendRecipePlaybackOptions('node validate-recipe.js --recipe recipe.json', {
      playbackSlowMs: 60_000,
    }),
    'node validate-recipe.js --recipe recipe.json --slow 60000',
  );
  assert.throws(
    () =>
      appendRecipePlaybackOptions('node validate-recipe.js --recipe recipe.json', {
        playbackSlowMs: 60_001,
      }),
    /Invalid playback slow-down/,
  );
});

test('appendRecipePlaybackOptions rejects invalid slow playback values', () => {
  assert.throws(
    () =>
      appendRecipePlaybackOptions('node validate-recipe.js --recipe recipe.json', {
        playbackSlowMs: 99,
      }),
    /Invalid playback slow-down/,
  );
});

test('canRecipeRerunOnSlot allows warm review-gate and held slots for the requested run', () => {
  assert.equal(
    canRecipeRerunOnSlot({ currentRunId: 'run-1', phase: 'review-gate' }, 'run-1'),
    true,
  );
  assert.equal(
    canRecipeRerunOnSlot({ currentRunId: 'run-1', phase: 'working', agent: 'working' }, 'run-1'),
    false,
  );
  assert.equal(
    canRecipeRerunOnSlot({ currentRunId: 'other-run', phase: 'review-gate' }, 'run-1'),
    false,
  );
  assert.equal(
    canRecipeRerunOnSlot({ currentRunId: 'run-1', lifecycle: 'held', phase: 'ci-watch' }, 'run-1'),
    true,
  );
  assert.equal(
    canRecipeRerunOnSlot({ currentRunId: 'run-1', lifecycle: 'held', phase: 'pr-watch' }, 'run-1'),
    true,
  );
  // A freshly-prepared/idle slot bound to the run after a warm branch switch is accepted.
  assert.equal(canRecipeRerunOnSlot({ currentRunId: 'run-1', lifecycle: 'ready' }, 'run-1'), true);
  // ...but a bound slot that is mid-worker is still rejected.
  assert.equal(
    canRecipeRerunOnSlot(
      { currentRunId: 'run-1', lifecycle: 'busy', phase: 'working', agent: 'working' },
      'run-1',
    ),
    false,
  );
  // Load-run bind can leave lifecycle busy while the worker is idle.
  assert.equal(
    canRecipeRerunOnSlot(
      { currentRunId: 'run-1', lifecycle: 'busy', phase: 'ci-watch', agent: 'idle' },
      'run-1',
    ),
    true,
  );
});

test('canRecipeRerunOnSlot accepts review-gate slots when currentRunId is missing but run owns the slot', () => {
  assert.equal(
    canRecipeRerunOnSlot(
      { slot: 'slot-1', phase: 'review-gate', currentRunId: null },
      'run-1',
      'slot-1',
    ),
    true,
  );
  assert.equal(
    canRecipeRerunOnSlot(
      { slot: 'slot-1', phase: 'review-gate', currentRunId: null },
      'run-1',
      'slot-2',
    ),
    false,
  );
});

test('canRecipeRerunOnSlot rejects held slots when currentRunId is missing', () => {
  assert.equal(
    canRecipeRerunOnSlot({ lifecycle: 'held', phase: 'ci-watch' }, 'run-1', 'slot-1'),
    false,
  );
});

test('recipeReplayHealthReady accepts any response when ready indicator is unset', () => {
  assert.equal(recipeReplayHealthReady('WalletView', undefined), true);
  assert.equal(recipeReplayHealthReady('', undefined), false);
});

test('recipeReplayHealthReady matches project ready indicator exactly', () => {
  assert.equal(recipeReplayHealthReady('WalletView', 'WalletView'), true);
  assert.equal(recipeReplayHealthReady('LoginView', 'WalletView'), false);
});
