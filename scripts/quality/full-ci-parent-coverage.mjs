import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';

import { loadWorkspacePackages } from '../release/lib/workspace-utils.mjs';

import { compareCoverage, monolithicCoverage } from './full-ci-coverage.mjs';
import { GIT_LOCATION_ENV } from './run-tsx-tests.mjs';

function stepsFromSource(source) {
  const file = ts.createSourceFile('run-quality.mjs', source, ts.ScriptTarget.Latest, true);
  let result;
  function literal(node) {
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isArrayLiteralExpression(node)) return node.elements.map(literal);
    throw new Error('Baseline quality steps must be explicit command arrays');
  }
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === 'STEPS')
      result = literal(node.initializer);
    ts.forEachChild(node, visit);
  }
  visit(file);
  if (!result) throw new Error('Cannot find baseline quality steps');
  return result;
}

export function compareParentCoverage(root, ref, matrix) {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(ref))
    throw new Error('Coverage baseline must be an exact commit SHA');
  const env = { ...process.env };
  for (const key of GIT_LOCATION_ENV) delete env[key];
  const fromGit = (file) => {
    const result = spawnSync('git', ['show', `${ref}:${file}`], {
      cwd: root,
      env,
      encoding: 'utf8',
    });
    if (result.status !== 0) throw new Error(`Cannot read baseline ${file}: ${result.stderr}`);
    return result.stdout;
  };
  // This comparison is for the CI-only migration. Do not silently compare new
  // package scripts against old commands or resolve a different test tree.
  const unchanged = [
    'package.json',
    'scripts/quality/ci-local.mjs',
    'scripts/quality/ci-full-supplement.mjs',
    'scripts/quality/run-workspace-quality.mjs',
    ...[...loadWorkspacePackages(root).keys()].map((dir) => `${dir}/package.json`),
  ];
  for (const file of unchanged)
    if (fromGit(file) !== readFileSync(path.join(root, file), 'utf8'))
      throw new Error(`Baseline input changed: ${file}; use the matching main base`);
  const qualitySteps = stepsFromSource(fromGit('scripts/quality/run-quality.mjs'));
  const baseline = monolithicCoverage(root, { qualitySteps });
  const diff = compareCoverage(baseline, matrix);
  if (diff.missingFiles.length || diff.missingGuards.length)
    throw new Error(`Pre-change coverage lost: ${JSON.stringify(diff)}`);
  return { ref, baseline, matrix, diff };
}
