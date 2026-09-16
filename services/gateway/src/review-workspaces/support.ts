import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readlinkSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { resolveConfiguredExecutionTemplateSources } from '@farmslot/agent-runtime';
import { durableWrite } from '@farmslot/agent-runtime/native/storage';
import {
  isTerminalRunStatus,
  type ReviewWorkspaceSupportBinding,
  type ReviewWorkspaceSupportConfig,
  type Run,
} from '@farmslot/protocol';

import { loadProjectVars } from '../core/config.js';
import { execFileArgv, isLocal } from '../core/exec.js';
import {
  type SlotLocality,
  slotMkdir,
  slotWriteFileBuffer,
  type SlotWriteFileEntry,
  slotWriteFiles,
} from '../core/slot-io.js';
import { loadPoolConfigs } from '../fleet/state.js';
import { requestNativeNode } from '../runners/native/node.js';
import { getRun, persistRunNow, runsDirectory, updateRun } from '../runs/store.js';
import { assertNativeRunOwner } from '../security/native-worker-owner.js';

import { REVIEW_SKILL_INSTALL_SCRIPT } from './skill-install.js';
import {
  collectReviewWorkspaceSupport,
  type FrozenReviewWorkspaceSupport,
  reviewWorkspaceSupportEnvironment,
  verifyReviewWorkspaceSupport,
} from './skills.js';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const MAX_BATCH_BYTES = 512 * 1024;
const MANIFEST = 'manifest.json';
type Manifest = FrozenReviewWorkspaceSupport['manifest'];
type Admission = { identity: string; fingerprint: string | null; digest: string | null };

// Compact node-side verification avoids one shell process per file and oversized argv.
// It verifies the exact file tree and controller-selected manifest before atomic publication.
export const REVIEW_SUPPORT_NODE_SCRIPT = String.raw`
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const input=JSON.parse(process.argv[1]);
const sha=data=>crypto.createHash('sha256').update(data).digest('hex');
if(!/^[a-f0-9]{64}$/.test(input.digest)||!path.isAbsolute(input.ownerRoot))throw Error('Invalid support identity');
const owner=fs.realpathSync(input.ownerRoot),root=path.join(owner,'support'),target=path.join(root,input.digest);
fs.mkdirSync(root,{recursive:true});
if(fs.lstatSync(root).isSymbolicLink()||fs.realpathSync(root)!==root)throw Error('Support cache root is not concrete');
function verify(directory){
 if(fs.lstatSync(directory).isSymbolicLink()||fs.realpathSync(directory)!==directory)throw Error('Support cache is symlinked');
 const manifestPath=path.join(directory,'manifest.json');
 if(!fs.lstatSync(manifestPath).isFile()||fs.lstatSync(manifestPath).isSymbolicLink())throw Error('Support manifest is not a regular file');
 const bytes=fs.readFileSync(manifestPath);
 if(sha(bytes)!==input.manifestSha)throw Error('Support manifest checksum mismatch');
 const manifest=JSON.parse(bytes);
 if(manifest.version!==1||manifest.sha256!==input.digest)throw Error('Support digest mismatch');
 const actual=new Set();
 function walk(dir){for(const entry of fs.readdirSync(dir)){const full=path.join(dir,entry),st=fs.lstatSync(full);if(st.isSymbolicLink())throw Error('Support symlink');if(st.isDirectory())walk(full);else if(st.isFile())actual.add(path.relative(directory,full));else throw Error('Support special file');}}
 walk(directory);actual.delete('manifest.json');
 const aggregate=crypto.createHash('sha256');
 for(const file of manifest.files){
  if(!file.path||path.isAbsolute(file.path)||file.path.includes(String.fromCharCode(92))||file.path.includes(String.fromCharCode(0))||file.path.split('/').some(p=>p==='..'||p==='.'||!p)||!actual.delete(file.path))throw Error('Support file tree mismatch');
  const full=path.join(directory,file.path),st=fs.lstatSync(full),content=fs.readFileSync(full);
  if(st.size!==file.size||(st.mode&0o777)!==file.mode||sha(content)!==file.sha256)throw Error('Support checksum mismatch: '+file.path);
  aggregate.update(file.path);aggregate.update(Buffer.from([0]));aggregate.update(file.mode.toString(8));aggregate.update(Buffer.from([0]));aggregate.update(content);aggregate.update(Buffer.from([0]));
 }
 if(actual.size)throw Error('Support contains unrecorded files');
 if(sha(JSON.stringify({files:aggregate.digest('hex'),sources:manifest.sources,environment:manifest.environment}))!==input.digest)throw Error('Support content identity mismatch');
}
if(input.action==='prepare'){const incoming=fs.mkdtempSync(path.join(root,'.incoming-'+input.digest+'-'));process.stdout.write(JSON.stringify({incoming}));}
else if(input.action==='verify'){
 if(!fs.existsSync(target)){process.stdout.write(JSON.stringify({ready:false}));}
 else{verify(target);process.stdout.write(JSON.stringify({ready:true,path:target,published:false}));}
}else{
 const incoming=input.incoming;
 if(!incoming||path.dirname(incoming)!==root||!path.basename(incoming).startsWith('.incoming-'+input.digest+'-'))throw Error('Invalid incoming support path');
 if(input.action==='discard'){fs.rmSync(incoming,{recursive:true,force:true});process.stdout.write('{}');}
 else if(input.action==='publish'){
  verify(incoming);let published=false;
  try{fs.renameSync(incoming,target);published=true;}catch(error){if(!['EEXIST','ENOTEMPTY'].includes(error.code))throw error;verify(target);fs.rmSync(incoming,{recursive:true,force:true});}
  process.stdout.write(JSON.stringify({ready:true,path:target,published}));
 }else throw Error('Unknown support operation');
}
`;

