import fs from 'node:fs';
import path from 'node:path';

import {
  type TaskExecutionInput,
  type TaskExecutionProvenance,
  type TaskRecipeBindingIdentity,
  verifyTaskExecutionProvenance,
} from '@farmslot/agent-runtime';
import { isRecord, type RecipeConformanceSource } from '@farmslot/protocol';

import { recipeConformanceIdentity } from './conformance.js';
import { assertProjectProviderAuthorized } from './context.js';
import {
  type ProjectRecipeHost,
  type ProjectRecipeHostOptions,
  withProjectRecipeHost,
} from './project-host.js';

interface TaskProjectSelection {
  identity: TaskRecipeBindingIdentity | null;
  packRoot?: string;
  checkoutRoot?: string;
  provider?: { ref: string; module: string; root: string; export: string };
  runtimeDir?: string;
  artifactDir?: string;
}

function source(value: unknown): value is RecipeConformanceSource {
  return (
    isRecord(value) &&
    (value.head === null || typeof value.head === 'string') &&
    typeof value.status === 'string' &&
    typeof value.sourceFingerprint === 'string' &&
    (value.dirtyDigest === undefined ||
      value.dirtyDigest === null ||
      typeof value.dirtyDigest === 'string')
  );
}

function identity(value: unknown): value is TaskRecipeBindingIdentity | null {
  if (value === null) return true;
  return (
    isRecord(value) &&
    typeof value.project === 'string' &&
    (value.app === null || typeof value.app === 'string') &&
    (value.domain === null || typeof value.domain === 'string') &&
    typeof value.adapter === 'string' &&
    typeof value.target === 'string' &&
    source(value.provider) &&
    (value.implementation === undefined ||
      (Array.isArray(value.implementation) &&
        value.implementation.every(
          (entry) => source(entry) && isRecord(entry) && typeof entry.name === 'string',
        ))) &&
    Array.isArray(value.libraries) &&
    value.libraries.every(
      (entry) =>
        source(entry) &&
        isRecord(entry) &&
        typeof entry.name === 'string' &&
        (entry.path === undefined || typeof entry.path === 'string'),
    ) &&
    Array.isArray(value.configuration) &&
    value.configuration.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.path === 'string' &&
        typeof entry.sourceFingerprint === 'string',
    )
  );
}

function readSelection(taskDir: string): TaskProjectSelection {
  const file = path.join(taskDir, 'inputs/recipe-binding.json');
  if (!fs.existsSync(file)) verifyTaskExecutionProvenance(taskDir, null);
  const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!isRecord(value) || !identity(value.identity))
    throw new Error('Invalid retained task binding.');
  if (value.identity === null) return { identity: null };
  const provider = value.provider;
  if (
    typeof value.packRoot !== 'string' ||
    typeof value.checkoutRoot !== 'string' ||
    typeof value.runtimeDir !== 'string' ||
    typeof value.artifactDir !== 'string' ||
    !isRecord(provider) ||
    typeof provider.ref !== 'string' ||
    typeof provider.module !== 'string' ||
    typeof provider.root !== 'string' ||
    typeof provider.export !== 'string'
  )
    throw new Error('Incomplete retained project selection.');
  return {
    identity: value.identity,
    packRoot: value.packRoot,
    checkoutRoot: value.checkoutRoot,
    runtimeDir: value.runtimeDir,
    artifactDir: value.artifactDir,
    provider: {
      ref: provider.ref,
      module: provider.module,
      root: provider.root,
      export: provider.export,
    },
  };
}

