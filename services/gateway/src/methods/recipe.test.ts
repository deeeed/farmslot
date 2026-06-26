import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

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

test('expandRecipeRunHookTemplate expands slot variables and shell-safe recipe paths', () => {
  assert.equal(
    expandRecipeRunHookTemplate(
      'cd {{repo}} && node runner.js --recipe {{recipe_path}} --artifacts-dir {{artifacts_dir}} --cdp-port {{cdp_port}} --slot {{slot_id}} --runtime {{runtime_dir}} --platform {{platform}} --simulator "{{simulator}}" --adb {{adb_serial}}',
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
    ),
    "cd /repo && node runner.js --recipe '/repo/.task/run/recipe.json' --artifacts-dir '/repo/.task/run/artifacts/recipe-runs/manual-1' --cdp-port 9222 --slot runner-browser-1 --runtime .agent --platform chrome-extension --simulator \"iPhone 16\" --adb emulator-5554",
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
        runner_protocol_version: 1,
        action_registry_version: 1,
        supported_official_actions: ['end'],
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

test('resolveSlotRecipePath keeps bundled recipe paths within the current task directory', () => {
  const recipeArtifactRoot = '/repo/tasks/current-task';

  assert.equal(
    resolveSlotRecipePath(recipeArtifactRoot, 'recipe-flows/subflow.json'),
    '/repo/tasks/current-task/recipe-flows/subflow.json',
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
      'artifacts/recipe-flows/subflow.json',
    ),
    '/repo/tasks/current-task/artifacts/recipe-runs/passing-run/recipe-flows/subflow.json',
  );
});

test('resolveSlotRecipePath preserves remote ~/... roots when targeting selected recipe-run paths', () => {
  assert.equal(
    resolveSlotRecipePath(
      '~/repo/tasks/current-task/artifacts/recipe-runs/passing-run',
      'artifacts/recipe-flows/subflow.json',
    ),
    '~/repo/tasks/current-task/artifacts/recipe-runs/passing-run/recipe-flows/subflow.json',
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
  assert.equal(
    canRecipeRerunOnSlot({ currentRunId: 'run-1', lifecycle: 'ready' }, 'run-1'),
    true,
  );
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
