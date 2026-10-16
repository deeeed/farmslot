import fs from 'node:fs';
import path from 'node:path';

import {
  type TaskExecutionInput,
  type TaskExecutionProvenance,
  type TaskRecipeBindingIdentity,
  verifyTaskExecutionProvenance,
} from '@farmslot/agent-runtime';
import { isRecord, type RecipeConformanceSource } from '@farmslot/protocol';

import { optionValues } from './command-contract.js';
import { recipeConformanceIdentity } from './conformance.js';
import { readProject } from './context.js';
import { ProjectBindingError } from './context-state.js';
import {
  type ProjectRecipeHost,
  type ProjectRecipeHostOptions,
  withProjectRecipeHostContext,
} from './project-host.js';

interface TaskProjectSelection {
  identity: TaskRecipeBindingIdentity | null;
  packRoot?: string;
  checkoutRoot?: string;
  provider?: { ref: string; module: string; root: string; export: string };
  runtimeDir?: string;
  farmRuntimeDir?: string;
  artifactDir?: string;
  libraryOwners?: Record<string, string>;
  manifest?: string;
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
    typeof value.farmRuntimeDir !== 'string' ||
    typeof value.artifactDir !== 'string' ||
    !isRecord(provider) ||
    typeof provider.ref !== 'string' ||
    typeof provider.module !== 'string' ||
    typeof provider.root !== 'string' ||
    typeof provider.export !== 'string'
  )
    throw new Error('Incomplete retained project selection.');
  const libraryOwners: Record<string, string> = {};
  if (value.libraryOwners !== undefined) {
    if (!isRecord(value.libraryOwners)) throw new Error('Invalid retained library owners.');
    for (const [name, owner] of Object.entries(value.libraryOwners)) {
      if (typeof owner !== 'string') throw new Error('Invalid retained library owner.');
      libraryOwners[name] = owner;
    }
  }
  return {
    identity: value.identity,
    libraryOwners,
    ...(typeof value.manifest === 'string' ? { manifest: value.manifest } : {}),
    packRoot: value.packRoot,
    checkoutRoot: value.checkoutRoot,
    runtimeDir: value.runtimeDir,
    farmRuntimeDir: value.farmRuntimeDir,
    artifactDir: value.artifactDir,
    provider: {
      ref: provider.ref,
      module: provider.module,
      root: provider.root,
      export: provider.export,
    },
  };
}

/** Workspace retention never changes the provider's bundled recipe root. */
function providerWorkspace(host: ProjectRecipeHost): string {
  const binding = host.context.project;
  if (!binding) throw new Error('Task initialization requires a resolved project.');
  if (binding.provider.package) return binding.provider.root;
  let root = path.dirname(binding.provider.module);
  const checkout = fs.realpathSync(binding.checkoutRoot);
  const within = (parent: string, child: string) =>
    child === parent || child.startsWith(`${parent}${path.sep}`);
  const boundary = within(checkout, root) ? checkout : fs.realpathSync(binding.provider.root);
  if (!within(boundary, root)) throw new Error('Provider module is outside its authorized source.');
  while (!fs.existsSync(path.join(root, 'package.json'))) {
    if (root === boundary)
      throw new Error(
        'Provider tooling must declare a workspace manifest within its authorized source.',
      );
    const parent = path.dirname(root);
    if (parent === root || !within(boundary, parent))
      throw new Error('Provider tooling workspace escapes its authorized source.');
    root = parent;
  }
  if (
    root === checkout ||
    root === fs.realpathSync(host.context.target.value) ||
    (binding.app && root === path.resolve(checkout, binding.app))
  ) {
    const manifest: unknown = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (
      !isRecord(manifest) ||
      !Array.isArray(manifest.files) ||
      manifest.files.length === 0 ||
      !manifest.files.every(
        (entry) =>
          typeof entry === 'string' &&
          !/[?*{}[\]]/.test(entry.split('/')[0]!) &&
          !path.isAbsolute(entry) &&
          !entry.split('/').some((part) => part === '.' || part === '..'),
      )
    )
      throw new Error(
        'Declare a dedicated tooling workspace or bounded manifest files, without changing the recipe root. The product checkout cannot be retained.',
      );
  }
  return root;
}

