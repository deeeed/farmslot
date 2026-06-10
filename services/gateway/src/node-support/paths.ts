import path from 'node:path';

import { getProjectFieldRaw, type RawProjectJson } from '../core/index.js';

export interface NodeSupportPathResolution {
  paths: string[];
  declaredPaths: string[];
  inferredHookPaths: string[];
  undeclaredHookPaths: string[];
}

const FARM_PATH_STOP = /^[^\s'"`;&|)]+/;

function normalizeFarmPath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

function addRootScripts(paths: Set<string>): void {
  paths.add('scripts');
}

function addProjectJson(paths: Set<string>, projectName: string): void {
  paths.add(path.posix.join('projects', projectName, 'project.json'));
}

function addProjectTopLevel(
  paths: Set<string>,
  projectName: string,
  projectRelativePath: string,
): void {
  const [topLevel] = projectRelativePath.split('/').filter(Boolean);
  if (!topLevel) return;
  addProjectJson(paths, projectName);
  paths.add(path.posix.join('projects', projectName, topLevel));
}

function addFarmPath(paths: Set<string>, projectName: string, farmPath: string): void {
  const normalized = normalizeFarmPath(farmPath);
  if (!normalized) return;
  const projectPrefix = `projects/${projectName}/`;
  if (normalized === 'scripts' || normalized.startsWith('scripts/')) {
    addRootScripts(paths);
  } else if (normalized === `projects/${projectName}/project.json`) {
    addProjectJson(paths, projectName);
  } else if (normalized.startsWith(projectPrefix)) {
    addProjectTopLevel(paths, projectName, normalized.slice(projectPrefix.length));
  } else {
    paths.add(normalized);
  }
}

function hookCommands(projectJson: RawProjectJson): string[] {
  const hooks = projectJson.hooks ?? {};
  const commands: string[] = [];
  for (const hook of Object.values(hooks)) {
    if (typeof hook === 'string') {
      commands.push(hook);
    } else if (hook && typeof hook === 'object') {
      for (const command of Object.values(hook)) {
        if (typeof command === 'string') commands.push(command);
      }
    }
  }
  return commands;
}

function inferHookPaths(
  projectName: string,
  projectJson: RawProjectJson,
  farmslotRoot: string,
): string[] {
  const paths = new Set<string>();
  const projectPrefix = `projects/${projectName}/`;

  const recordProjectRef = (projectRelativeRef: string): void => {
    addProjectTopLevel(paths, projectName, projectRelativeRef);
  };

  for (const command of hookCommands(projectJson)) {
    for (const supportDirToken of [
      '{{farmslot_dir}}',
      '{{FARMSLOT_DIR}}',
      '{{node_support_dir}}',
      '{{NODE_SUPPORT_DIR}}',
    ]) {
      if (command.includes(`${supportDirToken}/scripts/`)) addRootScripts(paths);
      const token = `${supportDirToken}/${projectPrefix}`;
      let index = command.indexOf(token);
      while (index !== -1) {
        const match = FARM_PATH_STOP.exec(command.slice(index + token.length));
        if (match) recordProjectRef(match[0]);
        index = command.indexOf(token, index + token.length);
      }
    }

    const literalRootToken = `${farmslotRoot}/${projectPrefix}`;
    if (command.includes(`${farmslotRoot}/scripts/`)) addRootScripts(paths);
    let index = command.indexOf(literalRootToken);
    while (index !== -1) {
      const match = FARM_PATH_STOP.exec(command.slice(index + literalRootToken.length));
      if (match) recordProjectRef(match[0]);
      index = command.indexOf(literalRootToken, index + literalRootToken.length);
    }
  }

  if ([...paths].some((supportPath) => supportPath.startsWith('projects/'))) addRootScripts(paths);
  return [...paths].sort();
}

function declaredNodeSupportPaths(projectName: string, projectJson: RawProjectJson): string[] {
  const rawPaths = getProjectFieldRaw(projectJson, 'node_support.paths');
  if (!Array.isArray(rawPaths)) return [];
  const paths = new Set<string>();
  for (const entry of rawPaths) {
    if (typeof entry !== 'string' || !entry.trim()) continue;
    addFarmPath(paths, projectName, entry.trim());
  }
  if ([...paths].some((supportPath) => supportPath.startsWith('projects/'))) addRootScripts(paths);
  return [...paths].sort();
}

function pathCoveredBy(candidate: string, declared: string): boolean {
  return candidate === declared || candidate.startsWith(`${declared}/`);
}

export function resolveNodeSupportPaths(
  projectName: string,
  projectJson: RawProjectJson,
  farmslotRoot: string,
): NodeSupportPathResolution {
  const declaredPaths = declaredNodeSupportPaths(projectName, projectJson);
  const inferredHookPaths = inferHookPaths(projectName, projectJson, farmslotRoot);
  const undeclaredHookPaths = inferredHookPaths.filter(
    (inferredPath) =>
      !declaredPaths.some((declaredPath) => pathCoveredBy(inferredPath, declaredPath)),
  );

  // Backward compatibility: existing projects may not declare node_support yet.
  // Prepare materializes the union so hooks keep working, while validation can
  // flag undeclared refs once a project opts into explicit paths.
  return {
    paths: [...new Set([...declaredPaths, ...inferredHookPaths])].sort(),
    declaredPaths,
    inferredHookPaths,
    undeclaredHookPaths,
  };
}
