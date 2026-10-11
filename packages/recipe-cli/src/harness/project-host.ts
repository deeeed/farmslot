import path from 'node:path';

import { createAdapterRegistry } from '@farmslot/adapter-sdk';
import type { RecipeLibrarySource } from '@farmslot/recipe-runner';

import { configureHarnessAdapters, harnessAdapters } from './adapters.js';
import { createRuntimeRecipeCatalog } from './catalog.js';
import {
  authorizedProjectLibraries,
  contextPorts,
  loadProjectProvider,
  type LoadProjectProviderOptions,
  type ProjectProvider,
  resolveProjectContext,
  type ResolveProjectContextOptions,
} from './context.js';
import {
  type HarnessContext,
  harnessContext,
  ProjectBindingError,
  setHarnessContext,
} from './context-state.js';
import { providerSourceSnapshot } from './execution-provenance.js';
import { withHarnessInvocation } from './harness-cli.js';
import { configureHarnessHost, harnessHost } from './host.js';
import { applyRuntimeDirOption, type CliOptions } from './parse-args.js';
import { recipeOutputRoots } from './paths.js';
import { resolveLibrarySources } from './recipe-library.js';
import { createDefaultRecipeEngine, type RecipeEngine } from './run-engine.js';

export interface ProjectRecipeHostOptions
  extends ResolveProjectContextOptions, LoadProjectProviderOptions {}

export interface ProjectRecipeHost {
  context: HarnessContext;
  provider: ProjectProvider;
  engine: RecipeEngine;
  librarySources: RecipeLibrarySource[];
  cli: CliOptions;
}

/** Resolve, authorize and compose one invocation through the same direct/hosted path. */
export function withProjectRecipeHost<T>(
  options: ProjectRecipeHostOptions,
  invoke: (host: ProjectRecipeHost) => Promise<T>,
): Promise<T> {
  return withHarnessInvocation(async () => {
    const previousHost = harnessHost();
    const previousContext = harnessContext();
    const previousAdapters = harnessAdapters();
    const previousEnv = { ...process.env };
    let provider: ProjectProvider | undefined;
    try {
      configureHarnessAdapters(createAdapterRegistry());
      configureHarnessHost({ ...previousHost, name: 'farmslot recipe' });
      applyRuntimeDirOption(options.options ?? {});
      const context = await resolveProjectContext(options);
      const binding = context.project!;
      const libraries = authorizedProjectLibraries(context);
      if (libraries.length !== binding.libraries.length)
        throw new ProjectBindingError(
          'LIBRARY_UNAUTHORIZED',
          'Discovered recipe libraries are not authorized executable sources.',
          'register the project or select each library with --library name=path',
        );
      const cli: CliOptions = {
        ...options.options,
        target: context.target.value,
        runtimeDir: binding.runtimeDir,
        artifactsDir: path.join(binding.checkoutRoot, binding.artifactDir),
        ...(binding.manifest && !options.options?.actionManifest
          ? { actionManifest: binding.manifest }
          : {}),
      };
      applyRuntimeDirOption(cli);
      provider = await loadProjectProvider(context, { ...options, options: cli });
      const targeting = contextPorts(context, options.tokens, {
        '--cdp-port': true,
        '--watcher-port': true,
      });
      context.ports = targeting.ports;
      Object.assign(process.env, targeting.env);
      setHarnessContext(context);
      const engine =
        provider.engine ??
        createDefaultRecipeEngine({
          runtime: provider.runtime,
          catalog: createRuntimeRecipeCatalog({
            runtime: provider.runtime,
            bundledLibrary: {
              name: binding.name,
              root: binding.provider.root,
              actionNamespace: binding.domain ?? binding.name,
            },
          }),
          runtimeSource: {
            kind: 'custom-adapter',
            trust: 'trusted',
            name: binding.name,
            path: binding.provider.root,
            digest: binding.provider.identity.sourceFingerprint,
          },
          resolveRuntimeDigest: async () =>
            providerSourceSnapshot(
              binding.provider.root,
              binding.provider.module,
              recipeOutputRoots(context.target.value, binding),
            ).sourceFingerprint,
        });
      const librarySources = await resolveLibrarySources(engine, undefined, undefined, libraries);
      return await invoke({ context, provider, engine, librarySources, cli });
    } finally {
      try {
        await provider?.finalize?.();
      } finally {
        // Provider factories and runtime targeting may change process state.
        // Every invocation shares the host queue, so these changes stay scoped.
        for (const key of new Set([...Object.keys(previousEnv), ...Object.keys(process.env)])) {
          if (previousEnv[key] === undefined) delete process.env[key];
          else process.env[key] = previousEnv[key];
        }
        setHarnessContext(previousContext);
        configureHarnessAdapters(previousAdapters);
        configureHarnessHost(previousHost);
      }
    }
  });
}