/** Freeze tooling only; the product checkout and task recipes stay editable. */
export async function projectTaskExecution(
  host: ProjectRecipeHost,
  install: Omit<TaskExecutionInput, 'bindingIdentity' | 'inputs'>,
): Promise<TaskExecutionInput> {
  const binding = host.context.project;
  if (!binding) throw new Error('Task initialization requires a resolved project.');
  const workspace = providerWorkspace(host);
  const conformance = await recipeConformanceIdentity(host.engine, {
    project: binding.name,
    app: binding.app,
    domain: binding.domain,
    context: host.context,
    providerRoot: binding.provider.root,
    configurationPaths: [binding.configPath, ...(binding.manifest ? [binding.manifest] : [])],
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
    ...(binding.manifest ? { manifest: binding.manifest } : {}),
    libraryOwners: Object.fromEntries(
      binding.libraries.map((entry) => [
        entry.name,
        entry.owner ?? entry.overriddenSource?.owner ?? binding.name,
      ]),
    ),
    identity: bindingIdentity,
    packRoot: binding.root,
    checkoutRoot: binding.checkoutRoot,
    provider: binding.provider,
    runtimeDir: binding.runtimeDir,
    farmRuntimeDir: binding.farmRuntimeDir,
    artifactDir: binding.artifactDir,
  };
  return {
    ...install,
    bindingIdentity,
    inputs: [
      ...new Set([
        workspace,
        binding.provider.root,
        binding.provider.module,
        binding.root,
        ...host.librarySources.map((entry) => entry.root),
        ...configuration.map((entry) => entry.path),
      ]),
    ],
    dependencyRoots: [workspace],
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
    !selection.farmRuntimeDir ||
    !selection.artifactDir
  )
    throw new Error('An unbound task has no project provider.');
  const provider = selection.provider;
  const retained = (file: string): string => {
    const input =
      receipt.retainedInputs.find((entry) => entry.source === file) ??
      receipt.retainedInputs.find((entry) => file.startsWith(`${entry.source}${path.sep}`));
    if (!input) throw new Error(`Task input was not retained: ${file}`);
    return path.join(input.path, path.relative(input.source, file));
  };
  const mismatch: (flag: string) => never = (flag) => {
    throw new ProjectBindingError(
      'TASK_BINDING_CHANGED',
      `${flag} changes the retained task binding.`,
      'use the recorded selection or initialize a separate task',
    );
  };
  const rewrite = (argv: readonly string[], stripSelectors: boolean): string[] => {
    const fixed: Record<string, string | null> = {
      '--project': selected.project,
      '--adapter': selected.adapter,
      '--app': selected.app,
    };
    for (const [flag, expected] of Object.entries(fixed)) {
      const requested = optionValues(argv, flag).at(-1);
      if (requested !== undefined && requested !== expected) mismatch(flag);
    }
    const requestedTarget = optionValues(argv, '--target').at(-1);
    if (requestedTarget) {
      const requested = path.resolve(options.cwd ?? process.cwd(), requestedTarget);
      const allowed =
        requested === selection.checkoutRoot ||
        requested === selected.target ||
        requested.startsWith(`${selected.target}${path.sep}`);
      if (!allowed) mismatch('--target');
    }
    const result: string[] = [];
    for (let index = 0; index < argv.length; index += 1) {
      const arg = argv[index]!;
      const flag = arg.split('=', 1)[0]!;
      if (flag === '--action-manifest' && selection.manifest) {
        const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[++index];
        if (!value) mismatch(flag);
        const file = path.resolve(options.cwd ?? process.cwd(), value);
        if (file !== selection.manifest && file !== retained(selection.manifest)) mismatch(flag);
        result.push(flag, retained(selection.manifest));
      } else if (flag === '--library') {
        const pair = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[++index];
        if (!pair) mismatch(flag);
        const equals = pair.indexOf('=');
        const library = selected.libraries.find((entry) => entry.name === pair.slice(0, equals));
        if (!library?.path || equals < 1) mismatch(flag);
        const requested = path.resolve(options.cwd ?? process.cwd(), pair.slice(equals + 1));
        const root = fs.existsSync(requested) ? fs.realpathSync(requested) : requested;
        if (root !== library.path && root !== retained(library.path)) mismatch(flag);
        result.push('--library', `${library.name}=${retained(library.path)}`);
      } else if (stripSelectors && (flag in fixed || flag === '--target')) {
        if (!arg.includes('=')) index += 1;
      } else result.push(arg);
    }
    return result;
  };
  const resources = rewrite(options.tokens, true);
  const invocation = options.invocation
    ? { ...options.invocation, argv: rewrite(options.invocation.argv, false) }
    : undefined;
  const config = readProject(retained(path.join(selection.packRoot, 'project.json')));
  if (!config.recipe) throw new Error('The retained project has no recipe declaration.');
  return withProjectRecipeHostContext(
    {
      ...options,
      ...(invocation ? { invocation } : {}),
      options: {
        ...options.options,
        ...(selection.manifest ? { actionManifest: retained(selection.manifest) } : {}),
        library: selected.libraries.map((entry) => {
          if (!entry.path) throw new Error(`Missing retained library ${entry.name}.`);
          return `${entry.name}=${retained(entry.path)}`;
        }),
      },
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
        ...resources,
      ],
      projects: [
        {
          root: retained(selection.packRoot),
          config: {
            ...config,
            paths: {
              ...config.paths,
              runtimeDir: selection.farmRuntimeDir,
              artifactDir: selection.artifactDir,
            },
            recipe: {
              ...config.recipe,
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
                  owner: selection.libraryOwners?.[library.name] ?? selected.project,
                  source: retained(library.path),
                };
              }),
            },
          },
        },
      ],
    },
    invoke,
    receipt.pin,
  );
}
