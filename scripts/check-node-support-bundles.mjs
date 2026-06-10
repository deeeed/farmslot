#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const poolsDir = path.join(root, 'pool');
const projectsDir = path.join(root, 'projects');
const FARM_PATH_STOP = /^[^\s'"`;&|)]+/;

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function exists(rel) {
  try {
    statSync(path.join(root, rel));
    return true;
  } catch {
    return false;
  }
}

function getRaw(obj, dotpath) {
  let cur = obj;
  for (const key of dotpath.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[key];
  }
  return cur;
}

function addRootScripts(paths) {
  paths.add('scripts');
}

function addProjectJson(paths, projectName) {
  paths.add(path.posix.join('projects', projectName, 'project.json'));
}

function addProjectTopLevel(paths, projectName, projectRelativePath) {
  const normalized = normalizeFarmPath(projectRelativePath);
  const [topLevel] = normalized.split('/').filter(Boolean);
  if (!topLevel) return;
  addProjectJson(paths, projectName);
  paths.add(path.posix.join('projects', projectName, topLevel));
}

function normalizeFarmPath(value) {
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

function addFarmPath(paths, projectName, farmPath) {
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

function hookCommands(projectJson) {
  const hooks = projectJson.hooks ?? {};
  const commands = [];
  for (const hook of Object.values(hooks)) {
    if (typeof hook === 'string') commands.push(hook);
    else if (hook && typeof hook === 'object') {
      for (const command of Object.values(hook)) {
        if (typeof command === 'string') commands.push(command);
      }
    }
  }
  return commands;
}

function inferHookPaths(projectName, projectJson) {
  const paths = new Set();
  const projectPrefix = `projects/${projectName}/`;
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
        if (match) addProjectTopLevel(paths, projectName, match[0]);
        index = command.indexOf(token, index + token.length);
      }
    }
  }
  if ([...paths].some((supportPath) => supportPath.startsWith('projects/'))) addRootScripts(paths);
  return [...paths].sort();
}

function declaredNodeSupportPaths(projectName, projectJson) {
  const explicit = getRaw(projectJson, 'node_support.paths');
  if (!Array.isArray(explicit)) return [];
  const paths = new Set();
  for (const entry of explicit) {
    if (typeof entry === 'string' && entry.trim()) addFarmPath(paths, projectName, entry.trim());
  }
  if ([...paths].some((supportPath) => supportPath.startsWith('projects/'))) addRootScripts(paths);
  return [...paths].sort();
}

function coveredBy(candidate, declared) {
  return candidate === declared || candidate.startsWith(`${declared}/`);
}

function resolveSupport(projectName, projectJson) {
  const declaredPaths = declaredNodeSupportPaths(projectName, projectJson);
  const inferredHookPaths = inferHookPaths(projectName, projectJson);
  const undeclaredHookPaths = inferredHookPaths.filter(
    (inferredPath) => !declaredPaths.some((declaredPath) => coveredBy(inferredPath, declaredPath)),
  );
  return {
    declaredPaths,
    inferredHookPaths,
    undeclaredHookPaths,
    paths: [...new Set([...declaredPaths, ...inferredHookPaths])].sort(),
  };
}

const poolFiles = readdirSync(poolsDir)
  .filter((name) => name.endsWith('.json') && name !== 'example.json')
  .map((name) => path.join(poolsDir, name));

const projectCache = new Map();
const failures = [];
const warnings = [];
const checked = [];

for (const poolFile of poolFiles) {
  const pool = readJson(poolFile);
  const machine = pool.machine ?? path.basename(poolFile, '.json');
  for (const slot of pool.slots ?? []) {
    if (slot.enabled === false) continue;
    const slotName = slot.id ?? '<slot>';
    const projectName = slot.project ?? pool.project;
    if (!projectName) {
      failures.push(`${machine}/${slotName}: missing project`);
      continue;
    }
    const projectFile = path.join(projectsDir, projectName, 'project.json');
    if (!projectCache.has(projectName)) {
      try {
        projectCache.set(projectName, readJson(projectFile));
      } catch {
        failures.push(`${machine}/${slotName}: missing projects/${projectName}/project.json`);
        continue;
      }
    }
    const projectJson = projectCache.get(projectName);
    let support;
    try {
      support = resolveSupport(projectName, projectJson);
    } catch (error) {
      failures.push(`${machine}/${slotName}: ${error instanceof Error ? error.message : error}`);
      continue;
    }
    for (const supportPath of support.paths) {
      if (!exists(supportPath)) {
        failures.push(`${machine}/${slotName}: missing node support path ${supportPath}`);
      }
    }
    if (support.declaredPaths.length > 0 && support.undeclaredHookPaths.length > 0) {
      failures.push(
        `${machine}/${slotName}: hooks reference undeclared node support paths: ${support.undeclaredHookPaths.join(', ')}`,
      );
    } else if (support.declaredPaths.length === 0 && support.undeclaredHookPaths.length > 0) {
      warnings.push(
        `${machine}/${slotName}: legacy farm-side hook refs inferred during migration: ${support.undeclaredHookPaths.join(', ')}`,
      );
    }
    checked.push({ machine, slot: slotName, projectName, support });
  }
}

for (const item of checked) {
  const paths = item.support.paths.length ? item.support.paths.join(', ') : '(no node support)';
  console.log(`${item.machine}/${item.slot} ${item.projectName}: ${paths}`);
}

if (warnings.length) {
  console.error('\nWARN node support migration:');
  for (const warning of warnings) console.error(`- ${warning}`);
}

if (failures.length) {
  console.error('\nFAIL node support validation:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `\nOK: validated node support for ${checked.length} enabled slot(s) across ${new Set(checked.map((i) => i.machine)).size} supported node(s).`,
);
