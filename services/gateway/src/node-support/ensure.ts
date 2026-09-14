// node-support/ensure.ts — keep a slot's node support bundle current with the
// gateway's own tree.
//
// Remote slots run project hooks and the runner installer from a content-hashed
// bundle under ~/farmslot-node/support/<hash>; the slot's
// <runtimeDir>/.observability/node-support-hash names the bundle its launch
// commands use. Prepare used to be the only writer, so a gateway-side change to
// scripts/ (2026-09-14: the Grok trust seeding in the runner installer) left every
// slot prepared earlier on a bundle that could not launch the runner. Every
// launch path now calls ensureNodeSupportBundle first, which is a no-op when the
// slot already points at the current bundle.

import { realpath } from 'node:fs/promises';
import path from 'node:path';

import { execOnSlot } from '../core/exec.js';
import {
  farmslotRoot,
  isLocal,
  loadProjectVars,
  type ProjectVars,
  slotFileExists,
  slotReadFile,
  type SlotVars,
  slotWriteFile,
  slotWriteFiles,
} from '../core/index.js';
import { shellExpressionForRemotePath } from '../core/remote-paths.js';
import {
  NODE_SUPPORT_HASH_FILENAME,
  RUNNER_OBSERVABILITY_SUPPORT_PATHS,
} from '../runners/runner-observability.js';

import { collectSupportFiles, type NodeSupportFile, supportHash } from './files.js';
import { resolveNodeSupportPaths } from './paths.js';
import {
  buildNodeSupportPublishCommand,
  buildNodeSupportVerifyCommand,
} from './publish-command.js';

const REMOTE_SUPPORT_ROOT = '~/farmslot-node/support';

export interface NodeSupportBundleState {
  /** Directory the slot's hook and installer commands resolve against. */
  supportDir: string;
  /** Content hash of the bundle; equals farmslotRoot's for local slots (no bundle). */
  hash: string | null;
  /** True when this call published the bundle to the node. */
  published: boolean;
}

export type NodeSupportStep = (name: string, detail: string) => void;

/** Slot I/O the sync runs through; injectable so tests can pin the protocol. */
export interface NodeSupportIo {
  exec: typeof execOnSlot;
  fileExists: typeof slotFileExists;
  readFile: typeof slotReadFile;
  writeFile: typeof slotWriteFile;
  writeFiles: typeof slotWriteFiles;
}

const defaultIo: NodeSupportIo = {
  exec: execOnSlot,
  fileExists: slotFileExists,
  readFile: slotReadFile,
  writeFile: slotWriteFile,
  writeFiles: slotWriteFiles,
};

/** Bundles this process has already verified on a machine (machine|hash). */
const verifiedBundles = new Set<string>();
/** Slots this process has already pointed at a bundle (slot|hash). */
const selectedBundles = new Set<string>();

/** Test seam: forget what this process has verified and selected. */
export function resetNodeSupportBundleCache(): void {
  verifiedBundles.clear();
  selectedBundles.clear();
}