export interface ReviewWorkspaceSupportDependencies {
  getRun: typeof getRun;
  updateRun: typeof updateRun;
  persistRunNow: typeof persistRunNow;
  loadProjectVars: typeof loadProjectVars;
  loadPoolConfigs: typeof loadPoolConfigs;
  collect: typeof collectReviewWorkspaceSupport;
  cacheRoot: () => string;
  env: () => NodeJS.ProcessEnv;
  writeFiles: typeof slotWriteFiles;
  writeBuffer: typeof slotWriteFileBuffer;
  mkdir: typeof slotMkdir;
  execute: (
    io: SlotLocality,
    argv: string[],
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
}
const defaults: ReviewWorkspaceSupportDependencies = {
  getRun,
  updateRun,
  persistRunNow,
  loadProjectVars,
  loadPoolConfigs,
  collect: collectReviewWorkspaceSupport,
  cacheRoot: () => path.join(runsDirectory(), 'review-workspace-support'),
  env: () => process.env,
  writeFiles: slotWriteFiles,
  writeBuffer: slotWriteFileBuffer,
  mkdir: slotMkdir,
  execute: async (io, argv) => {
    if (isLocal(io.host, io.machine))
      return execFileArgv([process.execPath, ...argv.slice(1)], { timeout: 300_000 });
    if (!io.nodeRequest) throw new Error('Review support requires an owner-bound node transport');
    return (await io.nodeRequest('exec', { argv, timeout: 300_000 }, { timeout: 310_000 })) as {
      exitCode: number;
      stdout: string;
      stderr: string;
    };
  },
};
const pending = new Map<string, Promise<unknown>>();
function shared<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const current = pending.get(key);
  if (current) return current as Promise<T>;
  const promise = Promise.resolve()
    .then(operation)
    .finally(() => pending.delete(key));
  pending.set(key, promise);
  return promise;
}
async function optionalJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Metadata includes ctime/inode as well as content size/mtime, including dirty source trees. */
function sourceFingerprint(
  projectConfig: string,
  config: ReviewWorkspaceSupportConfig,
  env: NodeJS.ProcessEnv,
): string {
  const definitions = [
    ...(config.skills ?? []),
    ...(config.libraries ?? []),
    ...(config.runtime ? [config.runtime] : []),
  ];
  const resolution = resolveConfiguredExecutionTemplateSources(
    {
      sources: definitions.map((source, i) => ({
        id: String(i),
        kind: 'workspace',
        root: source.root,
        ...(source.subpath ? { subpath: source.subpath } : {}),
      })),
    },
    { projectPackRoot: path.dirname(projectConfig), env },
  );
  if (resolution.unavailable.length)
    throw new Error(
      `Admitted review support source is unavailable: ${resolution.unavailable.map((item) => `${definitions[Number(item.id)].name} (${item.reason})`).join(', ')}`,
    );
  const fingerprint = createHash('sha256').update(JSON.stringify(config));
  for (const [index, source] of resolution.sources.entries()) {
    fingerprint.update(JSON.stringify([source.root, source.sourceRevision, source.sourceDirty]));
    const includeDependencies = definitions[index] === config.runtime;
    function visit(directory: string) {
      for (const name of readdirSync(directory).sort()) {
        if (name === '.git' || (!includeDependencies && name === 'node_modules')) continue;
        const file = path.join(directory, name),
          st = lstatSync(file, { bigint: true });
        fingerprint.update(
          JSON.stringify([
            file,
            String(st.ino),
            String(st.mode),
            String(st.size),
            String(st.mtimeNs),
            String(st.ctimeNs),
          ]),
        );
        if (st.isSymbolicLink()) fingerprint.update(readlinkSync(file));
        else if (st.isDirectory()) visit(file);
      }
    }
    visit(source.root);
  }
  return fingerprint.digest('hex');
}

