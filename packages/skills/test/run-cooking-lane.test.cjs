#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync } = fs;
const { spawnSync } = require('node:child_process');

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function realPathMaybe(filePath) {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return filePath;
  }
}

function lastNonEmptyLine(value) {
  return (
    String(value || '')
      .trim()
      .split('\n')
      .filter(Boolean)
      .slice(-1)[0] || ''
  );
}

function testCookingLaneWithValidation() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'recipe-cook-lane-'));
  const taskArtifacts = path.join(
    root,
    'projects',
    'example-browser-farm',
    'tasks',
    'review',
    '123',
    'artifacts',
  );
  mkdirSync(taskArtifacts, { recursive: true });
  writeFileSync(
    path.join(taskArtifacts, 'review.md'),
    '# Review\n\nAC1: Keep data live.\n',
    'utf8',
  );
  writeFileSync(path.join(taskArtifacts, 'comment.md'), 'Existing comment context.\n', 'utf8');

  const scenarioConfig = path.join(root, 'recipe-cook', 'assets', 'scenarios.json');
  writeJson(scenarioConfig, {
    version: 1,
    scenarios: [
      {
        id: 'review-explore-markets-live',
        lane: 'review',
        repo: 'example-browser',
        task_artifact_dir: 'projects/example-browser-farm/tasks/review/123/artifacts',
      },
    ],
  });

  const repoRoot = path.join(root, 'example-browser');
  const validatorDir = path.join(repoRoot, 'fixtures', 'agentic', 'recipes');
  mkdirSync(validatorDir, { recursive: true });
  writeFileSync(
    path.join(validatorDir, 'validate-recipe.js'),
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      'const args = process.argv.slice(2);',
      "const artifactsIndex = args.indexOf('--artifacts-dir');",
      'if (artifactsIndex !== -1 && args[artifactsIndex + 1]) {',
      '  const dir = args[artifactsIndex + 1];',
      '  fs.mkdirSync(dir, { recursive: true });',
      "  fs.writeFileSync(path.join(dir, 'trace.json'), JSON.stringify({ ok: true }));",
      '}',
      "console.log(args.includes('--dry-run') ? 'dry run ok' : 'live run ok');",
    ].join('\n'),
    'utf8',
  );

  const runnerPath = path.join(root, 'runner.js');
  writeFileSync(
    runnerPath,
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      "const input = fs.readFileSync(0, 'utf8');",
      'const artifactMatch = input.match(/- output_artifacts_dir: (.+)/);',
      "const artifactsDir = artifactMatch ? artifactMatch[1].trim() : 'artifacts';",
      'process.stdout.write(JSON.stringify({',
      "  task_markdown: ['# Recipe Cook Task', '', '## Task', '', '```text', 'TARGET_REPO: example-browser', 'SOURCE_KIND: review', 'SOURCE_REF: review-explore-markets-live', `ARTIFACT_DIR: ${artifactsDir}`, 'VALIDATION_MODE: mixed', 'STATUS: working', '```', '', '## Validation Evidence', '', 'RECIPE_COOK_VALIDATION_PENDING', ''].join('\\n'),",
      "  recipe_json: { version: 1, steps: [{ id: 'step-1', action: 'assert' }] },",
      "  recipe_cook_json: { version: 1, resolved_targets: ['ac-1-keep-data-live'], unresolved_targets: [], proof_mode_by_target: { 'ac-1-keep-data-live': 'mixed' } },",
      "  evidence_verdict: 'good',",
      "  next_delta: 'Tighten acceptance-criteria extraction.',",
      "  summary: 'Synthetic runner output.'",
      '}));',
    ].join('\n'),
    'utf8',
  );

  const script = path.resolve(__dirname, '../scripts/run-cooking-lane.cjs');
  const outputDir = path.join(root, 'run-output');
  const result = spawnSync(
    process.execPath,
    [
      script,
      '--scenario',
      'review-explore-markets-live',
      '--scenario-config',
      scenarioConfig,
      '--repo-root',
      repoRoot,
      '--output-dir',
      outputDir,
      '--runner-cmd',
      `node ${runnerPath}`,
      '--cdp-port',
      '9222',
    ],
    {
      cwd: root,
      encoding: 'utf8',
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(lastNonEmptyLine(result.stdout), outputDir);

  const task = readFileSync(path.join(outputDir, 'TASK.md'), 'utf8');
  assert.match(task, /STATUS: done/);
  assert.match(
    task,
    new RegExp(`ARTIFACT_DIR: ${outputDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/artifacts`),
  );
  assert.match(task, /dry_run/);
  assert.match(task, /live_run/);
  assert.doesNotMatch(task, /RECIPE_COOK_VALIDATION_PENDING/);

  const learning = JSON.parse(
    readFileSync(path.join(outputDir, 'artifacts', 'recipe-cook-learning.json'), 'utf8'),
  );
  assert.equal(learning.target_repo, 'example-browser');
  assert.equal(learning.validation_results.dry_run.exit_code, 0);
  assert.equal(learning.validation_results.live_run.exit_code, 0);

  const meta = JSON.parse(readFileSync(path.join(outputDir, 'artifacts', 'meta.json'), 'utf8'));
  assert.equal(meta.validate_exit, 0);
  const runMeta = JSON.parse(readFileSync(path.join(outputDir, 'run-meta.json'), 'utf8'));
  assert.equal(runMeta.runner_mode, 'stream');
  assert.match(runMeta.prompt_path, /prompt\.txt$/);
  assert.ok(fs.existsSync(path.join(outputDir, 'runner.log')));
  const runnerLog = readFileSync(path.join(outputDir, 'runner.log'), 'utf8');
  assert.match(runnerLog, /\[recipe-cook\].*runner started in stream mode/);
  assert.match(runnerLog, /\[recipe-cook\].*waiting for runner output/);
  assert.match(runnerLog, /\[recipe-cook\].*stdin: .*prompt\.txt/);
  assert.match(runnerLog, /\[recipe-cook\].*debug repro: cat .*prompt\.txt.*\|/);
  const grade = JSON.parse(readFileSync(path.join(outputDir, 'artifacts', 'grade.json'), 'utf8'));
  assert.equal(grade.recipe_semantic, 'good');
  assert.ok(fs.existsSync(path.join(outputDir, 'artifacts', 'recipe.json')));
  assert.ok(fs.existsSync(path.join(outputDir, 'artifacts', 'recipe-cook.json')));
  assert.ok(fs.existsSync(path.join(outputDir, 'runner-response.json')));
  assert.ok(fs.existsSync(path.join(outputDir, 'SOURCE-BUNDLE.md')));
  const promptText = readFileSync(path.join(outputDir, 'prompt.txt'), 'utf8');
  assert.match(promptText, /Read the run-local task file and follow it top-to-bottom\./);
  assert.match(promptText, /task_file:/);
  assert.match(promptText, /source_bundle_file:/);
  assert.match(
    promptText,
    /The JSON object you return is the final serialized payload for those files\./,
  );
  assert.match(promptText, /Set STATUS to the correct terminal value: done, blocked, or failed/);
  assert.match(promptText, /transport envelope, not the definition of completion/);
  assert.match(
    promptText,
    /For wait_for, prefer timeout_ms and poll_ms instead of guessed aliases like timeout/,
  );
}

function testCookingLaneWithoutValidator() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'recipe-cook-lane-novalidate-'));
  const taskArtifacts = path.join(
    root,
    'projects',
    'example-browser-farm',
    'tasks',
    'fix',
    '456',
    'artifacts',
  );
  mkdirSync(taskArtifacts, { recursive: true });
  writeFileSync(path.join(taskArtifacts, 'comments-report.md'), 'Fix context.\n', 'utf8');

  const scenarioConfig = path.join(root, 'recipe-cook', 'assets', 'scenarios.json');
  writeJson(scenarioConfig, {
    version: 1,
    scenarios: [
      {
        id: 'fix-zero-balance-cta',
        lane: 'fix',
        repo: 'example-browser',
        task_artifact_dir: 'projects/example-browser-farm/tasks/fix/456/artifacts',
      },
    ],
  });

  const runnerPath = path.join(root, 'runner.js');
  writeFileSync(
    runnerPath,
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      "const input = fs.readFileSync(0, 'utf8');",
      'const artifactMatch = input.match(/- output_artifacts_dir: (.+)/);',
      "const artifactsDir = artifactMatch ? artifactMatch[1].trim() : 'artifacts';",
      'process.stdout.write(JSON.stringify({',
      "  task_markdown: ['# Recipe Cook Task', '', '## Task', '', '```text', 'TARGET_REPO: example-browser', 'SOURCE_KIND: fix', 'SOURCE_REF: fix-zero-balance-cta', `ARTIFACT_DIR: ${artifactsDir}`, 'VALIDATION_MODE: state', 'STATUS: working', '```', '', '## Validation Evidence', '', 'RECIPE_COOK_VALIDATION_PENDING', ''].join('\\n'),",
      "  recipe_json: { version: 1, steps: [{ id: 'step-1', action: 'assert' }] },",
      '  recipe_cook_json: null,',
      "  evidence_verdict: 'ok',",
      "  next_delta: 'Add stronger fix-specific source prompts.',",
      "  summary: 'No validator available.'",
      '}));',
    ].join('\n'),
    'utf8',
  );

  const script = path.resolve(__dirname, '../scripts/run-cooking-lane.cjs');
  const outputDir = path.join(root, 'run-output');
  const result = spawnSync(
    process.execPath,
    [
      script,
      '--scenario',
      'fix-zero-balance-cta',
      '--scenario-config',
      scenarioConfig,
      '--repo-root',
      path.join(root, 'missing-repo'),
      '--output-dir',
      outputDir,
      '--runner-cmd',
      `node ${runnerPath}`,
      '--runner-mode',
      'batch',
    ],
    {
      cwd: root,
      encoding: 'utf8',
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);

  const task = readFileSync(path.join(outputDir, 'TASK.md'), 'utf8');
  assert.match(task, /validation unavailable/);
  assert.doesNotMatch(task, /RECIPE_COOK_VALIDATION_PENDING/);
  assert.match(task, /STATUS: done/);
  assert.ok(fs.existsSync(path.join(outputDir, 'SOURCE-BUNDLE.md')));
  const meta = JSON.parse(readFileSync(path.join(outputDir, 'artifacts', 'meta.json'), 'utf8'));
  assert.equal(meta.validate_exit, -1);
  const learning = JSON.parse(
    readFileSync(path.join(outputDir, 'artifacts', 'recipe-cook-learning.json'), 'utf8'),
  );
  assert.deepEqual(learning.validation_results, {});
  const runMeta = JSON.parse(readFileSync(path.join(outputDir, 'run-meta.json'), 'utf8'));
  assert.equal(runMeta.runner_mode, 'batch');
  assert.equal(runMeta.runner_log, null);
}

