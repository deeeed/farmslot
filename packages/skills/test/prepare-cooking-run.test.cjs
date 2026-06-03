#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync } = fs;
const { spawnSync } = require('node:child_process');

function testTextSource() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'recipe-cook-prepare-text-'));
  const repoRoot = path.join(root, 'example-mobile-4');
  mkdirSync(repoRoot, { recursive: true });

  const script = path.resolve(__dirname, '../scripts/prepare-cooking-run.cjs');
  const outputDir = path.join(root, 'out-text');
  const result = spawnSync(
    process.execPath,
    [
      script,
      '--repo-root',
      repoRoot,
      '--source-kind',
      'text',
      '--source-ref',
      'demo-text',
      '--source-text',
      'Investigate reverse position pricing',
      '--output-dir',
      outputDir,
    ],
    {
      encoding: 'utf8',
      cwd: repoRoot,
      env: {
        ...process.env,
        JIRA_API_TOKEN: '',
        JIRA_EMAIL: '',
      },
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout.trim(), outputDir);
  assert.ok(fs.existsSync(path.join(outputDir, 'TASK.md')));
  assert.ok(fs.existsSync(path.join(outputDir, 'SOURCE-BUNDLE.md')));
  const task = readFileSync(path.join(outputDir, 'TASK.md'), 'utf8');
  assert.match(task, /SOURCE_KIND: text/);
  assert.match(task, /SOURCE_REF: demo-text/);
  const bundle = readFileSync(path.join(outputDir, 'SOURCE-BUNDLE.md'), 'utf8');
  assert.match(bundle, /Source Kind: Text/);
  assert.match(bundle, /Investigate reverse position pricing/);
}

function testFileSource() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'recipe-cook-prepare-file-'));
  const repoRoot = path.join(root, 'example-browser-1');
  mkdirSync(repoRoot, { recursive: true });
  const sourcePath = path.join(root, 'source.txt');
  writeFileSync(sourcePath, 'Fix stale market pricing\n', 'utf8');

  const script = path.resolve(__dirname, '../scripts/prepare-cooking-run.cjs');
  const outputDir = path.join(root, 'out-file');
  const result = spawnSync(
    process.execPath,
    [
      script,
      '--repo-root',
      repoRoot,
      '--source-kind',
      'file',
      '--source-ref',
      sourcePath,
      '--output-dir',
      outputDir,
    ],
    {
      encoding: 'utf8',
      cwd: repoRoot,
      env: {
        ...process.env,
        JIRA_API_TOKEN: '',
        JIRA_EMAIL: '',
      },
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const bundle = readFileSync(path.join(outputDir, 'SOURCE-BUNDLE.md'), 'utf8');
  assert.match(bundle, /Source Kind: File/);
  assert.match(bundle, /Fix stale market pricing/);
}

function testWrapperUsesGenericFixbugTemplate() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'recipe-cook-prepare-example-fixbug-'));
  const repoRoot = path.join(root, 'example-browser-1');
  mkdirSync(repoRoot, { recursive: true });

  const script = path.resolve(__dirname, '../scripts/prepare-cooking-run.cjs');
  const outputDir = path.join(root, 'out-example-fixbug');
  const result = spawnSync(
    process.execPath,
    [
      script,
      '--repo-root',
      repoRoot,
      '--source-kind',
      'text',
      '--source-ref',
      'browser-bug',
      '--source-text',
      'Chart filter reset bug.',
      '--wrapper',
      'example-fixbug',
      '--output-dir',
      outputDir,
    ],
    {
      encoding: 'utf8',
      cwd: repoRoot,
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const task = readFileSync(path.join(outputDir, 'TASK.md'), 'utf8');
  assert.match(task, /# Recipe Cook Task Template/);
  assert.match(task, /WRAPPER: example-fixbug/);
  assert.match(task, /## Acceptance Criteria/);
  assert.match(task, /## Validation Evidence/);
  const meta = JSON.parse(readFileSync(path.join(outputDir, 'run-meta.json'), 'utf8'));
  assert.equal(meta.wrapper, 'example-fixbug');
  assert.match(meta.template_path, /recipe-cook\/references\/TASK\.md$/);
}

function testWrapperUsesGenericReviewTemplate() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'recipe-cook-prepare-example-review-'));
  const repoRoot = path.join(root, 'example-browser-1');
  mkdirSync(repoRoot, { recursive: true });

  const script = path.resolve(__dirname, '../scripts/prepare-cooking-run.cjs');
  const outputDir = path.join(root, 'out-example-review');
  const result = spawnSync(
    process.execPath,
    [
      script,
      '--repo-root',
      repoRoot,
      '--source-kind',
      'text',
      '--source-ref',
      'browser-review',
      '--source-text',
      'Review this browser app PR.',
      '--wrapper',
      'example-review',
      '--output-dir',
      outputDir,
    ],
    {
      encoding: 'utf8',
      cwd: repoRoot,
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const task = readFileSync(path.join(outputDir, 'TASK.md'), 'utf8');
  assert.match(task, /# Recipe Cook Task Template/);
  assert.match(task, /WRAPPER: example-review/);
  assert.match(task, /## Acceptance Criteria/);
  assert.match(task, /## Validation Evidence/);
  const meta = JSON.parse(readFileSync(path.join(outputDir, 'run-meta.json'), 'utf8'));
  assert.equal(meta.wrapper, 'example-review');
  assert.match(meta.template_path, /recipe-cook\/references\/TASK\.md$/);
}

function testJiraFallbackBundleFromUrl() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'recipe-cook-prepare-jira-'));
  const repoRoot = path.join(root, 'example-browser-1');
  mkdirSync(repoRoot, { recursive: true });

  const script = path.resolve(__dirname, '../scripts/prepare-cooking-run.cjs');
  const outputDir = path.join(root, 'out-jira');
  const result = spawnSync(
    process.execPath,
    [
      script,
      '--repo-root',
      repoRoot,
      '--wrapper',
      'example-fixbug',
      '--source-kind',
      'jira',
      '--source-ref',
      'https://jira.example.com/browse/APP-2847',
      '--jira-base-url',
      'https://jira.example.com',
      '--output-dir',
      outputDir,
    ],
    {
      encoding: 'utf8',
      cwd: repoRoot,
      env: {
        ...process.env,
        JIRA_API_TOKEN: '',
        JIRA_EMAIL: '',
      },
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const bundle = readFileSync(path.join(outputDir, 'SOURCE-BUNDLE.md'), 'utf8');
  assert.match(bundle, /Source Kind: Jira/);
  assert.match(bundle, /Source Ref: APP-2847/);
  assert.match(bundle, /Source URL: https:\/\/jira\.example\.com\/browse\/APP-2847/);
  assert.match(bundle, /Jira API fetch unavailable/);
}

function main() {
  testTextSource();
  testFileSource();
  testWrapperUsesGenericFixbugTemplate();
  testWrapperUsesGenericReviewTemplate();
  testJiraFallbackBundleFromUrl();
  process.stdout.write('prepare-cooking-run tests: ok\n');
}

main();