function pathWithin(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function loadProjectVarsIfAny(projectName: string): Promise<ProjectVars | undefined> {
  try {
    return await loadProjectVars(projectName);
  } catch {
    // A slot without project config has no hooks or installer to bundle; the
    // caller's launch falls back to the node install as before.
    return undefined;
  }
}

/**
 * Make sure `vars`' slot runs its hooks and runner installer from the bundle
 * that matches this gateway's tree. Local slots use the checkout directly.
 * Returns null when the slot has no project config.
 */
export async function ensureNodeSupportBundle(
  vars: SlotVars,
  runtimeDir: string,
  options: { step?: NodeSupportStep; projectVars?: ProjectVars; io?: NodeSupportIo } = {},
): Promise<NodeSupportBundleState | null> {
  const step = options.step ?? (() => {});
  const io = options.io ?? defaultIo;
  const projectVars = options.projectVars ?? (await loadProjectVarsIfAny(vars.projectName));
  if (!projectVars) return null;
  const { paths: hookSupportPaths } = resolveNodeSupportPaths(
    vars.projectName,
    projectVars.projectJson,
    farmslotRoot,
  );
  const supportPaths = [...hookSupportPaths];
  for (const requiredPath of RUNNER_OBSERVABILITY_SUPPORT_PATHS) {
    if (
      !supportPaths.some(
        (supportPath) => supportPath === requiredPath || requiredPath.startsWith(`${supportPath}/`),
      )
    ) {
      supportPaths.push(requiredPath);
    }
  }
  supportPaths.sort();
  if (isLocal(vars.host, vars.machine)) {
    step('support', 'Using local node support source');
    return { supportDir: farmslotRoot, hash: null, published: false };
  }

  const farmslotRootRealPath = await realpath(farmslotRoot);
  const files: NodeSupportFile[] = (
    await Promise.all(
      supportPaths.map(async (supportPath) => {
        const sourcePath = path.join(farmslotRoot, supportPath);
        const sourceRealPath = await realpath(sourcePath);
        if (!pathWithin(farmslotRootRealPath, sourceRealPath)) {
          throw new Error(`Node support path escapes Farmslot root: ${supportPath}`);
        }
        return collectSupportFiles(sourcePath, supportPath);
      }),
    )
  ).flat();
  const manifest = {
    version: 1,
    project: vars.projectName,
    hash: supportHash(files),
    paths: supportPaths,
    fileCount: files.length,
    files: files.map((file) => ({
      path: file.relativePath,
      sha256: file.sha256,
      mode: file.mode.toString(8).padStart(3, '0'),
      size: file.size,
    })),
  };
  const supportDir = path.posix.join(REMOTE_SUPPORT_ROOT, manifest.hash);
  const manifestPath = path.posix.join(supportDir, 'manifest.json');
  const machineKey = `${vars.machine}|${manifest.hash}`;
  const slotKey = `${vars.slotId}|${manifest.hash}`;

  const persistSelection = async (how: 'published' | 'current') => {
    if (selectedBundles.has(slotKey)) return;
    await io.writeFiles(vars, path.posix.join(vars.remoteRepo, runtimeDir, '.observability'), [
      {
        path: NODE_SUPPORT_HASH_FILENAME,
        content: Buffer.from(`${manifest.hash}\n`).toString('base64'),
        mode: 0o644,
      },
    ]);
    selectedBundles.add(slotKey);
    console.log(
      `[node-support] ${vars.slotId} now on bundle ${manifest.hash.slice(0, 8)} (${how}, ${files.length} files)`,
    );
  };
  const verify = async (dir: string, manifestFile: string): Promise<boolean> => {
    const result = await io.exec(
      vars,
      buildNodeSupportVerifyCommand({ manifestPath: manifestFile, supportDir: dir, files }),
    );
    return result.exitCode === 0;
  };

  if (verifiedBundles.has(machineKey)) {
    await persistSelection('current');
    return { supportDir, hash: manifest.hash, published: false };
  }
  if (await io.fileExists(vars, manifestPath)) {
    const current = JSON.parse(await io.readFile(vars, manifestPath)) as { hash?: string };
    if (current.hash === manifest.hash) {
      if (!(await verify(supportDir, manifestPath))) {
        throw new Error(`Node support bundle corrupt for ${manifest.hash}`);
      }
      verifiedBundles.add(machineKey);
      await persistSelection('current');
      step('support', `Node support bundle current (${files.length} files)`);
      return { supportDir, hash: manifest.hash, published: false };
    }
  }

  const incomingResult = await io.exec(
    vars,
    [
      `mkdir -p ${shellExpressionForRemotePath(`${REMOTE_SUPPORT_ROOT}/.incoming`)}`,
      `mktemp -d ${shellExpressionForRemotePath(
        path.posix.join(REMOTE_SUPPORT_ROOT, '.incoming', `${manifest.hash}.XXXXXX`),
      )}`,
    ].join(' && '),
  );
  if (incomingResult.exitCode !== 0) {
    throw new Error(`Node support temp dir creation failed: ${incomingResult.stderr}`);
  }
  const incomingDir = incomingResult.stdout.trim().split(/\r?\n/).at(-1);
  if (!incomingDir) throw new Error('Node support temp dir creation produced no path');
  const discardIncoming = () =>
    io.exec(vars, `rm -rf ${shellExpressionForRemotePath(incomingDir)}`);

  try {
    await io.writeFiles(
      vars,
      incomingDir,
      files.map((file) => ({
        path: file.relativePath,
        content: file.contentBase64,
        mode: file.mode,
      })),
    );
    await io.writeFile(
      vars,
      path.posix.join(incomingDir, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
  } catch (error) {
    await discardIncoming();
    throw error;
  }
  if (!(await verify(incomingDir, path.posix.join(incomingDir, 'manifest.json')))) {
    await discardIncoming();
    throw new Error(`Node support incoming verification failed for ${manifest.hash}`);
  }
  const publishResult = await io.exec(
    vars,
    buildNodeSupportPublishCommand({
      incomingDir,
      manifestPath,
      supportDir,
      supportHash: manifest.hash,
    }),
  );
  if (publishResult.exitCode !== 0) {
    const cleanupResult = await discardIncoming();
    const cleanupDetail =
      cleanupResult.exitCode === 0 ? '' : `; cleanup failed: ${cleanupResult.stderr}`;
    throw new Error(`Node support publish failed: ${publishResult.stderr}${cleanupDetail}`);
  }
  const published = JSON.parse(await io.readFile(vars, manifestPath)) as { hash?: string };
  if (published.hash !== manifest.hash) {
    throw new Error(`Node support publish hash mismatch for ${manifest.hash}`);
  }
  if (!(await verify(supportDir, manifestPath))) {
    throw new Error(`Node support publish verification failed for ${manifest.hash}`);
  }
  verifiedBundles.add(machineKey);
  await persistSelection('published');
  step('support', `Synced node support bundle (${files.length} files: ${supportPaths.join(', ')})`);
  return { supportDir, hash: manifest.hash, published: true };
}