function testCookingLanePreservesFailedStatus() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'recipe-cook-lane-failed-'));
  const taskArtifacts = path.join(
    root,
    'projects',
    'example-browser-farm',
    'tasks',
    'review',
    '111',
    'artifacts',
  );
  mkdirSync(taskArtifacts, { recursive: true });
  writeFileSync(path.join(taskArtifacts, 'review.md'), 'Failure context.\n', 'utf8');

  const scenarioConfig = path.join(root, 'scenarios.json');
  writeJson(scenarioConfig, {
    version: 1,
    scenarios: [
      {
        id: 'review-failed',
        lane: 'review',
        repo: 'example-browser',
        task_artifact_dir: taskArtifacts,
      },
    ],
  });

  const repoRoot = path.join(root, 'example-browser');
  mkdirSync(path.join(repoRoot, '.git'), { recursive: true });
  const validatorDir = path.join(repoRoot, 'fixtures', 'agentic', 'recipes');
  mkdirSync(validatorDir, { recursive: true });
  writeFileSync(path.join(validatorDir, 'validate-recipe.js'), 'process.exit(1)\n', 'utf8');

  const runnerPath = path.join(root, 'runner.js');
  writeFileSync(
    runnerPath,
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      "const input = fs.readFileSync(0, 'utf8');",
      'const artifactMatch = input.match(/- output_artifacts_dir: (.+)/);',
      "const artifactsDir = artifactMatch ? artifactMatch[1].trim() : 'artifacts';",
      'process.stdout.write(JSON.stringify({',
      "  task_markdown: ['# Recipe Cook Task', '', '## Task', '', '```text', 'TARGET_REPO: example-browser', 'SOURCE_KIND: review', 'SOURCE_REF: failed', `ARTIFACT_DIR: ${artifactsDir}`, 'VALIDATION_MODE: mixed', 'STATUS: failed', '```', '', '## Validation Evidence', '', 'RECIPE_COOK_VALIDATION_PENDING', ''].join('\\n'),",
      '  recipe_json: { version: 1, steps: [] },',
      '  recipe_cook_json: null,',
      "  evidence_verdict: 'bad',",
      "  next_delta: 'fix failure',",
      "  summary: 'failed run' }));",
    ].join('\n'),
    'utf8',
  );

  const script = path.resolve(__dirname, '../scripts/run-cooking-lane.cjs');
  const outputDir = path.join(root, 'run-output');
  const result = spawnSync(
    process.execPath,
    [
      script,
      '--scenario',
      'review-failed',
      '--scenario-config',
      scenarioConfig,
      '--repo-root',
      repoRoot,
      '--output-dir',
      outputDir,
      '--runner-cmd',
      `node ${runnerPath}`,
      '--runner-mode',
      'batch',
    ],
    {
      cwd: root,
      encoding: 'utf8',
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const task = readFileSync(path.join(outputDir, 'TASK.md'), 'utf8');
  assert.match(task, /STATUS: failed/);
  const meta = JSON.parse(readFileSync(path.join(outputDir, 'artifacts', 'meta.json'), 'utf8'));
  assert.equal(meta.outcome, 'failed');
}

function testCookingLanePreservesBlockedStatus() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'recipe-cook-lane-blocked-'));
  const taskArtifacts = path.join(
    root,
    'projects',
    'example-mobile-farm',
    'tasks',
    'review',
    '999',
    'artifacts',
  );
  mkdirSync(taskArtifacts, { recursive: true });
  writeFileSync(path.join(taskArtifacts, 'review.md'), 'Blocked context.\n', 'utf8');

  const scenarioConfig = path.join(root, 'scenarios.json');
  writeJson(scenarioConfig, {
    version: 1,
    scenarios: [
      {
        id: 'mobile-review',
        lane: 'review',
        repo: 'example-mobile',
        task_artifact_dir: taskArtifacts,
      },
    ],
  });

  const repoRoot = path.join(root, 'example-mobile-4');
  mkdirSync(path.join(repoRoot, '.git'), { recursive: true });

  const runnerPath = path.join(root, 'runner.js');
  writeFileSync(
    runnerPath,
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      "const input = fs.readFileSync(0, 'utf8');",
      'const artifactMatch = input.match(/- output_artifacts_dir: (.+)/);',
      "const artifactsDir = artifactMatch ? artifactMatch[1].trim() : 'artifacts';",
      'process.stdout.write(JSON.stringify({',
      "  task_markdown: ['# Recipe Cook Task', '', '## Task', '', '```text', 'TARGET_REPO: example-mobile', 'SOURCE_KIND: review', 'SOURCE_REF: blocked', `ARTIFACT_DIR: ${artifactsDir}`, 'VALIDATION_MODE: live', 'STATUS: blocked', '```', '', '## Validation Evidence', '', 'RECIPE_COOK_VALIDATION_PENDING', '', 'Reason: live slot unavailable'].join('\\n'),",
      '  recipe_json: { version: 1, steps: [] },',
      '  recipe_cook_json: null,',
      "  evidence_verdict: 'ok',",
      "  next_delta: 'none',",
      "  summary: 'blocked run' }));",
    ].join('\n'),
    'utf8',
  );

  const script = path.resolve(__dirname, '../scripts/run-cooking-lane.cjs');
  const outputDir = path.join(root, 'run-output');
  const result = spawnSync(
    process.execPath,
    [
      script,
      '--scenario',
      'mobile-review',
      '--scenario-config',
      scenarioConfig,
      '--repo-root',
      repoRoot,
      '--output-dir',
      outputDir,
      '--runner-cmd',
      `node ${runnerPath}`,
      '--runner-mode',
      'batch',
    ],
    {
      cwd: root,
      encoding: 'utf8',
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const task = readFileSync(path.join(outputDir, 'TASK.md'), 'utf8');
  assert.match(task, /STATUS: blocked/);
  const meta = JSON.parse(readFileSync(path.join(outputDir, 'artifacts', 'meta.json'), 'utf8'));
  assert.equal(meta.outcome, 'blocked');
}

function testCookingLaneBlocksOnUnresolvedTarget() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'recipe-cook-lane-unresolved-'));
  const taskArtifacts = path.join(
    root,
    'projects',
    'example-mobile-farm',
    'tasks',
    'review',
    '222',
    'artifacts',
  );
  mkdirSync(taskArtifacts, { recursive: true });
  writeFileSync(path.join(taskArtifacts, 'review.md'), 'Unresolved context.\n', 'utf8');

  const scenarioConfig = path.join(root, 'scenarios.json');
  writeJson(scenarioConfig, {
    version: 1,
    scenarios: [
      {
        id: 'mobile-review',
        lane: 'review',
        repo: 'example-mobile',
        task_artifact_dir: taskArtifacts,
      },
    ],
  });

  const repoRoot = path.join(root, 'example-mobile-4');
  mkdirSync(path.join(repoRoot, '.git'), { recursive: true });

  const runnerPath = path.join(root, 'runner.js');
  writeFileSync(
    runnerPath,
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      "const input = fs.readFileSync(0, 'utf8');",
      'const artifactMatch = input.match(/- output_artifacts_dir: (.+)/);',
      "const artifactsDir = artifactMatch ? artifactMatch[1].trim() : 'artifacts';",
      'process.stdout.write(JSON.stringify({',
      "  task_markdown: ['# Recipe Cook Task', '', '## Task', '', '```text', 'TARGET_REPO: example-mobile', 'SOURCE_KIND: review', 'SOURCE_REF: unresolved', `ARTIFACT_DIR: ${artifactsDir}`, 'VALIDATION_MODE: live', 'STATUS: working', '```', '', '## Resolved vs Unresolved', '', '- PT-1: UNRESOLVED — live blocker', '', '## Validation Evidence', '', 'RECIPE_COOK_VALIDATION_PENDING'].join('\\n'),",
      '  recipe_json: { version: 1, steps: [] },',
      '  recipe_cook_json: null,',
      "  evidence_verdict: 'ok',",
      "  next_delta: 'none',",
      "  summary: 'unresolved run' }));",
    ].join('\n'),
    'utf8',
  );

  const script = path.resolve(__dirname, '../scripts/run-cooking-lane.cjs');
  const outputDir = path.join(root, 'run-output');
  const result = spawnSync(
    process.execPath,
    [
      script,
      '--scenario',
      'mobile-review',
      '--scenario-config',
      scenarioConfig,
      '--repo-root',
      repoRoot,
      '--output-dir',
      outputDir,
      '--runner-cmd',
      `node ${runnerPath}`,
      '--runner-mode',
      'batch',
    ],
    {
      cwd: root,
      encoding: 'utf8',
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const task = readFileSync(path.join(outputDir, 'TASK.md'), 'utf8');
  assert.match(task, /STATUS: blocked/);
  const meta = JSON.parse(readFileSync(path.join(outputDir, 'artifacts', 'meta.json'), 'utf8'));
  assert.equal(meta.outcome, 'blocked');
}

function testCookingLaneDoesNotBlockOnResolvedVsUnresolvedHeadingAlone() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'recipe-cook-lane-heading-only-'));
  const taskArtifacts = path.join(
    root,
    'projects',
    'example-mobile-farm',
    'tasks',
    'review',
    '333',
    'artifacts',
  );
  mkdirSync(taskArtifacts, { recursive: true });
  writeFileSync(path.join(taskArtifacts, 'review.md'), 'Resolved heading context.\n', 'utf8');

  const scenarioConfig = path.join(root, 'scenarios.json');
  writeJson(scenarioConfig, {
    version: 1,
    scenarios: [
      {
        id: 'mobile-review',
        lane: 'review',
        repo: 'example-mobile',
        task_artifact_dir: taskArtifacts,
      },
    ],
  });

  const repoRoot = path.join(root, 'example-mobile-4');
  mkdirSync(path.join(repoRoot, '.git'), { recursive: true });

  const runnerPath = path.join(root, 'runner.js');
  writeFileSync(
    runnerPath,
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      "const input = fs.readFileSync(0, 'utf8');",
      'const artifactMatch = input.match(/- output_artifacts_dir: (.+)/);',
      "const artifactsDir = artifactMatch ? artifactMatch[1].trim() : 'artifacts';",
      'process.stdout.write(JSON.stringify({',
      '  task_markdown: [',
      "    '# Recipe Cook Task',",
      "    '',",
      "    '## Task',",
      "    '',",
      "    '```text',",
      "    'TARGET_REPO: example-mobile',",
      "    'SOURCE_KIND: review',",
      "    'SOURCE_REF: heading-only',",
      '    `ARTIFACT_DIR: ${artifactsDir}`,',
      "    'VALIDATION_MODE: live',",
      "    'STATUS: done',",
      "    '```',",
      "    '',",
      "    '## Resolved vs Unresolved',",
      "    '',",
      "    '- resolved targets: all covered',",
      "    '- unresolved targets: none',",
      "    '',",
      "    '## Validation Evidence',",
      "    '',",
      "    'RECIPE_COOK_VALIDATION_PENDING',",
      "  ].join('\\n'),",
      '  recipe_json: { version: 1, steps: [] },',
      '  recipe_cook_json: null,',
      "  evidence_verdict: 'ok',",
      "  next_delta: 'none',",
      "  summary: 'heading-only run' }));",
    ].join('\n'),
    'utf8',
  );

  const script = path.resolve(__dirname, '../scripts/run-cooking-lane.cjs');
  const outputDir = path.join(root, 'run-output');
  const result = spawnSync(
    process.execPath,
    [
      script,
      '--scenario',
      'mobile-review',
      '--scenario-config',
      scenarioConfig,
      '--repo-root',
      repoRoot,
      '--output-dir',
      outputDir,
      '--runner-cmd',
      `node ${runnerPath}`,
      '--runner-mode',
      'batch',
    ],
    {
      cwd: root,
      encoding: 'utf8',
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const task = readFileSync(path.join(outputDir, 'TASK.md'), 'utf8');
  assert.match(task, /STATUS: done/);
  const meta = JSON.parse(readFileSync(path.join(outputDir, 'artifacts', 'meta.json'), 'utf8'));
  assert.equal(meta.outcome, 'completed');
}

function testRepoLocalAutoResolution() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'recipe-cook-repo-local-'));
  const taskArtifacts = path.join(
    root,
    'projects',
    'example-browser-farm',
    'tasks',
    'review',
    '789',
    'artifacts',
  );
  mkdirSync(taskArtifacts, { recursive: true });
  writeFileSync(path.join(taskArtifacts, 'review.md'), 'Repo-local context.\n', 'utf8');

  const scenarioConfig = path.join(root, 'scenarios.json');
  writeJson(scenarioConfig, {
    version: 1,
    scenarios: [
      {
        id: 'review-explore-markets-live',
        lane: 'review',
        repo: 'example-browser',
        task_artifact_dir: taskArtifacts,
      },
    ],
  });

  const repoRoot = path.join(root, 'example-browser-1');
  mkdirSync(path.join(repoRoot, '.git'), { recursive: true });
  mkdirSync(path.join(repoRoot, 'temp', '.agent'), { recursive: true });
  writeFileSync(
    path.join(repoRoot, 'temp', '.agent', 'agentic-toolkit.md'),
    'Browser uses live CDP on `7777`.\n',
    'utf8',
  );
  const validatorDir = path.join(repoRoot, 'temp', 'agentic', 'recipes');
  mkdirSync(validatorDir, { recursive: true });
  writeFileSync(
    path.join(validatorDir, 'validate-recipe.js'),
    ["console.log(process.argv.includes('--dry-run') ? 'dry' : 'live');"].join('\n'),
    'utf8',
  );

  const runnerPath = path.join(root, 'runner.js');
  writeFileSync(
    runnerPath,
    [
      "const fs = require('node:fs');",
      "const input = fs.readFileSync(0, 'utf8');",
      'const artifactMatch = input.match(/- output_artifacts_dir: (.+)/);',
      "const artifactsDir = artifactMatch ? artifactMatch[1].trim() : 'artifacts';",
      'process.stdout.write(JSON.stringify({',
      "  task_markdown: ['# Recipe Cook Task', '', '## Task', '', '```text', 'TARGET_REPO: example-browser', 'SOURCE_KIND: review', 'SOURCE_REF: repo-local', `ARTIFACT_DIR: ${artifactsDir}`, 'VALIDATION_MODE: mixed', 'STATUS: working', '```', '', '## Validation Evidence', '', 'RECIPE_COOK_VALIDATION_PENDING', ''].join('\\n'),",
      '  recipe_json: { version: 1, steps: [] },',
      '  recipe_cook_json: null,',
      "  evidence_verdict: 'ok',",
      "  next_delta: 'none',",
      "  summary: 'repo-local' }));",
    ].join('\n'),
    'utf8',
  );

  const script = path.resolve(__dirname, '../scripts/run-cooking-lane.cjs');
  const outputDir = path.join(root, 'repo-local-output');
  const result = spawnSync(
    process.execPath,
    [
      script,
      '--scenario',
      'review-explore-markets-live',
      '--scenario-config',
      scenarioConfig,
      '--output-dir',
      outputDir,
      '--runner-cmd',
      `node ${runnerPath}`,
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const runMeta = JSON.parse(readFileSync(path.join(outputDir, 'run-meta.json'), 'utf8'));
  assert.equal(realPathMaybe(runMeta.project_root), realPathMaybe(repoRoot));
  assert.equal(runMeta.slot_resolution, 'repo-local');
  assert.equal(runMeta.cdp_port, '7777');
  const task = readFileSync(path.join(outputDir, 'TASK.md'), 'utf8');
  assert.match(task, /--cdp-port 7777/);
  assert.ok(fs.existsSync(path.join(outputDir, 'SOURCE-BUNDLE.md')));
}

function testStreamingRunnerMirrorsProgress() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'recipe-cook-lane-stream-'));
  const taskArtifacts = path.join(
    root,
    'projects',
    'example-mobile-farm',
    'tasks',
    'review',
    '888',
    'artifacts',
  );
  mkdirSync(taskArtifacts, { recursive: true });
  writeFileSync(path.join(taskArtifacts, 'review.md'), 'Streaming context.\n', 'utf8');

  const scenarioConfig = path.join(root, 'scenarios.json');
  writeJson(scenarioConfig, {
    version: 1,
    scenarios: [
      {
        id: 'mobile-review',
        lane: 'review',
        repo: 'example-mobile',
        task_artifact_dir: taskArtifacts,
      },
    ],
  });

  const repoRoot = path.join(root, 'example-mobile-4');
  mkdirSync(path.join(repoRoot, '.git'), { recursive: true });
  mkdirSync(path.join(repoRoot, '.agent'), { recursive: true });
  writeFileSync(path.join(repoRoot, '.agent', 'agentic-toolkit.md'), 'Mobile toolkit.\n', 'utf8');
  const validatorDir = path.join(repoRoot, 'scripts', 'recipe', 'agentic');
  mkdirSync(validatorDir, { recursive: true });
  writeFileSync(
    path.join(validatorDir, 'validate-recipe.sh'),
    ['#!/bin/bash', 'echo "$1"'].join('\n'),
    'utf8',
  );

  const runnerPath = path.join(root, 'stream-runner.js');
  writeFileSync(
    runnerPath,
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      "const input = fs.readFileSync(0, 'utf8');",
      'const artifactMatch = input.match(/- output_artifacts_dir: (.+)/);',
      "const artifactsDir = artifactMatch ? artifactMatch[1].trim() : 'artifacts';",
      "process.stderr.write('progress: synthesize\\n');",
      'setTimeout(() => {',
      '  process.stdout.write(JSON.stringify({',
      "    task_markdown: ['# Recipe Cook Task', '', '## Task', '', '```text', 'TARGET_REPO: example-mobile', 'SOURCE_KIND: review', 'SOURCE_REF: mobile-review', `ARTIFACT_DIR: ${artifactsDir}`, 'VALIDATION_MODE: state', 'STATUS: working', '```', '', '## Validation Evidence', '', 'RECIPE_COOK_VALIDATION_PENDING', ''].join('\\n'),",
      "    recipe_json: { version: 1, steps: [{ id: 'step-1', action: 'assert' }] },",
      '    recipe_cook_json: null,',
      "    evidence_verdict: 'ok',",
      "    next_delta: 'Keep stream mode default.',",
      "    summary: 'streaming runner output'",
      '  }));',
      '}, 20);',
    ].join('\n'),
    'utf8',
  );

  const script = path.resolve(__dirname, '../scripts/run-cooking-lane.cjs');
  const outputDir = path.join(root, 'stream-output');
  const result = spawnSync(
    process.execPath,
    [
      script,
      '--scenario',
      'mobile-review',
      '--scenario-config',
      scenarioConfig,
      '--repo-root',
      repoRoot,
      '--output-dir',
      outputDir,
      '--runner-cmd',
      `node ${runnerPath}`,
    ],
    {
      cwd: root,
      encoding: 'utf8',
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(lastNonEmptyLine(result.stdout), outputDir);
  assert.match(result.stderr, /\[recipe-cook\].*runner started in stream mode/);
  assert.match(result.stderr, /progress: synthesize/);
  const runMeta = JSON.parse(readFileSync(path.join(outputDir, 'run-meta.json'), 'utf8'));
  assert.equal(runMeta.runner_mode, 'stream');
  assert.match(runMeta.prompt_path, /prompt\.txt$/);
  const runnerLog = readFileSync(path.join(outputDir, 'runner.log'), 'utf8');
  assert.match(runnerLog, /\[recipe-cook\].*waiting for runner output/);
  assert.match(runnerLog, /\[recipe-cook\].*debug repro: cat .*prompt\.txt.*\|/);
  assert.match(runnerLog, /progress: synthesize/);
}

function main() {
  testCookingLaneWithValidation();
  testCookingLaneWithoutValidator();
  testCookingLanePreservesBlockedStatus();
  testCookingLaneBlocksOnUnresolvedTarget();
  testCookingLaneDoesNotBlockOnResolvedVsUnresolvedHeadingAlone();
  testCookingLanePreservesFailedStatus();
  testRepoLocalAutoResolution();
  testStreamingRunnerMirrorsProgress();
  process.stdout.write('run-cooking-lane tests: ok\n');
}

main();
