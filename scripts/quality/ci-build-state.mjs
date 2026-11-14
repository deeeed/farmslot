import { createHash } from 'node:crypto';
import { globSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { loadWorkspacePackages } from '../release/lib/workspace-utils.mjs';

export const BUILD_RECEIPT = '.cache/ci-builds/receipt.json';
export const BUILD_INPUTS = [
  'package.json',
  'yarn.lock',
  '.yarnrc.yml',
  'tsconfig*.json',
  'packages/*/package.json',
  'packages/*/src/**/*',
  'packages/*/tsconfig*.json',
  'apps/command-center/tsconfig*.json',
  'scripts/lib/**/*',
  'scripts/quality/ci-build*.mjs',
];

export function buildProjects(root) {
  const projects = [...loadWorkspacePackages(root)]
    .filter(([dir, pkg]) => dir.startsWith('packages/') && pkg.scripts?.build)
    .map(([dir, pkg]) => {
      const parts = pkg.scripts.build.split('&&').map((part) => part.trim());
      const compilers = parts.filter((part) => /^tsc --project \S+$/.test(part));
      if (
        compilers.length !== 1 ||
        parts.some(
          (part) =>
            !/^tsc --project \S+$/.test(part) &&
            part !== 'rm -rf dist' &&
            !/^yarn workspace \S+ build$/.test(part),
        )
      )
        throw new Error(`CI needs an explicit build owner for ${pkg.name}: ${pkg.scripts.build}`);
      return {
        name: pkg.name,
        dir,
        config: compilers[0].split(' ').at(-1),
        dependencies: parts
          .filter((part) => part.startsWith('yarn workspace '))
          .map((part) => part.split(' ')[2]),
      };
    });
  const ordered = [],
    visiting = new Set(),
    built = new Set();
  function visit(project) {
    if (built.has(project.name)) return;
    if (visiting.has(project.name)) throw new Error(`Cyclic prerequisite build: ${project.name}`);
    visiting.add(project.name);
    for (const name of project.dependencies) {
      const dependency = projects.find((entry) => entry.name === name);
      if (!dependency) throw new Error(`Missing prerequisite build ${name}`);
      visit(dependency);
    }
    visiting.delete(project.name);
    built.add(project.name);
    ordered.push(project);
  }
  for (const project of projects) visit(project);
  return ordered;
}

export function buildInputHash(root) {
  const files = [...new Set(globSync(BUILD_INPUTS, { cwd: root }))]
    .filter(
      (file) => !file.split(path.sep).some((name) => name.startsWith('.env') || name === '.npmrc'),
    )
    .filter((file) => statSync(path.join(root, file)).isFile())
    .sort();
  const hash = createHash('sha256');
  for (const file of files)
    hash
      .update(file)
      .update('\0')
      .update(readFileSync(path.join(root, file)))
      .update('\0');
  return hash.digest('hex');
}

export function writeBuildReceipt(root, projects) {
  const receipt = { version: 1, inputs: buildInputHash(root), projects, node: process.version };
  mkdirSync(path.dirname(path.join(root, BUILD_RECEIPT)), { recursive: true });
  writeFileSync(path.join(root, BUILD_RECEIPT), `${JSON.stringify(receipt, null, 2)}\n`);
}

export function verifyBuildReceipt(root) {
  const receipt = JSON.parse(readFileSync(path.join(root, BUILD_RECEIPT), 'utf8'));
  const projects = buildProjects(root);
  if (
    receipt.version !== 1 ||
    receipt.inputs !== buildInputHash(root) ||
    JSON.stringify(receipt.projects) !== JSON.stringify(projects)
  )
    throw new Error(
      'Prerequisite build receipt does not match the current source/config/lock inputs',
    );
  for (const project of projects)
    if (!statSync(path.join(root, project.dir, 'dist')).isDirectory())
      throw new Error(`Missing built output for ${project.name}`);
  return receipt;
}