async function gatewayBundle(
  project: Awaited<ReturnType<typeof loadProjectVars>>,
  config: ReviewWorkspaceSupportConfig,
  fingerprint: string,
  deps: ReviewWorkspaceSupportDependencies,
): Promise<Manifest> {
  return shared(`source:${deps.cacheRoot()}:${fingerprint}`, async () => {
    const indexFile = path.join(deps.cacheRoot(), 'sources', `${fingerprint}.json`);
    const existing = await optionalJson<{ digest: string }>(indexFile);
    if (existing) {
      if (!/^[a-f0-9]{64}$/.test(existing.digest))
        throw new Error('Trusted gateway support index is corrupt');
      const manifest = await optionalJson<Manifest>(
        path.join(deps.cacheRoot(), 'bundles', existing.digest, MANIFEST),
      );
      if (!manifest || manifest.sha256 !== existing.digest)
        throw new Error('Trusted gateway support cache is corrupt');
      return manifest;
    }
    const bundle = await deps.collect(project, config, { env: deps.env() });
    verifyReviewWorkspaceSupport(bundle, bundle.manifest.sha256);
    if (sourceFingerprint(project.projectConfig, config, deps.env()) !== fingerprint)
      throw new Error('Review support sources changed while freezing');
    const directory = path.join(deps.cacheRoot(), 'bundles', bundle.manifest.sha256);
    const parent = path.dirname(directory);
    await mkdir(parent, { recursive: true });
    const incoming = await mkdtemp(path.join(parent, '.incoming-'));
    try {
      await slotWriteFiles(
        { host: 'localhost', machine: 'local', sshTarget: '' },
        incoming,
        bundle.files.map((file) => ({
          path: file.relativePath,
          content: file.contentBase64,
          mode: file.mode,
        })),
      );
      durableWrite(path.join(incoming, MANIFEST), bundle.manifest);
      try {
        await rename(incoming, directory);
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? ''))
          throw error;
        if (!isDeepStrictEqual(await optionalJson(path.join(directory, MANIFEST)), bundle.manifest))
          throw new Error('Conflicting trusted support publication');
      }
      await mkdir(path.dirname(indexFile), { recursive: true });
      durableWrite(indexFile, { digest: bundle.manifest.sha256 });
    } finally {
      await rm(incoming, { recursive: true, force: true });
    }
    return bundle.manifest;
  });
}

