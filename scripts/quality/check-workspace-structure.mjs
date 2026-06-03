#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const failures = [];

function fail(message) {
  failures.push(message);
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(repoRoot, relativePath), 'utf8'));
}

function workspaceDirs(rootName) {
  const root = path.join(repoRoot, rootName);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${rootName}/${entry.name}`)
    .filter((dir) => existsSync(path.join(repoRoot, dir, 'package.json')))
    .sort();
}

function checkScripts(pkg, relativeDir, requiredScripts) {
  for (const script of requiredScripts) {
    if (typeof pkg.scripts?.[script] !== 'string' || pkg.scripts[script].trim() === '') {
      fail(`${relativeDir}/package.json must define a non-empty ${script} script.`);
    }
  }
}

function checkWorkspaceReadme(relativeDir, requiredSections) {
  const readmePath = `${relativeDir}/README.md`;
  const absoluteReadmePath = path.join(repoRoot, readmePath);
  if (!existsSync(absoluteReadmePath)) {
    fail(`${readmePath} is required for workspace ownership and maintenance guidance.`);
    return;
  }

  const content = readFileSync(absoluteReadmePath, 'utf8');
  for (const section of requiredSections) {
    if (!content.includes(section)) {
      fail(`${readmePath} must include a ${section} section.`);
    }
  }
}

function checkWorkspaceRoot(rootName, requiredScripts, requiredReadmeSections) {
  const dirs = workspaceDirs(rootName);
  if (dirs.length === 0) fail(`${rootName}/* must contain at least one workspace.`);

  for (const relativeDir of dirs) {
    const packageJsonPath = `${relativeDir}/package.json`;
    const pkg = readJson(packageJsonPath);
    if (typeof pkg.name !== 'string' || !pkg.name.startsWith('@farmslot/')) {
      fail(`${packageJsonPath} must declare an @farmslot/* package name.`);
    }
    checkWorkspaceReadme(relativeDir, requiredReadmeSections);
    checkScripts(pkg, relativeDir, requiredScripts);
  }
}

function checkRootWorkspaceGlobs() {
  const rootPackage = readJson('package.json');
  const workspaces = new Set(rootPackage.workspaces ?? []);
  for (const glob of ['packages/*', 'services/*']) {
    if (!workspaces.has(glob)) fail(`root package.json workspaces must include ${glob}.`);
  }
}

function checkReadmeDocumentsExpectations() {
  const packageReadme = readFileSync(path.join(repoRoot, 'packages/README.md'), 'utf8');
  const serviceReadme = readFileSync(path.join(repoRoot, 'services/README.md'), 'utf8');
  for (const [label, content, required] of [
    ['packages/README.md', packageReadme, ['Every package has a README', 'typecheck', 'quality']],
    [
      'services/README.md',
      serviceReadme,
      ['Every service has a README', 'typecheck', 'test', 'quality'],
    ],
  ]) {
    for (const snippet of required) {
      if (!content.includes(snippet)) fail(`${label} must document ${snippet}.`);
    }
  }
}

function trackedFiles() {
  const output = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot });
  return output.toString('utf8').split('\0').filter(Boolean);
}

function isTextLike(relativePath) {
  return /\.(?:cjs|css|html|js|json|jsx|md|mjs|sh|ts|tsx|txt|yml|yaml)$/i.test(relativePath);
}

function checkMovedServiceReferences() {
  const stalePaths = ['packages/' + 'gateway', 'packages/' + 'node'];
  for (const relativePath of trackedFiles()) {
    if (!isTextLike(relativePath)) continue;
    const content = readFileSync(path.join(repoRoot, relativePath), 'utf8');
    for (const stalePath of stalePaths) {
      if (content.includes(stalePath)) {
        fail(`${relativePath} contains stale moved service path ${stalePath}.`);
      }
    }
  }
}

checkRootWorkspaceGlobs();
checkWorkspaceRoot(
  'packages',
  ['typecheck', 'quality'],
  ['## Source layout', '## Maintenance rules', '## Local quality'],
);
checkWorkspaceRoot(
  'services',
  ['typecheck', 'test', 'quality'],
  ['## Source layout', '## Maintenance rules', '## Local quality'],
);
checkReadmeDocumentsExpectations();
checkMovedServiceReferences();

if (failures.length > 0) {
  console.error('Workspace structure guard failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Workspace structure guard passed.');
