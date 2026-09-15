import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import {
  executionTemplateSourceDirty,
  executionTemplateSourceRevision,
  resolveConfiguredExecutionTemplateSources,
} from '@farmslot/agent-runtime';
import type { ExecutionTemplateSourceRoot, ReviewWorkspaceSupportConfig } from '@farmslot/protocol';
export type {
  ReviewWorkspaceSupportConfig,
  ReviewWorkspaceSupportEntry,
  ReviewWorkspaceSupportSource,
} from '@farmslot/protocol';

import { collectSupportFiles, type NodeSupportFile, supportHash } from '../node-support/files.js';

interface SourceManifest {
  kind: 'skill' | 'library' | 'runtime';
  name: string;
  root: ExecutionTemplateSourceRoot;
  subpath?: string;
  destination: string;
  entry?: string;
  sourceEntry?: string;
  sourceRevision?: string;
  sourceDirty?: boolean;
  packages?: Array<{ path: string; name: string; version: string }>;
}
export interface FrozenReviewWorkspaceSupport {
  manifest: {
    version: 1;
    sha256: string;
    sources: SourceManifest[];
    environment: Record<string, string>;
    files: Array<{ path: string; sha256: string; mode: number; size: number }>;
  };
  files: NodeSupportFile[];
}
const safeName = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const packageName = /^(?:@[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const reservedEnvironment = new Set([
  'PATH',
  'NODE_OPTIONS',
  'NODE_PATH',
  'GIT_CEILING_DIRECTORIES',
]);
function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}
function relativeFile(value: string): void {
  if (
    !value ||
    value.includes('\\') ||
    path.posix.isAbsolute(value) ||
    value.split('/').some((part) => !part || part === '.' || part === '..') ||
    /[\0\r\n]/.test(value)
  )
    throw new Error('Review support entry must be a confined relative file');
}
function generatedFile(relativePath: string, content: string, mode: number): NodeSupportFile {
  const bytes = Buffer.from(content);
  return {
    relativePath,
    contentBase64: bytes.toString('base64'),
    mode,
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}
async function regularEntry(root: string, relative: string): Promise<void> {
  relativeFile(relative);
  let current = root;
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    if ((await lstat(current)).isSymbolicLink())
      throw new Error('Review support entry cannot traverse a symlink');
  }
  if (!(await lstat(current)).isFile())
    throw new Error('Review support entry must be a regular file');
}
async function packageRootFor(
  name: string,
  requester: string,
  root: string,
): Promise<string | undefined> {
  if (!packageName.test(name)) throw new Error(`Invalid installed package dependency: ${name}`);
  for (let directory = requester; within(root, directory); directory = path.dirname(directory)) {
    const candidate = path.join(directory, 'node_modules', name);
    try {
      const st = await lstat(candidate);
      let component = root;
      for (const segment of path.relative(root, candidate).split(path.sep)) {
        component = path.join(component, segment);
        if ((await lstat(component)).isSymbolicLink())
          throw new Error(`Review runtime dependency cannot traverse symlinks: ${name}`);
      }
      if (!within(root, await realpath(candidate)))
        throw new Error(
          `Review runtime dependency must be installed inside its declared source: ${name}`,
        );
      if (!st.isDirectory())
        throw new Error(`Review runtime dependency is not a package directory: ${name}`);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (directory === root) break;
  }
  return undefined;
}
async function collectRuntime(root: string, destination: string) {
  const files: NodeSupportFile[] = [];
  const packages: NonNullable<SourceManifest['packages']> = [];
  const visited = new Set<string>();
  async function visit(directory: string) {
    if (visited.has(directory)) return;
    visited.add(directory);
    const metadata = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
    if (
      typeof metadata.name !== 'string' ||
      !packageName.test(metadata.name) ||
      typeof metadata.version !== 'string'
    )
      throw new Error('Review runtime packages must declare a valid name and version');
    const relative = path.posix.join(
      destination,
      path.relative(root, directory).split(path.sep).join('/'),
    );
    packages.push({ path: relative, name: metadata.name, version: metadata.version });
    files.push(...(await collectSupportFiles(directory, relative)));
    const dependencies = {
      ...metadata.dependencies,
      ...metadata.peerDependencies,
      ...metadata.optionalDependencies,
    };
    for (const name of Object.keys(dependencies).sort()) {
      const dependency = await packageRootFor(name, directory, root);
      if (!dependency) {
        if (
          Object.hasOwn(metadata.optionalDependencies ?? {}, name) ||
          metadata.peerDependenciesMeta?.[name]?.optional === true
        )
          continue;
        throw new Error(
          `Review runtime dependency is missing from the configured package: ${name}`,
        );
      }
      await visit(dependency);
    }
  }
  await visit(root);
  return { files, packages: packages.sort((a, b) => a.path.localeCompare(b.path)) };
}

/** Collect twice and reject drift; the caller persists and transports these exact bytes before launch. */
export async function collectReviewWorkspaceSupport(
  project: { projectConfig: string },
  config: ReviewWorkspaceSupportConfig,
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<FrozenReviewWorkspaceSupport> {
  const definitions = [
    ...(config.skills ?? []).map((source) => ({ ...source, kind: 'skill' as const })),
    ...(config.libraries ?? []).map((source) => ({ ...source, kind: 'library' as const })),
    ...(config.runtime ? [{ ...config.runtime, kind: 'runtime' as const }] : []),
  ];
  const ids = new Set<string>();
  for (const source of definitions) {
    const id = `${source.kind}:${source.name}`;
    if (!safeName.test(source.name) || ids.has(id))
      throw new Error('Review support sources require unique safe names');
    ids.add(id);
  }
  const environment = { ...config.environment };
  for (const [name, value] of Object.entries(environment)) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
      reservedEnvironment.has(name) ||
      typeof value !== 'string' ||
      value.includes('\0') ||
      /{{(?!support}})/.test(value)
    )
      throw new Error(`Unsupported review support environment binding: ${name}`);
  }
  const resolution = resolveConfiguredExecutionTemplateSources(
    {
      sources: definitions.map((source) => ({
        id: `${source.kind}:${source.name}`,
        kind: 'workspace',
        root: source.root,
        ...(source.subpath ? { subpath: source.subpath } : {}),
      })),
    },
    { projectPackRoot: path.dirname(project.projectConfig), ...options },
  );
  if (resolution.unavailable.length)
    throw new Error(
      `Review support sources unavailable: ${resolution.unavailable.map((source) => `${source.id} (${source.reason})`).join(', ')}`,
    );
  async function collect() {
    const files: NodeSupportFile[] = [];
    const sources: SourceManifest[] = [];
    for (const definition of definitions) {
      const source = resolution.sources.find(
        (source) => source.id === `${definition.kind}:${definition.name}`,
      )!;
      const destination =
        definition.kind === 'skill'
          ? `skills/${definition.name}`
          : definition.kind === 'library'
            ? `libraries/${definition.name}`
            : 'runtime/package';
      const identity: SourceManifest = {
        kind: definition.kind,
        name: definition.name,
        root: structuredClone(definition.root),
        ...(definition.subpath ? { subpath: definition.subpath } : {}),
        destination,
        sourceRevision: executionTemplateSourceRevision(source.root),
        sourceDirty: executionTemplateSourceDirty(source.root),
      };
      if ('entry' in definition) {
        await regularEntry(source.root, definition.entry);
        identity.entry = `${destination}/${definition.entry}`;
        identity.sourceEntry = definition.entry;
      }
      if (definition.kind === 'runtime') {
        if (!/\.(?:js|mjs|cjs)$/.test(definition.entry))
          throw new Error(
            'Review runtime must select a compiled Node entry, not an installer or shell command',
          );
        const runtime = await collectRuntime(source.root, destination);
        files.push(...runtime.files);
        identity.packages = runtime.packages;
        // A portable argv adapter for the frozen Node entry. No package manager or source bootstrap.
        const relativeEntry = JSON.stringify(identity.entry);
        files.push(generatedFile('package.json', '{"private":true,"type":"commonjs"}\n', 0o644));
        files.push(
          generatedFile(
            `bin/${definition.name}`,
            `#!/usr/bin/env node\nconst { pathToFileURL } = require('node:url');\nconst path = require('node:path');\nconst entry = path.resolve(__dirname, '..', ${relativeEntry});\nprocess.argv[1] = entry;\nimport(pathToFileURL(entry).href).catch(error => { console.error(error); process.exitCode = 1; });\n`,
            0o755,
          ),
        );
      } else {
        const collected = await collectSupportFiles(source.root, destination);
        if (!collected.length)
          throw new Error(`Review support source is empty: ${definition.name}`);
        if (definition.kind === 'skill') {
          if (definition.entry.includes('/'))
            throw new Error('Review skill entry must be at its configured directory root');
          files.push(
            ...collected.map((file) =>
              file.relativePath === identity.entry
                ? { ...file, relativePath: `${destination}/SKILL.md` }
                : file,
            ),
          );
          identity.entry = `${destination}/SKILL.md`;
        } else files.push(...collected);
      }
      sources.push(identity);
    }
    files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    if (new Set(files.map((file) => file.relativePath)).size !== files.length)
      throw new Error('Review support destinations collide');
    return { files, sources };
  }
  const first = await collect();
  const second = await collect();
  if (
    supportHash(first.files) !== supportHash(second.files) ||
    JSON.stringify(first.sources) !== JSON.stringify(second.sources)
  )
    throw new Error('Review support source changed during collection');
  return {
    files: first.files,
    manifest: {
      version: 1,
      sha256: createHash('sha256')
        .update(
          JSON.stringify({ files: supportHash(first.files), sources: first.sources, environment }),
        )
        .digest('hex'),
      sources: first.sources,
      environment,
      files: first.files.map((file) => ({
        path: file.relativePath,
        sha256: file.sha256,
        mode: file.mode,
        size: file.size,
      })),
    },
  };
}

/** The native launch policy must grant this sibling root read access only. */
export function reviewWorkspaceSupportEnvironment(
  support: { manifest: Pick<FrozenReviewWorkspaceSupport['manifest'], 'environment'> },
  immutableRoot: string,
  writableRoots: string[],
  inheritedPath: string,
): { set: Record<string, string>; unset: string[] } {
  if (
    !path.posix.isAbsolute(immutableRoot) ||
    immutableRoot.includes('\0') ||
    writableRoots.some((root) => within(root, immutableRoot) || within(immutableRoot, root))
  )
    throw new Error('Frozen review support must be separate from every writable task/output root');
  return {
    set: {
      ...Object.fromEntries(
        Object.entries(support.manifest.environment).map(([name, value]) => [
          name,
          value.replaceAll('{{support}}', immutableRoot),
        ]),
      ),
      PATH: `${immutableRoot}/bin:${inheritedPath}`,
      GIT_CEILING_DIRECTORIES: immutableRoot,
    },
    unset: ['NODE_OPTIONS', 'NODE_PATH'],
  };
}

/** Verify persisted bytes and their metadata before reusing a frozen support bundle. */
export function verifyReviewWorkspaceSupport(
  support: FrozenReviewWorkspaceSupport,
  expectedSha256: string,
): void {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256) || support.manifest.sha256 !== expectedSha256)
    throw new Error('Frozen review support does not match its admitted digest');
  const files = support.files;
  for (const file of files) {
    relativeFile(file.relativePath);
    const content = Buffer.from(file.contentBase64, 'base64');
    if (
      file.size !== content.length ||
      createHash('sha256').update(content).digest('hex') !== file.sha256
    )
      throw new Error('Frozen review support file does not match its recorded bytes');
  }
  if (new Set(files.map((file) => file.relativePath)).size !== files.length)
    throw new Error('Frozen review support contains duplicate paths');
  const metadata = files.map((file) => ({
    path: file.relativePath,
    sha256: file.sha256,
    mode: file.mode,
    size: file.size,
  }));
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        files: supportHash(files),
        sources: support.manifest.sources,
        environment: support.manifest.environment,
      }),
    )
    .digest('hex');
  if (
    support.manifest.version !== 1 ||
    JSON.stringify(metadata) !== JSON.stringify(support.manifest.files) ||
    digest !== support.manifest.sha256
  )
    throw new Error('Frozen review support manifest no longer matches its snapshot');
}
