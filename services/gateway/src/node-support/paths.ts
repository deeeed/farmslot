import path from 'node:path';

// Type-only — this module stays runtime-dependency-free (just node:path) so the
// standalone `scripts/check-node-support-bundles.ts` gate can import it under
// tsx without dragging in the gateway's runtime graph.
import type { RawProjectJson } from '../core/config.js';

export interface NodeSupportPathResolution {
  paths: string[];
  declaredPaths: string[];
  inferredHookPaths: string[];
  undeclaredHookPaths: string[];
}

const FARM_PATH_STOP = /^[^\s'"`;&|()<>{},:]+/;

// Local nested getter so we don't value-import from core (which would pull the
// whole gateway graph into the CLI gate). Equivalent to core's getProjectFieldRaw.
function getProjectFieldRaw(projectJson: RawProjectJson, dotpath: string): unknown {
  let cur: unknown = projectJson;
  for (const key of dotpath.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function normalizeFarmPath(value: string): string {
  const input = value.replaceAll('\\', '/').trim();
  if (!input || input.startsWith('/')) {
    throw new Error(`Invalid node_support path ${JSON.stringify(value)}: path must be relative`);
  }
  const normalized = path.posix.normalize(input).replace(/\/+$/, '');
  if (
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    path.posix.isAbsolute(normalized)
  ) {
    throw new Error(`Invalid node_support path ${JSON.stringify(value)}: path escapes Farmslot`);
  }
  return normalized;
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
  const normalized = normalizeFarmPath(projectRelativePath);
  const [topLevel] = normalized.split('/').filter(Boolean);
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
    throw new Error(
      `Invalid node_support path ${JSON.stringify(farmPath)}: expected scripts or projects/${projectName}/...`,
    );
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
  for (const value of Object.values(projectJson.vars ?? {})) {
    if (typeof value === 'string') commands.push(value);
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
