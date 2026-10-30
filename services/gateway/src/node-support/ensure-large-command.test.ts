import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { makeVars } from '../runners/test-fixtures.js';

import type { NodeSupportIo } from './ensure.js';
import { type NodeSupportFile, supportHash } from './files.js';
import { isSupportHomeCommand } from './support-test-fixtures.js';

test('full support verification and activation handle an inventory larger than ARG_MAX', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'support-large-command-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const projects = path.join(home, 'projects');
  process.env.FARMSLOT_PROJECTS_DIR = projects;
  await mkdir(path.join(projects, 'large'), { recursive: true });
  await writeFile(path.join(projects, 'large', 'project.json'), JSON.stringify({ name: 'large' }));
  const { loadProjectVars } = await import('../core/config.js');
  const { ensureNodeSupportBundle, nodeSupportBundlePaths } = await import('./ensure.js');
  const projectVars = await loadProjectVars('large');
  const files: NodeSupportFile[] = Array.from({ length: 250 }, (_, index) => {
    const content = `printf '%s\\n' ${index}\n`;
    return {
      relativePath: `scripts/${index}-${'x'.repeat(120)}.sh`,
      contentBase64: Buffer.from(content).toString('base64'),
      sha256: createHash('sha256').update(content).digest('hex'),
      size: Buffer.byteLength(content),
      mode: 0o644,
    };
  });
  const manifest = {
    version: 1,
    project: 'large',
    hash: supportHash(files),
    paths: nodeSupportBundlePaths('large', projectVars.projectJson),
    fileCount: files.length,
    files: files.map((file) => ({
      path: file.relativePath,
      sha256: file.sha256,
      mode: file.mode.toString(8),
      size: file.size,
    })),
  };
  const supportRoot = path.join(home, 'support');
  const supportDir = path.join(supportRoot, manifest.hash);
  await mkdir(path.join(supportDir, 'scripts'), { recursive: true });
  for (const file of files)
    await writeFile(
      path.join(supportDir, file.relativePath),
      Buffer.from(file.contentBase64, 'base64'),
    );
  await writeFile(path.join(supportDir, 'manifest.json'), JSON.stringify(manifest));
  const vars = makeVars({
    machine: 'remote',
    host: 'remote.invalid',
    projectName: 'large',
    remoteRepo: path.join(home, 'slot'),
  });
  const exec = promisify(execFile);
  let maxCommandBytes = 0;
  const io: NodeSupportIo = {
    exec: async (_vars, command) => {
      if (isSupportHomeCommand(command))
        return { exitCode: 0, stdout: `${supportDir}\n`, stderr: '' };
      maxCommandBytes = Math.max(maxCommandBytes, Buffer.byteLength(command));
      const result = await exec('/bin/sh', ['-c', command]);
      return { exitCode: 0, ...result };
    },
    fileExists: async (_vars, file) => (await readFile(file)).length > 0,
    readFile: async (_vars, file) => readFile(file, 'utf8'),
    writeFile: async (_vars, file, data) => writeFile(file, data),
    writeFiles: async (_vars, root, entries) => {
      for (const entry of entries) {
        const file = path.join(root, entry.path);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, Buffer.from(entry.content, 'base64'), { mode: entry.mode });
      }
    },
    retentionReferences: async () => ({
      selectionPaths: [],
      runHashes: Array.from({ length: 20_000 }, (_, i) => i.toString(16).padStart(64, '0')),
    }),
  };
  const options = { projectVars, io, verify: 'full' as const, collected: { files, manifest } };
  const result = await ensureNodeSupportBundle(vars, '.agent', options);
  assert.equal(result?.hash, manifest.hash);
  const { nodeSupportHashPath } = await import('../runners/runner-observability.js');
  assert.equal(
    await readFile(nodeSupportHashPath(vars.remoteRepo, '.agent'), 'utf8'),
    `${manifest.hash}\n`,
  );
  assert.ok(maxCommandBytes < 32_768, `shell argv remained bounded: ${maxCommandBytes}`);
  assert.deepEqual(
    (await readdir(supportRoot)).filter((name) => name.startsWith('.command.')),
    [],
  );

  await chmod(path.join(supportDir, files[0].relativePath), 0o755);
  await assert.rejects(ensureNodeSupportBundle(vars, '.agent', options));
  assert.deepEqual(
    (await readdir(supportRoot)).filter((name) => name.startsWith('.command.')),
    [],
  );
});
