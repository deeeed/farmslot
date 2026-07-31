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
  if (input.split('/').includes('..')) {
    throw new Error(`Invalid node_support path ${JSON.stringify(value)}: path escapes Farmslot`);
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

function addFarmPath(paths: Set<string>, farmPath: string): void {
  const normalized = normalizeFarmPath(farmPath);
  if (!normalized) return;
  if (normalized === 'scripts' || normalized.startsWith('scripts/')) {
    addRootScripts(paths);
  } else if (normalized.startsWith('projects/')) {
    const [, referencedProject, ...projectRelativeParts] = normalized.split('/');
    const projectRelativePath = projectRelativeParts.join('/');
    if (!referencedProject || !projectRelativePath) {
      throw new Error(
        `Invalid node_support path ${JSON.stringify(farmPath)}: expected projects/<project>/...`,
      );
    }
    addProjectTopLevel(paths, referencedProject, projectRelativePath);
  } else {
    throw new Error(
      `Invalid node_support path ${JSON.stringify(farmPath)}: expected scripts or projects/<project>/...`,
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
  for (const profile of Object.values(projectJson.prepare?.profiles ?? {})) {
    for (const command of Object.values(profile.hooks ?? {})) {
      if (typeof command === 'string') commands.push(command);
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

  const recordProjectRef = (projectRef: string): void => {
    try {
      addFarmPath(paths, `projects/${projectRef}`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid hook support reference in ${projectName}: ${reason}`);
    }
  };

  for (const command of hookCommands(projectJson)) {
    for (const supportDirToken of [
      '{{farmslot_dir}}',
      '{{FARMSLOT_DIR}}',
      '{{node_support_dir}}',
      '{{NODE_SUPPORT_DIR}}',
    ]) {
      if (command.includes(`${supportDirToken}/scripts/`)) addRootScripts(paths);
      const token = `${supportDirToken}/projects/`;
      let index = command.indexOf(token);
      while (index !== -1) {
        const match = FARM_PATH_STOP.exec(command.slice(index + token.length));
        if (match) recordProjectRef(match[0]);
        index = command.indexOf(token, index + token.length);
      }
    }

    const literalRootToken = `${farmslotRoot}/projects/`;
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

function declaredNodeSupportPaths(projectJson: RawProjectJson): string[] {
  const rawPaths = getProjectFieldRaw(projectJson, 'node_support.paths');
  if (!Array.isArray(rawPaths)) return [];
  const paths = new Set<string>();
  for (const entry of rawPaths) {
    if (typeof entry !== 'string' || !entry.trim()) continue;
    addFarmPath(paths, entry.trim());
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
  const declaredPaths = declaredNodeSupportPaths(projectJson);
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
