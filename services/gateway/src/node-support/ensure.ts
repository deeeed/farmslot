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
import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import path from 'node:path';

import {
  packMachineNames,
  validatePackBytesPortability,
  validatePackPortability,
} from '@farmslot/protocol/node/pack-portability';
import { currentProjectSources } from '@farmslot/slot-config';

import { execOnSlot } from '../core/exec.js';
import {
  farmslotRoot,
  isLocal,
  loadProjectVars,
  poolDir,
  projectsDir,
  type ProjectVars,
  type RawProjectJson,
  slotFileExists,
  slotReadFile,
  type SlotVars,
  slotWriteFile,
  slotWriteFiles,
} from '../core/index.js';
import { shellExpressionForRemotePath } from '../core/remote-paths.js';
import {
  NODE_SUPPORT_ROOT,
  nodeSupportHashPath,
  nodeSupportSelectionCommand,
  RUNNER_OBSERVABILITY_SUPPORT_PATHS,
} from '../runners/runner-observability.js';

import {
  buildNodeSupportActivationCommand,
  type NodeSupportRetentionReferences,
  nodeSupportRetentionReferences,
} from './activation.js';
import { collectSupportFiles, type NodeSupportFile, supportHash } from './files.js';
import { resolveNodeSupportPaths } from './paths.js';
import {
  buildNodeSupportPublishCommand,
  buildNodeSupportVerifyCommand,
} from './publish-command.js';

export interface NodeSupportBundleState {
  /** Directory the slot's hook and installer commands resolve against. */
  supportDir: string;
  /** Content hash of the bundle; equals farmslotRoot's for local slots (no bundle). */
  hash: string | null;
  /** True when this call published the bundle to the node. */
  published: boolean;
  /** Farm-relative paths the bundle carries (`scripts`, `projects/<name>/...`). */
  paths: string[];
}

export type NodeSupportStep = (name: string, detail: string) => void;

/** Slot I/O the sync runs through; injectable so tests can pin the protocol. */
export interface NodeSupportIo {
  exec: typeof execOnSlot;
  fileExists: typeof slotFileExists;
  readFile: typeof slotReadFile;
  writeFile: typeof slotWriteFile;
  writeFiles: typeof slotWriteFiles;
  /** The same selected-slot and live-run inventory, injectable with the node I/O. */
  retentionReferences?: (vars: SlotVars) => Promise<NodeSupportRetentionReferences>;
}

const defaultIo: NodeSupportIo = {
  exec: execOnSlot,
  fileExists: slotFileExists,
  readFile: slotReadFile,
  writeFile: slotWriteFile,
  writeFiles: slotWriteFiles,
};