async function publishOnNode(
  io: SlotLocality,
  ownerRoot: string,
  manifest: Manifest,
  deps: ReviewWorkspaceSupportDependencies,
): Promise<string> {
  return shared(`node:${io.machine}:${ownerRoot}:${manifest.sha256}`, async () => {
    const manifestBytes = await readFile(
      path.join(deps.cacheRoot(), 'bundles', manifest.sha256, MANIFEST),
    );
    const manifestSha = hash(manifestBytes);
    const command = async (action: string, incoming?: string) => {
      const result = await deps.execute(io, [
        'node',
        '-e',
        REVIEW_SUPPORT_NODE_SCRIPT,
        JSON.stringify({ action, ownerRoot, digest: manifest.sha256, manifestSha, incoming }),
      ]);
      if (result.exitCode !== 0)
        throw new Error(`Review support ${action} failed: ${result.stderr}`);
      return JSON.parse(result.stdout) as { ready?: boolean; path?: string; incoming?: string };
    };
    const current = await command('verify');
    if (current.ready) return current.path!;
    const prepared = await command('prepare');
    if (!prepared.incoming) throw new Error('Review support preparation did not return a path');
    const incoming = prepared.incoming;
    try {
      let batch: SlotWriteFileEntry[] = [],
        bytes = 0;
      const flush = async () => {
        if (batch.length) await deps.writeFiles(io, incoming, batch);
        batch = [];
        bytes = 0;
      };
      for (const file of manifest.files) {
        const data = await readFile(
          path.join(deps.cacheRoot(), 'bundles', manifest.sha256, file.path),
        );
        if (data.length !== file.size || hash(data) !== file.sha256)
          throw new Error('Trusted gateway support file checksum mismatch');
        const entry = { path: file.path, content: data.toString('base64'), mode: file.mode };
        const size = Buffer.byteLength(JSON.stringify(entry));
        if (size > MAX_BATCH_BYTES) {
          await flush();
          await deps.mkdir(io, path.posix.dirname(path.posix.join(incoming, file.path)));
          await deps.writeBuffer(io, path.posix.join(incoming, file.path), data, {
            mode: file.mode,
          });
        } else {
          if (bytes + size > MAX_BATCH_BYTES || batch.length >= 64) await flush();
          batch.push(entry);
          bytes += size;
        }
      }
      await flush();
      await deps.writeBuffer(io, path.posix.join(incoming, MANIFEST), manifestBytes, {
        mode: 0o600,
      });
      const published = await command('publish', incoming);
      if (!published.ready || !published.path)
        throw new Error('Review support publish returned an invalid receipt');
      return published.path;
    } finally {
      await command('discard', incoming);
    }
  });
}

function summarize(manifest: Manifest, root: string): ReviewWorkspaceSupportBinding {
  const runtime = manifest.sources.find((source) => source.kind === 'runtime');
  return {
    path: root,
    sha256: manifest.sha256,
    environment: manifest.environment,
    sources: manifest.sources.map((source) => ({
      kind: source.kind,
      name: source.name,
      ...(source.sourceRevision !== undefined ? { sourceRevision: source.sourceRevision } : {}),
      ...(source.sourceDirty !== undefined ? { sourceDirty: source.sourceDirty } : {}),
      ...(source.packages?.[0]
        ? { packageName: source.packages[0].name, packageVersion: source.packages[0].version }
        : {}),
    })),
    skills: manifest.sources
      .filter((source) => source.kind === 'skill')
      .map((source) => ({ name: source.name, path: path.posix.join(root, source.entry!) })),
    ...(runtime
      ? { runtime: { name: runtime.name, path: path.posix.join(root, 'bin', runtime.name) } }
      : {}),
  };
}