/** Freeze tooling only; the product checkout and task recipes stay editable. */
export async function projectTaskExecution(
  host: ProjectRecipeHost,
  install: Omit<TaskExecutionInput, 'bindingIdentity' | 'inputs'>,
): Promise<TaskExecutionInput> {
  const binding = host.context.project;
  if (!binding) throw new Error('Task initialization requires a resolved project.');
  const conformance = await recipeConformanceIdentity(host.engine, {
    project: binding.name,
    app: binding.app,
    domain: binding.domain,
    context: host.context,
    providerRoot: binding.provider.root,
    configurationPaths: [binding.configPath],
    librarySources: host.librarySources,
    artifactsDir: path.join(binding.checkoutRoot, binding.artifactDir),
    implementationSources: [{ name: 'farmslot', root: install.packageRoot }],
    recipes: [],
  });
  const {
    project,
    app,
    domain,
    adapter,
    target,
    provider,
    implementation,
    libraries,
    configuration,
  } = conformance;
  const bindingIdentity: TaskRecipeBindingIdentity = {
    project,
    app,
    domain,
    adapter,
    target,
    provider,
    implementation,
    libraries,
    configuration,
  };
  const selection: TaskProjectSelection = {
    identity: bindingIdentity,
    packRoot: binding.root,
    checkoutRoot: binding.checkoutRoot,
    provider: binding.provider,
    runtimeDir: binding.farmRuntimeDir,
    artifactDir: binding.artifactDir,
  };
  return {
    ...install,
    bindingIdentity,
    inputs: [
      ...new Set([
        binding.root,
        binding.provider.root,
        ...host.librarySources.map((entry) => entry.root),
        ...configuration.map((entry) => entry.path),
      ]),
    ],
    selectedConfiguration: JSON.stringify(selection),
  };
}

/** Byte verification never executes a path supplied by the task. */
export function verifySelectedTask(taskDir: string): TaskExecutionProvenance {
  const selection = readSelection(taskDir);
  return verifyTaskExecutionProvenance(taskDir, selection.identity);
}

export async function withTaskProjectHost<T>(
  options: ProjectRecipeHostOptions,
  taskDir: string,
  invoke: (host: ProjectRecipeHost) => Promise<T>,
): Promise<T> {
  const selection = readSelection(taskDir);
  const receipt = verifyTaskExecutionProvenance(taskDir, selection.identity);
  const selected = selection.identity;
  if (
    !selected ||
    !selection.provider ||
    !selection.packRoot ||
    !selection.checkoutRoot ||
    !selection.runtimeDir ||
    !selection.artifactDir
  )
    throw new Error('An unbound task has no project provider.');
  const provider = selection.provider;
  assertProjectProviderAuthorized(options, {
    project: selected.project,
    ref: provider.ref,
    module: provider.module,
  });
  const retained = (file: string): string => {
    const input =
      receipt.retainedInputs.find((entry) => entry.source === file) ??
      receipt.retainedInputs.find((entry) => file.startsWith(`${entry.source}${path.sep}`));
    if (!input) throw new Error(`Task input was not retained: ${file}`);
    return path.join(input.path, path.relative(input.source, file));
  };
  return withProjectRecipeHost(
    {
      ...options,
      projectsDir: undefined,
      resolveSourceBinding: undefined,
      tokens: [
        '--target',
        selection.checkoutRoot,
        '--project',
        selected.project,
        '--adapter',
        selected.adapter,
        '--runtime-dir',
        selection.runtimeDir,
        ...(selected.app ? ['--app', selected.app] : []),
      ],
      projects: [
        {
          root: retained(selection.packRoot),
          config: {
            name: selected.project,
            repoUrl: '',
            paths: { runtimeDir: selection.runtimeDir, artifactDir: selection.artifactDir },
            apps: selected.app ? [selected.app] : [],
            recipe: {
              adapter: selected.adapter,
              ...(selected.app ? { app: selected.app } : {}),
              ...(selected.domain ? { domain: selected.domain } : {}),
              provider: {
                module: path.relative(provider.root, provider.module),
                root: { projectPath: retained(provider.root) },
                export: provider.export,
              },
              libraries: selected.libraries.map((library) => {
                if (!library.path)
                  throw new Error(`Missing retained library path for ${library.name}.`);
                return {
                  name: library.name,
                  owner: selected.project,
                  source: retained(library.path),
                };
              }),
            },
          },
        },
      ],
    },
    invoke,
  );
}
