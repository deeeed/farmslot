import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

// Single source of truth: the gateway's prepare gate and this CI check resolve
// node-support paths through the exact same function, so the check can never
// validate a different support set than prepare materializes on a node.
// Run under tsx (see `yarn check:node-support`) because the resolver is TS.
import { resolveNodeSupportPaths } from '../services/gateway/src/node-support/paths.js';

const root = process.cwd();
const poolsDir = path.join(root, 'pool');
const projectsDir = path.join(root, 'projects');

function readJson(file: string): any {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function exists(rel: string): boolean {
  try {
    statSync(path.join(root, rel));
    return true;
  } catch {
    return false;
  }
}

const poolFiles = readdirSync(poolsDir)
  .filter((name) => name.endsWith('.json') && name !== 'example.json')
  .map((name) => path.join(poolsDir, name));

const projectCache = new Map<string, any>();
const failures: string[] = [];
const warnings: string[] = [];
const checked: Array<{
  machine: string;
  slot: string;
  projectName: string;
  support: ReturnType<typeof resolveNodeSupportPaths>;
}> = [];

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
      } catch (error) {
        const reason =
          (error as NodeJS.ErrnoException)?.code === 'ENOENT'
            ? `missing projects/${projectName}/project.json`
            : `unreadable projects/${projectName}/project.json: ${error instanceof Error ? error.message : String(error)}`;
        failures.push(`${machine}/${slotName}: ${reason}`);
        continue;
      }
    }
    const projectJson = projectCache.get(projectName);
    let support;
    try {
      support = resolveNodeSupportPaths(projectName, projectJson, root);
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