export async function ensureReviewWorkspaceSupport(
  runId: string,
  assertCurrent: () => void | Promise<void>,
  overrides: Partial<ReviewWorkspaceSupportDependencies> = {},
): Promise<ReviewWorkspaceSupportBinding | undefined> {
  const deps = { ...defaults, ...overrides };
  await assertCurrent();
  const invokingRun = deps.getRun(runId);
  if (!invokingRun) throw new Error('Review support run is unavailable');
  assertNativeRunOwner(invokingRun);
  const result = await shared(`run:${deps.cacheRoot()}:${runId}`, async () => {
    if (!/^[A-Za-z0-9_-]+$/.test(runId)) throw new Error('Invalid review support run identity');
    const initial = deps.getRun(runId);
    if (
      !initial?.reviewWorkspace ||
      initial.flowType !== 'review-pr' ||
      initial.slotId !== null ||
      initial.transport !== 'native' ||
      isTerminalRunStatus(initial.status)
    )
      throw new Error('Review support requires an active allocated native workspace');
    assertNativeRunOwner(initial);
    const identity = (run: Run) =>
      JSON.stringify({
        owner: run.nativeOwnerPrincipalId,
        project: run.project,
        subject: run.reviewWorkspaceSubject,
        target: run.reviewWorkspaceTarget,
        workspace: { ...run.reviewWorkspace, support: undefined },
        domain: run.domain,
        template: run.executionTemplate,
      });
    const expected = identity(initial),
      generation = initial.engineState?.generation ?? 0;
    const check = async () => {
      await assertCurrent();
      const run = deps.getRun(runId);
      if (
        !run ||
        isTerminalRunStatus(run.status) ||
        identity(run) !== expected ||
        (run.engineState?.generation ?? 0) !== generation
      )
        throw new Error('Review support ownership or generation changed');
      assertNativeRunOwner(run);
      return run;
    };
    await check();
    const admissionPath = path.join(deps.cacheRoot(), 'admissions', `${runId}.json`);
    let admission = await optionalJson<Admission>(admissionPath);
    let manifest: Manifest;
    if (admission) {
      if (admission.identity !== expected)
        throw new Error('Admitted review support identity changed');
      if (admission.digest === null) {
        if (admission.fingerprint !== null || initial.reviewWorkspace.support)
          throw new Error('Empty review support admission conflicts with its binding');
        return undefined;
      }
      if (!/^[a-f0-9]{64}$/.test(admission.digest))
        throw new Error('Admitted review support digest is invalid');
      // Started reviews retain admitted bytes. Current source/configuration is
      // consulted only by a new admission, not by recovery of an existing one.
      const saved = await optionalJson<Manifest>(
        path.join(deps.cacheRoot(), 'bundles', admission.digest, MANIFEST),
      );
      if (!saved || saved.sha256 !== admission.digest)
        throw new Error('Admitted review support bundle is missing or corrupt');
      manifest = saved;
    } else {
      if (initial.reviewWorkspace.support)
        throw new Error('Admitted review support record is missing');
      const project = await deps.loadProjectVars(initial.project);
      const config = project.projectJson.static_review?.support;
      if (!config) {
        await check();
        await mkdir(path.dirname(admissionPath), { recursive: true });
        durableWrite(admissionPath, { identity: expected, fingerprint: null, digest: null });
        return undefined;
      }
      if (initial.agentContexts?.some((context) => context.nativeSession?.launchRequestedAt))
        throw new Error('Cannot add review support after reviewer launch');
      const fingerprint = sourceFingerprint(project.projectConfig, config, deps.env());
      manifest = await gatewayBundle(project, config, fingerprint, deps);
      if (
        sourceFingerprint(project.projectConfig, config, deps.env()) !== fingerprint ||
        !isDeepStrictEqual(
          (await deps.loadProjectVars(initial.project)).projectJson.static_review?.support,
          config,
        )
      )
        throw new Error('Review support source changed before admission');
      const current = await check();
      if (current.agentContexts?.some((context) => context.nativeSession?.launchRequestedAt))
        throw new Error('Cannot add review support after reviewer launch');
      admission = { identity: expected, fingerprint, digest: manifest.sha256 };
      await mkdir(path.dirname(admissionPath), { recursive: true });
      durableWrite(admissionPath, admission);
    }
    const pools = (await deps.loadPoolConfigs()).filter(
      (pool) => pool.machine === initial.reviewWorkspace!.machine,
    );
    if (pools.length !== 1) throw new Error('Review support machine configuration is unavailable');
    const pool = pools[0];
    if (
      initial.reviewWorkspace.executionNodeId !==
      (isLocal(pool.host, pool.machine) ? 'local' : pool.machine)
    )
      throw new Error('Review support execution node changed');
    const io: SlotLocality = {
      host: pool.host,
      machine: pool.machine,
      sshTarget: `${pool.sshUser}@${pool.host}`,
      nodeRequest: (method, params, options) =>
        requestNativeNode(
          initial.nativeOwnerPrincipalId!,
          pool.machine,
          method,
          params,
          options?.timeout ?? 30_000,
        ),
    };
    const ownerRoot = path.posix.resolve(initial.reviewWorkspace.checkoutPath, '../../..');
    const root = await publishOnNode(io, ownerRoot, manifest, deps);
    const binding = summarize(manifest, root);
    reviewWorkspaceSupportBindingEnvironment(
      binding,
      [
        initial.reviewWorkspace.checkoutPath,
        initial.reviewWorkspace.taskPath,
        initial.reviewWorkspace.artifactPath,
      ],
      '',
    );
    const current = await check();
    if (
      current.reviewWorkspace!.support &&
      !isDeepStrictEqual(current.reviewWorkspace!.support, binding)
    )
      throw new Error('Review support binding changed during publication');
    if (!current.reviewWorkspace!.support) {
      const updated = deps.updateRun(runId, {
        reviewWorkspace: { ...current.reviewWorkspace!, support: binding },
      });
      await deps.persistRunNow(updated, 'review support ready');
    }
    const installation = await deps.execute(io, [
      'node',
      '-e',
      REVIEW_SKILL_INSTALL_SCRIPT,
      JSON.stringify({
        checkout: current.reviewWorkspace!.checkoutPath,
        skills: binding.skills,
        verifyOnly:
          current.agentContexts?.some((context) => context.nativeSession?.launchRequestedAt) ??
          false,
      }),
    ]);
    if (installation.exitCode !== 0)
      throw new Error(`Review skill installation failed: ${installation.stderr}`);
    const installed = JSON.parse(installation.stdout) as {
      verified?: boolean;
      installed?: string[];
    };
    if (
      !installed.verified ||
      !isDeepStrictEqual(
        installed.installed,
        binding.skills.map((skill) => skill.name),
      )
    )
      throw new Error('Review skills were not verified on the execution node');
    await check();
    return binding;
  });
  await assertCurrent();
  const current = deps.getRun(runId);
  if (!current || isTerminalRunStatus(current.status))
    throw new Error('Review support run stopped');
  assertNativeRunOwner(current);
  return result;
}

