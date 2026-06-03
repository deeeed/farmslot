#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, mkdir, readlink, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const siteDir = resolve(scriptDir, '..');
const generatedLink = join(siteDir, '.docusaurus');
const siteHash = createHash('sha256').update(siteDir).digest('hex').slice(0, 12);
const generatedTarget = join(tmpdir(), `farmslot-docs-docusaurus-${siteHash}`);
let child;
let stopping = false;

async function pathExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function ensureGeneratedDir() {
  await mkdir(generatedTarget, { recursive: true });

  let stat;
  try {
    stat = await lstat(generatedLink);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await symlink(generatedTarget, generatedLink, 'dir');
    return;
  }

  if (stat.isSymbolicLink()) {
    const target = await readlink(generatedLink);
    if (target === generatedTarget && (await pathExists(generatedTarget))) return;
  }

  // `.docusaurus` only contains Docusaurus-generated modules. Keeping it as a
  // symlink outside the repo prevents repo cleanup/lint scans from removing or
  // traversing generated code while the dev server is running.
  await rm(generatedLink, { recursive: true, force: true });
  await symlink(generatedTarget, generatedLink, 'dir');
}

function stop(signal = 'SIGTERM') {
  if (stopping) return;
  stopping = true;
  if (child && !child.killed) child.kill(signal);
}

await ensureGeneratedDir();

const guard = setInterval(async () => {
  try {
    await ensureGeneratedDir();
  } catch (error) {
    console.error(
      `[docs] generated directory guard failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    stop('SIGTERM');
    process.exitCode = 1;
  }
}, 250);

guard.unref();

child = spawn('docusaurus', ['start', '--host', '0.0.0.0', ...process.argv.slice(2)], {
  cwd: siteDir,
  env: process.env,
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  clearInterval(guard);
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

child.on('error', (error) => {
  clearInterval(guard);
  console.error(`[docs] failed to start docusaurus: ${error.message}`);
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => stop(signal));
}
