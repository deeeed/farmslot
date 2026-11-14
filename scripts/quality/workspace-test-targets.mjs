import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { loadWorkspacePackages } from '../release/lib/workspace-utils.mjs';

import { filterMatches, PATH_FILTERS } from './lib/path-filters.mjs';
import { isMainModule } from './lib/step-timing.mjs';

// These suites use an app-specific job name or live in a parent workspace.
const APP_OWNERS = {
  '@farmslot/command-center': 'command_center',
  '@farmslot/command-center-ui': 'command_center',
  '@farmslot/command-center-desktop': 'desktop',
  '@farmslot/mobile': 'companion',
};
const SHARED_INPUTS = new Set([
  'package.json',
  'yarn.lock',
  '.yarnrc.yml',
  '.github/workflows/farmslot-quality.yml',
  'scripts/quality/workspace-test-targets.mjs',
]);

export function selectWorkspaceTests(workspaces, changedFiles, filters, jobIds) {
  const all =
    changedFiles === null ||
    changedFiles.some(
      (file) =>
        SHARED_INPUTS.has(file) ||
        file.startsWith('scripts/quality/run-tsx-tests') ||
        file.startsWith('scripts/yarn-') ||
        file.startsWith('.yarn/'),
    );
  const affected = new Set(
    workspaces
      .filter(
        (workspace) =>
          all ||
          changedFiles.some(
            (file) => file === workspace.dir || file.startsWith(`${workspace.dir}/`),
          ),
      )
      .map(({ name }) => name),
  );
  // Include consumers of changed workspace dependencies, including dev/test helpers.
  let expanded;
  do {
    expanded = false;
    for (const workspace of workspaces) {
      if (
        !affected.has(workspace.name) &&
        workspace.dependencies.some((name) => affected.has(name))
      ) {
        affected.add(workspace.name);
        expanded = true;
      }
    }
  } while (expanded);

  const targets = new Set(Object.keys(filters).filter((name) => filters[name] === 'true'));
  // Existing filters also describe source dependencies outside package manifests.
  const affectedPaths = workspaces
    .filter(({ name }) => affected.has(name))
    .map(({ dir }) => `${dir}/package.json`);
  for (const [target, patterns] of Object.entries(PATH_FILTERS)) {
    if (target in filters && filterMatches(affectedPaths, patterns)) targets.add(target);
  }
  const matrix = [];
  const coverage = [];
  for (const workspace of workspaces) {
    const appOwner = APP_OWNERS[workspace.name];
    if (!workspace.test && !appOwner) continue;
    const target = appOwner ?? workspace.name.replace('@farmslot/', '').replaceAll('-', '_');
    const ownsTests = appOwner || /\byarn(?: run)? test(?:\s|$)/.test(workspace.quality ?? '');
    const owner =
      ownsTests && target in filters && jobIds.has(target.replaceAll('_', '-'))
        ? target
        : 'workspace-tests';
    coverage.push({ workspace: workspace.name, owner, affected: affected.has(workspace.name) });
    if (!affected.has(workspace.name)) continue;
    if (owner === 'workspace-tests') {
      matrix.push({ workspace: workspace.name, script: ownsTests ? 'quality' : 'test' });
    } else targets.add(owner);
  }
  return { targets: [...targets].sort(), matrix, coverage };
}

export function workspaceTestCatalog(repoRoot) {
  const catalog = [...loadWorkspacePackages(repoRoot)].map(([dir, pkg]) => ({
    dir,
    name: pkg.name,
    test: pkg.scripts?.test,
    quality: pkg.scripts?.quality,
    dependencies: Object.keys({
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.peerDependencies,
      ...pkg.optionalDependencies,
    }),
  }));
  const tracked = spawnSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' });
  if (tracked.status !== 0) throw new Error(`Cannot inventory workspace tests: ${tracked.stderr}`);
  assertWorkspaceTestScripts(catalog, tracked.stdout.split('\0').filter(Boolean));
  return catalog;
}

export function assertWorkspaceTestScripts(workspaces, files) {
  const nestedFirst = [...workspaces].sort((left, right) => right.dir.length - left.dir.length);
  for (const file of files) {
    if (!/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)) continue;
    const workspace = nestedFirst.find(({ dir }) => file.startsWith(`${dir}/`));
    if (workspace && !workspace.test && !APP_OWNERS[workspace.name]) {
      throw new Error(`${workspace.name} contains ${file} but defines no test script`);
    }
  }
}

function changedFiles(repoRoot) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const base = event.pull_request?.base?.sha ?? event.before;
  if (!base || /^0+$/.test(base)) return null;
  const result = spawnSync('git', ['diff', '--name-only', '-z', base, 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`Cannot determine workspace changes: ${result.stderr}`);
  return result.stdout.split('\0').filter(Boolean);
}

if (isMainModule(import.meta.url)) {
  const repoRoot = process.cwd();
  const filters = JSON.parse(process.env.QUALITY_FILTER_OUTPUTS);
  const workflow = readFileSync(
    path.join(repoRoot, '.github/workflows/farmslot-quality.yml'),
    'utf8',
  );
  const jobIds = new Set(
    [...workflow.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map((match) => match[1]),
  );
  const result = selectWorkspaceTests(
    workspaceTestCatalog(repoRoot),
    changedFiles(repoRoot),
    filters,
    jobIds,
  );
  const output = [
    ...Object.keys(filters)
      .filter((key) => filters[key] === 'true' || filters[key] === 'false')
      .map((key) => `${key}=${result.targets.includes(key)}`),
    `workspace_tests=${JSON.stringify(result.matrix)}`,
  ].join('\n');
  appendFileSync(process.env.GITHUB_OUTPUT, `${output}\n`);
  console.log(JSON.stringify(result, null, 2));
}