function pathWithin(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export async function loadProjectVarsIfAny(projectName: string): Promise<ProjectVars | undefined> {
  try {
    return await loadProjectVars(projectName);
  } catch (error) {
    // A slot without project config has no hooks or installer to bundle; the
    // caller's launch falls back to the node install as before. Anything other
    // than a missing config is a real problem and must not be silent.
    if (!/not found/i.test((error as Error).message)) throw error;
    return undefined;
  }
}

/**
 * A node's hosted task init selects the gateway's template from the bundle's
 * pack, so the bundle carries the pack's templates and every template source
 * rooted inside the pack. A path the pack does not have is left out.
 */
function hostedTaskTemplatePaths(projectName: string, projectJson: RawProjectJson): string[] {
  const roots = ['templates'];
  for (const source of projectJson.execution_templates?.sources ?? [])
    if (typeof source.root.projectPath === 'string') roots.push(source.root.projectPath);
  return roots
    .map((root) => path.posix.join('projects', projectName, root))
    .filter(
      (relative) =>
        relative.startsWith(`projects/${projectName}/`) &&
        existsSync(path.join(farmslotRoot, relative)),
    );
}

/** Farm-relative paths a project's bundle carries: its config refs, its templates and the runner installer. */
export function nodeSupportBundlePaths(projectName: string, projectJson: RawProjectJson): string[] {
  const { paths: hookSupportPaths } = resolveNodeSupportPaths(
    projectName,
    projectJson,
    farmslotRoot,
  );
  const supportPaths = [...hookSupportPaths];
  for (const requiredPath of [
    ...hostedTaskTemplatePaths(projectName, projectJson),
    ...RUNNER_OBSERVABILITY_SUPPORT_PATHS,
  ]) {
    if (
      !supportPaths.some(
        (supportPath) => supportPath === requiredPath || requiredPath.startsWith(`${supportPath}/`),
      )
    ) {
      supportPaths.push(requiredPath);
    }
  }
  return supportPaths.sort();
}

/** Read and hash the bundle's files from this gateway's tree. */
export async function collectNodeSupportBundle(projectName: string, supportPaths: string[]) {
  const projects = new Set([
    projectName,
    ...supportPaths.filter((p) => p.startsWith('projects/')).map((p) => p.split('/')[1]),
  ]);
  const machines = packMachineNames(poolDir);
  const portabilityErrors = [...projects].flatMap((name) =>
    validatePackPortability(path.join(projectsDir, name), `projects/${name}`, machines),
  );
  if (portabilityErrors.length)
    throw new Error(`Project pack is not portable:\n${portabilityErrors.join('\n')}`);
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
  const shippedErrors = files.flatMap((file) => {
    if (!file.relativePath.startsWith('projects/')) return [];
    return validatePackBytesPortability(
      file.relativePath,
      Buffer.from(file.contentBase64, 'base64'),
      machines,
    );
  });
  if (shippedErrors.length)
    throw new Error(`Project support is not portable:\n${shippedErrors.join('\n')}`);
  const manifest = {
    version: 1,
    project: projectName,
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
  return { files, manifest };
}

/** Where a bundle lives on a node. */
function nodeSupportDir(hash: string): string {
  return path.posix.join(NODE_SUPPORT_ROOT, hash);
}

/**
 * Make sure `vars`' slot runs its hooks and runner installer from the bundle
 * that matches this gateway's tree. Local slots use the checkout directly.
 * Returns null when the slot has no project config.
 */
export async function ensureNodeSupportBundle(
  vars: SlotVars,
  runtimeDir: string,
  options: {
    step?: NodeSupportStep;
    projectVars?: ProjectVars;
    io?: NodeSupportIo;
    /**
     * `full` re-checks every bundled file's checksum (prepare). `presence`, the
     * launch default, checks that the manifest and the runner installer files
     * exist; a matching manifest over missing files is reported, never used.
     */
    verify?: 'full' | 'presence';
    /** False for read-only prerequisites: preserve the slot's launch selection. */
    selectSlot?: boolean;
    /** The bundle already read for this project; reused when its paths still match. */
    collected?: Awaited<ReturnType<typeof collectNodeSupportBundle>>;
  } = {},
): Promise<NodeSupportBundleState | null> {
  if (currentProjectSources() ?? options.projectVars?.sourceContext) {
    // No copied pack bundle is admitted. The service deployment still owns framework scripts.
    return {
      supportDir: isLocal(vars.host, vars.machine) ? farmslotRoot : '~/farmslot-node',
      hash: null,
      published: false,
      paths: ['scripts'],
    };
  }
  const step = options.step ?? (() => {});
  const io = options.io ?? defaultIo;
  const verifyMode = options.verify ?? 'presence';
  const projectVars = options.projectVars ?? (await loadProjectVarsIfAny(vars.projectName));
  if (!projectVars) return null;
  const supportPaths = nodeSupportBundlePaths(vars.projectName, projectVars.projectJson);
  if (isLocal(vars.host, vars.machine)) {
    step('support', 'Using local node support source');
    return { supportDir: farmslotRoot, hash: null, published: false, paths: supportPaths };
  }

  const { files, manifest } =
    options.collected && options.collected.manifest.paths.join('\0') === supportPaths.join('\0')
      ? options.collected
      : await collectNodeSupportBundle(vars.projectName, supportPaths);
  // Resolve on the execution node: quoting a literal ~/ path in a hook
  // suppresses shell expansion, and the gateway's home belongs to another host.
  const resolved = await io.exec(
    vars,
    `printf '%s\\n' ${shellExpressionForRemotePath(nodeSupportDir(manifest.hash))}`,
  );
  const supportDir = resolved.stdout.trim();
  if (resolved.exitCode !== 0 || !path.posix.isAbsolute(supportDir)) {
    throw new Error(
      `Node support path did not resolve to an absolute directory (exit ${resolved.exitCode}): ${resolved.stderr}`,
    );
  }
  const manifestPath = path.posix.join(supportDir, 'manifest.json');

  // Always rewritten: another gateway or a prepare may have repointed the slot
  // since this process last looked, and the write is one small file.
  const persistSelection = async (how: 'published' | 'current', publishCommand?: string) => {
    const selection = nodeSupportHashPath(vars.remoteRepo, runtimeDir);
    const references = await (io.retentionReferences ?? nodeSupportRetentionReferences)(vars);
    const result = await io.exec(
      vars,
      buildNodeSupportActivationCommand({
        supportDir,
        supportHash: manifest.hash,
        selectionPath: selection,
        references,
        publishCommand,
        verifyCommand:
          publishCommand || verifyMode === 'full'
            ? buildNodeSupportVerifyCommand({ supportDir, manifestPath, files })
            : presenceCommand(supportDir, manifestPath),
      }),
      { timeout: 180_000 },
    );
    // Another activation may have pruned a bundle checked before taking its lock.
    // Re-materialize it rather than selecting a directory that no longer exists.
    if (result.exitCode === 75) return false;
    if (result.exitCode !== 0) throw new Error(`Node support activation failed: ${result.stderr}`);
    console.log(
      `[node-support] ${vars.slotId} now on bundle ${manifest.hash.slice(0, 8)} (${how}, ${files.length} files)`,
    );
    return true;
  };
  const verifyChecksums = async (dir: string, manifestFile: string): Promise<boolean> => {
    const result = await io.exec(
      vars,
      buildNodeSupportVerifyCommand({ manifestPath: manifestFile, supportDir: dir, files }),
    );
    return result.exitCode === 0;
  };
  const presenceCommand = (dir: string, manifestFile: string): string => {
    const required = [
      manifestFile,
      ...RUNNER_OBSERVABILITY_SUPPORT_PATHS.map((relativePath) =>
        path.posix.join(dir, relativePath),
      ),
    ];
    return required.map((file) => `[ -f ${shellExpressionForRemotePath(file)} ]`).join(' && ');
  };
  const verifyPresence = async (dir: string, manifestFile: string): Promise<boolean> => {
    const result = await io.exec(vars, presenceCommand(dir, manifestFile));
    return result.exitCode === 0;
  };
  const verifyCurrent = (dir: string, manifestFile: string) =>
    verifyMode === 'full' ? verifyChecksums(dir, manifestFile) : verifyPresence(dir, manifestFile);

  if (await io.fileExists(vars, manifestPath)) {
    const current = JSON.parse(await io.readFile(vars, manifestPath)) as { hash?: string };
    if (current.hash === manifest.hash) {
      if (!(await verifyCurrent(supportDir, manifestPath))) {
        throw new Error(`Node support bundle corrupt for ${manifest.hash}`);
      }
      if (options.selectSlot === false || (await persistSelection('current'))) {
        step('support', `Node support bundle current (${files.length} files)`);
        return { supportDir, hash: manifest.hash, published: false, paths: supportPaths };
      }
    }
  }

  const incomingResult = await io.exec(
    vars,
    [
      `mkdir -p ${shellExpressionForRemotePath(`${NODE_SUPPORT_ROOT}/.incoming`)}`,
      `mktemp -d ${shellExpressionForRemotePath(
        path.posix.join(NODE_SUPPORT_ROOT, '.incoming', `${manifest.hash}.XXXXXX`),
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
  if (!(await verifyChecksums(incomingDir, path.posix.join(incomingDir, 'manifest.json')))) {
    await discardIncoming();
    throw new Error(`Node support incoming verification failed for ${manifest.hash}`);
  }
  const publishCommand = buildNodeSupportPublishCommand({
    incomingDir,
    manifestPath,
    supportDir,
    supportHash: manifest.hash,
  });
  const publishResult =
    options.selectSlot === false
      ? await io.exec(vars, publishCommand)
      : { exitCode: (await persistSelection('published', publishCommand)) ? 0 : 75, stderr: '' };
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
  if (!(await verifyChecksums(supportDir, manifestPath))) {
    throw new Error(`Node support publish verification failed for ${manifest.hash}`);
  }
  step('support', `Synced node support bundle (${files.length} files: ${supportPaths.join(', ')})`);
  return { supportDir, hash: manifest.hash, published: true, paths: supportPaths };
}

/**
 * The bundle directory the slot currently selects, read without publishing or
 * repointing: what a prepare rendered into `{{node_support_dir}}` fixtures.
 * Undefined when a remote slot has no valid selection yet.
 */
export async function selectedNodeSupportDir(
  vars: SlotVars,
  runtimeDir: string,
  projectVars?: ProjectVars,
  io: Pick<NodeSupportIo, 'exec'> = defaultIo,
  timeout?: number,
): Promise<string | undefined> {
  if (isLocal(vars.host, vars.machine)) return farmslotRoot;
  if (currentProjectSources() ?? projectVars?.sourceContext) return '~/farmslot-node';
  const result = await io.exec(
    vars,
    nodeSupportSelectionCommand(vars.remoteRepo, runtimeDir),
    timeout ? { timeout } : undefined,
  );
  const directory = result.stdout.trim();
  return result.exitCode === 0 && path.posix.isAbsolute(directory) ? directory : undefined;
}

/**
 * Extra fixture vars a drift check renders with, matching fixture sync. An
 * unreadable selection leaves the placeholder to the renderer's default.
 */
export async function fixtureCheckVars(
  vars: SlotVars,
  projectVars: ProjectVars,
  timeout?: number,
  io: Pick<NodeSupportIo, 'exec'> = defaultIo,
): Promise<Record<string, string> | undefined> {
  try {
    const dir = await selectedNodeSupportDir(
      vars,
      projectVars.runtimeDir || '.agent',
      projectVars,
      io,
      timeout,
    );
    return dir ? { node_support_dir: dir } : undefined;
  } catch {
    return undefined;
  }
}
