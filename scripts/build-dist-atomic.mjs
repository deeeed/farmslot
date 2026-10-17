#!/usr/bin/env node
// build-dist-atomic: rebuild workspace packages' dist/ in a live checkout without a moment where
// dist/ is missing. A package's own build script removes dist/ before tsc writes it again, so a
// process importing the package mid-build fails with ERR_MODULE_NOT_FOUND. Here each package
// compiles into a fresh sibling `.dist-<stamp>/`, and `dist` is switched to it by renaming a new
// symlink over the old one: rename(2) replaces it in one step. Node resolves a module graph
// through its real path, so an import in flight stays on the build it started with. A package
// whose dist/ is still a real directory has it moved aside once, the only momentary gap.
//
// Usage: node scripts/build-dist-atomic.mjs <repoRoot> <@farmslot/package>...
// Does what `yarn workspace <package> build` does for each named package, atomically: it also
// builds the packages a build script chains (`yarn workspace <dep> build && ...`), each package
// once and after the packages it depends on. A build script that is not only chained builds, an
// optional dist/ removal and a final `tsc --project <file>` falls back to its own (non-atomic) build.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
let builds = 0;

function workspacePackages(repoRoot) {
  const byName = new Map();
  const packagesDir = path.join(repoRoot, 'packages');
  for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(packagesDir, entry.name, 'package.json');
    if (!fs.existsSync(file)) continue;
    const pkg = readJson(file);
    byName.set(pkg.name, { dir: path.join(packagesDir, entry.name), pkg });
  }
  return byName;
}

/**
 * A build script of the form `[yarn workspace <dep> build && ]...[rm -rf dist && ]tsc --project <file>`
 * as { chain: [<dep>...], tsconfig: <file> }, or null for any other script.
 */
export function parseBuild(buildScript) {
  const steps = (buildScript ?? '').split('&&').map((step) => step.trim());
  const tsc = /^tsc --project (\S+)$/.exec(steps.pop());
  if (!tsc) return null;
  const chain = [];
  for (const step of steps) {
    const dep = /^yarn workspace (\S+) build$/.exec(step);
    if (dep) chain.push(dep[1]);
    else if (step !== 'rm -rf dist') return null;
  }
  return { chain, tsconfig: tsc[1] };
}

/** The named packages and the builds they chain, each after the packages it depends on. */
export function buildOrder(names, byName) {
  const wanted = new Set(names);
  const ordered = [];
  const visiting = new Set();
  const visit = (name) => {
    if (ordered.includes(name)) return;
    if (visiting.has(name)) throw new Error(`build-dist-atomic: dependency cycle at ${name}`);
    const entry = byName.get(name);
    if (!entry) throw new Error(`build-dist-atomic: unknown workspace package ${name}`);
    visiting.add(name);
    const chain = parseBuild(entry.pkg.scripts?.build)?.chain ?? [];
    const deps = Object.keys(entry.pkg.dependencies ?? {}).filter((dep) => wanted.has(dep));
    for (const dep of [...chain, ...deps]) visit(dep);
    visiting.delete(name);
    ordered.push(name);
  };
  for (const name of names) visit(name);
  return ordered;
}

function tscBinary(repoRoot) {
  const local = path.join(repoRoot, 'node_modules', '.bin', 'tsc');
  return fs.existsSync(local) ? local : 'tsc';
}

// Another build of the same package may be compiling (`.dist-build-*`) or switching (`.dist-link-*`)
// right now; those are only removed once a crash has clearly left them behind.
const IN_PROGRESS = ['.dist-build-', '.dist-link-'];
const STALE_IN_PROGRESS_MS = 60 * 60 * 1000;

/** Point `dist` at `buildName` in one rename, then drop builds older than the previous one. */
export function switchDist(packageDir, buildName, stamp) {
  const dist = path.join(packageDir, 'dist');
  const current = fs.lstatSync(dist, { throwIfNoEntry: false });
  const keep = new Set([buildName]);
  if (current?.isSymbolicLink()) keep.add(fs.readlinkSync(dist));
  if (current?.isDirectory()) {
    const legacy = `.dist-legacy-${stamp}`;
    fs.renameSync(dist, path.join(packageDir, legacy));
    keep.add(legacy);
  }
  const link = path.join(packageDir, `.dist-link-${stamp}`);
  fs.symlinkSync(buildName, link);
  fs.renameSync(link, dist);
  for (const entry of fs.readdirSync(packageDir)) {
    if (!entry.startsWith('.dist-') || keep.has(entry)) continue;
    const file = path.join(packageDir, entry);
    if (IN_PROGRESS.some((prefix) => entry.startsWith(prefix))) {
      const stat = fs.lstatSync(file, { throwIfNoEntry: false });
      if (!stat || Date.now() - stat.mtimeMs < STALE_IN_PROGRESS_MS) continue;
    }
    fs.rmSync(file, { recursive: true, force: true });
  }
}

export function buildDistAtomic(repoRoot, names, log = console.log) {
  const byName = workspacePackages(repoRoot);
  for (const name of buildOrder(names, byName)) {
    const { dir, pkg } = byName.get(name);
    const plan = parseBuild(pkg.scripts?.build);
    if (!plan) {
      log(`[build-dist-atomic] ${name}: build script is not a plain tsc build, using it as is`);
      const result = spawnSync('yarn', ['workspace', name, 'build'], {
        cwd: repoRoot,
        stdio: 'inherit',
      });
      if (result.status !== 0) throw new Error(`build-dist-atomic: ${name} build failed`);
      continue;
    }
    const stamp = `${Date.now()}-${process.pid}-${builds++}`;
    const building = `.dist-build-${stamp}`;
    const buildName = `.dist-${stamp}`;
    log(`[build-dist-atomic] building ${name} into ${buildName}...`);
    const result = spawnSync(
      tscBinary(repoRoot),
      ['--project', plan.tsconfig, '--outDir', building],
      {
        cwd: dir,
        stdio: 'inherit',
      },
    );
    if (result.status !== 0) {
      fs.rmSync(path.join(dir, building), { recursive: true, force: true });
      throw new Error(`build-dist-atomic: ${name} build failed; its dist/ is unchanged`);
    }
    fs.renameSync(path.join(dir, building), path.join(dir, buildName));
    switchDist(dir, buildName, stamp);
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [repoRoot, ...names] = process.argv.slice(2);
  if (!repoRoot || names.length === 0) {
    console.error('usage: build-dist-atomic.mjs <repoRoot> <@farmslot/package>...');
    process.exit(2);
  }
  try {
    buildDistAtomic(path.resolve(repoRoot), names);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