export function reviewWorkspaceSupportBindingEnvironment(
  binding: ReviewWorkspaceSupportBinding,
  writableRoots: string[],
  inheritedPath: string,
): { set: Record<string, string>; unset: string[] } {
  return reviewWorkspaceSupportEnvironment(
    { manifest: { environment: binding.environment } },
    binding.path,
    writableRoots,
    inheritedPath,
  );
}

/** Remove only verified framework skill links after the reviewer has stopped. */
export async function removeReviewWorkspaceSkills(run: Run): Promise<void> {
  const workspace = run.reviewWorkspace;
  if (!workspace?.support) return;
  assertNativeRunOwner(run);
  const pools = (await loadPoolConfigs()).filter((pool) => pool.machine === workspace.machine);
  if (pools.length !== 1) throw new Error('Review skill cleanup machine is unavailable');
  const pool = pools[0];
  const io: SlotLocality = {
    host: pool.host,
    machine: pool.machine,
    sshTarget: `${pool.sshUser}@${pool.host}`,
    nodeRequest: (method, params, options) =>
      requestNativeNode(
        run.nativeOwnerPrincipalId!,
        pool.machine,
        method,
        params,
        options?.timeout ?? 30000,
      ),
  };
  const result = await defaults.execute(io, [
    'node',
    '-e',
    REVIEW_SKILL_INSTALL_SCRIPT,
    JSON.stringify({
      action: 'cleanup',
      checkout: workspace.checkoutPath,
      skills: workspace.support.skills,
    }),
  ]);
  if (result.exitCode !== 0) throw new Error(`Review skill cleanup failed: ${result.stderr}`);
}
