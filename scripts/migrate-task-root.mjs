#!/usr/bin/env node
/**
 * migrate-task-root.mjs — Move in-flight run task data from a legacy worker root
 * (e.g. .task) into the project-configured task dir (e.g. temp/tasks), patch the
 * run record, and mirror slot artifacts to the orchestrator task tree.
 *
 * Usage:
 *   node scripts/migrate-task-root.mjs --run <run-id-prefix>
 *   node scripts/migrate-task-root.mjs --all-blocked [--project metamask-mobile-farm]
 *   node scripts/migrate-task-root.mjs --run 199ace83 --dry-run
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FARMSLOT_ROOT = path.resolve(__dirname, '..');
const RUNS_DIR = path.join(FARMSLOT_ROOT, '.runs');
const POOL_DIR = path.join(FARMSLOT_ROOT, 'pool');
const PROJECTS_DIR = path.join(FARMSLOT_ROOT, 'projects');

const LEGACY_ROOT_DEFAULT = '.task';
const PATH_FIELD_KEYS = new Set([
  'taskFile',
  'signalFile',
  'taskProgressArtifactPath',
  'artifactRoot',
  'activeTaskFile',
]);

function usage() {
  console.error(`Usage:
  node scripts/migrate-task-root.mjs --run <id-prefix> [--legacy-root .task] [--dry-run]
  node scripts/migrate-task-root.mjs --all-blocked [--project <name>] [--dry-run]`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = {
    run: null,
    allBlocked: false,
    project: null,
    legacyRoot: LEGACY_ROOT_DEFAULT,
    dryRun: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--run') opts.run = argv[++i];
    else if (arg === '--all-blocked') opts.allBlocked = true;
    else if (arg === '--project') opts.project = argv[++i];
    else if (arg === '--legacy-root') opts.legacyRoot = argv[++i];
    else if (arg === '--dry-run') opts.dryRun = true;
    else usage();
  }
  if (!opts.run && !opts.allBlocked) usage();
  return opts;
}

async function listRunFiles() {
  const names = await readdir(RUNS_DIR);
  return names.filter((n) => n.endsWith('.json') && !n.startsWith('.'));
}

function resolveRunFile(prefix) {
  const matches = [];
  for (const name of existsSync(RUNS_DIR) ? readdirSync(RUNS_DIR) : []) {
    if (!name.endsWith('.json')) continue;
    if (name.startsWith(prefix) || name.replace(/\.json$/, '').startsWith(prefix)) {
      matches.push(path.join(RUNS_DIR, name));
    }
  }
  if (matches.length === 0) throw new Error(`No run file matching prefix: ${prefix}`);
  if (matches.length > 1) {
    throw new Error(`Ambiguous run prefix ${prefix}: ${matches.map((m) => path.basename(m)).join(', ')}`);
  }
  return matches[0];
}

function resolveProjectTaskDirName(projectJson) {
  const explicit = projectJson.task_dir;
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  const artifactDir = projectJson.paths?.artifact_dir;
  if (typeof artifactDir === 'string' && artifactDir.trim()) return artifactDir.trim();
  return LEGACY_ROOT_DEFAULT;
}

async function loadProjectJson(projectName) {
  const configPath = path.join(PROJECTS_DIR, projectName, 'project.json');
  if (!existsSync(configPath)) throw new Error(`project.json not found: ${configPath}`);
  return JSON.parse(await readFile(configPath, 'utf8'));
}

async function resolveSlotRepo(slotId) {
  if (!existsSync(POOL_DIR)) return null;
  const poolFiles = (await readdir(POOL_DIR)).filter((f) => f.endsWith('.json'));
  const bareSlotId = slotId.replace(/^macwork-/, '');
  for (const file of poolFiles) {
    const pool = JSON.parse(await readFile(path.join(POOL_DIR, file), 'utf8'));
    for (const slot of pool.slots ?? []) {
      if (slot.id === bareSlotId || slot.id === slotId) {
        return path.resolve(slot.repo);
      }
    }
  }
  return null;
}

function taskRelDirFromRun(run) {
  if (!run.taskFile) return null;
  const normalized = run.taskFile.replace(/\\/g, '/');
  const match = normalized.match(/\/tasks\/((?:feat|fix|review|eval)\/[^/]+)\/TASK\.md$/);
  if (match) return match[1];
  const orchRoot = path.join(PROJECTS_DIR, run.project, 'tasks');
  const rel = path.relative(orchRoot, run.taskFile);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
    return path.dirname(rel).replace(/\\/g, '/');
  }
  return null;
}

function migratePathString(value, legacyRoot, newRoot, repoAbs) {
  if (typeof value !== 'string') return { value, changed: false };
  if (value.startsWith(`${legacyRoot}/`)) {
    return { value: `${newRoot}/${value.slice(legacyRoot.length + 1)}`, changed: true };
  }
  if (repoAbs) {
    const legacyAbs = `${repoAbs}/${legacyRoot}/`;
    const newAbs = `${repoAbs}/${newRoot}/`;
    if (value.includes(legacyAbs)) {
      return { value: value.split(legacyAbs).join(newAbs), changed: true };
    }
  }
  return { value, changed: false };
}

function patchRunTree(node, legacyRoot, newRoot, repoAbs, key = null) {
  if (node === null || node === undefined) return { node, changes: 0 };
  if (typeof node === 'string') {
    if (key && PATH_FIELD_KEYS.has(key)) {
      const { value, changed } = migratePathString(node, legacyRoot, newRoot, repoAbs);
      return { node: value, changes: changed ? 1 : 0 };
    }
    return { node, changes: 0 };
  }
  if (Array.isArray(node)) {
    let changes = 0;
    const out = node.map((item) => {
      const patched = patchRunTree(item, legacyRoot, newRoot, repoAbs);
      changes += patched.changes;
      return patched.node;
    });
    return { node: out, changes };
  }
  if (typeof node === 'object') {
    let changes = 0;
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (PATH_FIELD_KEYS.has(k) && typeof v === 'string') {
        const { value, changed } = migratePathString(v, legacyRoot, newRoot, repoAbs);
        out[k] = value;
        if (changed) changes += 1;
      } else {
        const patched = patchRunTree(v, legacyRoot, newRoot, repoAbs, k);
        out[k] = patched.node;
        changes += patched.changes;
      }
    }
    return { node: out, changes };
  }
  return { node, changes: 0 };
}

function runNeedsMigration(run, legacyRoot) {
  const serialized = JSON.stringify(run);
  return (
    serialized.includes(`"${legacyRoot}/`) ||
    serialized.includes(`/${legacyRoot}/`) ||
    (run.agentContexts ?? []).some((ctx) => ctx.taskFile?.startsWith(`${legacyRoot}/`))
  );
}

function rsyncMerge(src, dest, dryRun, extraArgs = []) {
  const args = ['-a', ...extraArgs, `${src}/`, `${dest}/`];
  if (dryRun) args.unshift('--dry-run');
  const result = spawnSync('rsync', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`rsync failed (${src} -> ${dest}): ${result.stderr || result.stdout}`);
  }
  return (result.stdout || '').trim();
}

async function backupRunFile(runFile) {
  const backupDir = path.join(FARMSLOT_ROOT, '.backups', 'runs');
  await mkdir(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupDir, `${path.basename(runFile, '.json')}.${stamp}.json`);
  await copyFile(runFile, backupPath);
  return backupPath;
}

async function rewriteTaskMarkdownPaths(taskDirAbs, legacyRoot, newRoot, dryRun) {
  const files = ['TASK.md', 'SELF-REVIEW.md', 'SELF-REVIEW-FIX.md', 'CI-FIX.md'];
  let rewritten = 0;
  for (const name of files) {
    const filePath = path.join(taskDirAbs, name);
    if (!existsSync(filePath)) continue;
    const before = await readFile(filePath, 'utf8');
    const legacyPrefix = `${legacyRoot}/`;
    const newPrefix = `${newRoot}/`;
    if (!before.includes(legacyPrefix)) continue;
    const after = before.split(legacyPrefix).join(newPrefix);
    if (after === before) continue;
    rewritten += 1;
    if (!dryRun) await writeFile(filePath, after, 'utf8');
  }
  return rewritten;
}

async function migrateOneRun(runFile, opts) {
  const run = JSON.parse(await readFile(runFile, 'utf8'));
  const label = `${run.id.slice(0, 8)} (${run.ticketOrPr ?? 'no-ticket'})`;

  if (!runNeedsMigration(run, opts.legacyRoot)) {
    console.log(`[skip] ${label} — no ${opts.legacyRoot}/ paths`);
    return { skipped: true };
  }

  const projectJson = await loadProjectJson(run.project);
  const newRoot = resolveProjectTaskDirName(projectJson);
  if (opts.legacyRoot === newRoot) {
    console.log(`[skip] ${label} — legacy root matches configured task dir (${newRoot})`);
    return { skipped: true };
  }

  const taskRel = taskRelDirFromRun(run);
  if (!taskRel) throw new Error(`${label}: could not derive task rel dir from taskFile`);

  const repoAbs = run.slotId ? await resolveSlotRepo(run.slotId) : null;
  const legacyAbs = repoAbs ? path.join(repoAbs, opts.legacyRoot, taskRel) : null;
  const destAbs = repoAbs ? path.join(repoAbs, newRoot, taskRel) : null;
  const orchTaskDir = path.join(PROJECTS_DIR, run.project, 'tasks', taskRel);
  const orchArtifacts = path.join(orchTaskDir, 'artifacts');

  console.log(`\n[migrate] ${label}`);
  console.log(`  project: ${run.project}`);
  console.log(`  taskRel: ${taskRel}`);
  console.log(`  ${opts.legacyRoot} -> ${newRoot}`);

  if (repoAbs) {
    console.log(`  slot repo: ${repoAbs}`);
    if (!existsSync(legacyAbs)) {
      console.warn(`  [warn] legacy dir missing on slot: ${legacyAbs}`);
    } else if (opts.dryRun) {
      console.log(`  [dry-run] rsync ${legacyAbs} -> ${destAbs}`);
      rsyncMerge(legacyAbs, destAbs, true, ['--ignore-existing']);
      if (existsSync(path.join(legacyAbs, 'artifacts'))) {
        rsyncMerge(path.join(legacyAbs, 'artifacts'), path.join(destAbs, 'artifacts'), true, [
          '--ignore-existing',
        ]);
      }
    } else {
      await mkdir(destAbs, { recursive: true });
      const top = rsyncMerge(legacyAbs, destAbs, false, ['--ignore-existing']);
      if (top) console.log(top.split('\n').filter(Boolean).map((l) => `    ${l}`).join('\n'));
      const legacyArtifacts = path.join(legacyAbs, 'artifacts');
      if (existsSync(legacyArtifacts)) {
        await mkdir(path.join(destAbs, 'artifacts'), { recursive: true });
        const art = rsyncMerge(legacyArtifacts, path.join(destAbs, 'artifacts'), false, [
          '--ignore-existing',
        ]);
        if (art) console.log(art.split('\n').filter(Boolean).map((l) => `    ${l}`).join('\n'));
      }
      console.log(`  [ok] slot merge complete`);
      const rewritten = await rewriteTaskMarkdownPaths(
        destAbs,
        opts.legacyRoot,
        newRoot,
        opts.dryRun,
      );
      if (rewritten > 0) {
        console.log(
          `  [ok] rewrote ${rewritten} task markdown file(s) (${opts.legacyRoot}/ -> ${newRoot}/)`,
        );
      }
    }
  } else {
    console.log(`  [warn] no slot repo — run JSON patch only`);
  }

  if (destAbs && existsSync(path.join(destAbs, 'artifacts')) && !opts.dryRun) {
    await mkdir(orchArtifacts, { recursive: true });
    rsyncMerge(path.join(destAbs, 'artifacts'), orchArtifacts, false, ['--ignore-existing']);
    console.log(`  [ok] orchestrator artifacts mirrored -> ${orchArtifacts}`);
  } else if (destAbs && opts.dryRun) {
    console.log(`  [dry-run] mirror ${path.join(destAbs, 'artifacts')} -> ${orchArtifacts}`);
  }

  const { node: patched, changes } = patchRunTree(run, opts.legacyRoot, newRoot, repoAbs);
  patched.updatedAt = new Date().toISOString();
  console.log(`  [ok] run JSON path fields patched (${changes} change(s))`);

  if (opts.dryRun) {
    console.log(`  [dry-run] would write ${runFile}`);
    return { skipped: false, dryRun: true, changes };
  }

  const backupPath = await backupRunFile(runFile);
  console.log(`  [ok] backup -> ${backupPath}`);
  await writeFile(runFile, `${JSON.stringify(patched, null, 2)}\n`, 'utf8');
  console.log(`  [ok] wrote ${runFile}`);
  return { skipped: false, changes };
}

async function collectRuns(opts) {
  if (opts.run) return [await resolveRunFile(opts.run)];
  const files = await listRunFiles();
  const selected = [];
  for (const name of files) {
    const runFile = path.join(RUNS_DIR, name);
    const run = JSON.parse(await readFile(runFile, 'utf8'));
    if (!['running', 'blocked', 'paused'].includes(run.status)) continue;
    if (opts.project && run.project !== opts.project) continue;
    if (!runNeedsMigration(run, opts.legacyRoot)) continue;
    selected.push(runFile);
  }
  return selected;
}

async function main() {
  const opts = parseArgs(process.argv);
  const runFiles = await collectRuns(opts);
  if (runFiles.length === 0) {
    console.log('No runs matched.');
    return;
  }

  let migrated = 0;
  let skipped = 0;
  for (const runFile of runFiles) {
    const result = await migrateOneRun(runFile, opts);
    if (result.skipped) skipped += 1;
    else migrated += 1;
  }

  console.log(`\nDone. migrated=${migrated} skipped=${skipped} dryRun=${opts.dryRun}`);
  if (!opts.dryRun && migrated > 0) {
    console.log('Restart or reload the gateway so task-watchers pick up new paths.');
  }
}

main().catch((err) => {
  console.error(`[migrate-task-root] ${err.message}`);
  process.exit(1);
});