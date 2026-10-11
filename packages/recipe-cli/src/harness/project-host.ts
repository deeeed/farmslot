import path from 'node:path';

import { createAdapterRegistry } from '@farmslot/adapter-sdk';
import type { RecipeLibrarySource } from '@farmslot/recipe-runner';
import { assertRecipeActive } from '@farmslot/recipe-runner/adapters/core';

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
import {
  configureHarnessHost,
  harnessHost,
  withRecipeCleanup,
  withRecipeExecutionSignal,
  withRecipeSignals,
} from './host.js';
import { deferCommandOutput } from './json-stream.js';
import { applyRuntimeDirOption, type CliOptions, type ParsedArgs } from './parse-args.js';
import { recipeOutputRoots } from './paths.js';
import { isRecipeExecution } from './project-command.js';
import { resolveLibrarySources } from './recipe-library.js';
import { createDefaultRecipeEngine, type RecipeEngine } from './run-engine.js';

export interface ProjectRecipeHostOptions
  extends ResolveProjectContextOptions, LoadProjectProviderOptions {
  signal?: AbortSignal;
  deferOutput?: boolean;
}

export interface ProjectRecipeHost {
  context: HarnessContext;
  provider: ProjectProvider;
  engine: RecipeEngine;
  librarySources: RecipeLibrarySource[];
  cli: CliOptions;
  invocation?: ParsedArgs;
  signal?: AbortSignal;
  finalize(): Promise<void>;
}

function aggregateFailures(failures: unknown[]): AggregateError {
  return new AggregateError(
    failures,
    failures
      .map((failure) => (failure instanceof Error ? failure.message : String(failure)))
      .join('; '),
  );
}

/** Resolve, authorize and compose one invocation through the same direct/hosted path. */
export function withProjectRecipeHost<T>(
  options: ProjectRecipeHostOptions,
  invoke: (host: ProjectRecipeHost) => Promise<T>,
): Promise<T> {
  return withHarnessInvocation(async () => {
    const executes = isRecipeExecution(options.command, options.options);
    const execute = async (signal?: AbortSignal): Promise<T> => {
      const previousHost = harnessHost();
      const previousContext = harnessContext();
      const previousAdapters = harnessAdapters();
      const previousEnv = { ...process.env };
      let provider: ProjectProvider | undefined;
      let cancellation: Promise<PromiseSettledResult<void>> | undefined;
      let finalization: Promise<void> | undefined;
      let closed = false;
      const cancel = (): void => {
        if (!provider || cancellation || closed) return;
        cancellation = Promise.resolve()
          .then(() => withRecipeCleanup(() => provider!.cancel?.()))
          .then(
            () => ({ status: 'fulfilled' as const, value: undefined }),
            (reason: unknown) => ({ status: 'rejected' as const, reason }),
          );
      };
      const closeProvider = async (): Promise<void> => {
        const initialCancellation = cancellation;
        const outcome = await initialCancellation;
        const failures: unknown[] = outcome?.status === 'rejected' ? [outcome.reason] : [];
        try {
          await provider?.finalize?.();
        } catch (error) {
          failures.push(error);
        }
        if (!initialCancellation) {
          const lateCancellation = await cancellation;
          if (lateCancellation?.status === 'rejected') failures.push(lateCancellation.reason);
        }
        closed = true;
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) throw aggregateFailures(failures);
      };
      const finalize = (): Promise<void> =>
        (finalization ??= signal ? withRecipeCleanup(closeProvider) : closeProvider());
      signal?.addEventListener('abort', cancel, { once: true });
      try {
        let outcome: PromiseSettledResult<T>;
        try {
          assertRecipeActive(signal);
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
          const resolvedOptions: CliOptions = {
            target: context.target.value,
            runtimeDir: binding.runtimeDir,
            artifactsDir: path.join(binding.checkoutRoot, binding.artifactDir),
            ...(binding.manifest && !options.options?.actionManifest
              ? { actionManifest: binding.manifest }
              : {}),
          };
          const cli = { ...options.options, ...resolvedOptions };
          applyRuntimeDirOption(cli);
          let invocation: ParsedArgs | undefined;
          provider = await loadProjectProvider(context, {
            ...options,
            resolvedOptions,
            onParsedInvocation: (parsed) => {
              invocation = parsed;
              options.onParsedInvocation?.(parsed);
            },
          });
          if (signal?.aborted) cancel();
          assertRecipeActive(signal);
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
          const librarySources = await resolveLibrarySources(
            engine,
            undefined,
            undefined,
            libraries,
          );
          assertRecipeActive(signal);
          const boundProvider = provider;
          const commandOptions = {
            ...cli,
            ...invocation?.options,
            adapter: boundProvider.runtime.id,
          };
          const value = await withRecipeExecutionSignal(signal, () =>
            invoke({
              context,
              provider: boundProvider,
              engine,
              librarySources,
              cli: commandOptions,
              ...(invocation ? { invocation: { ...invocation, options: commandOptions } } : {}),
              signal,
              finalize,
            }),
          );
          outcome = { status: 'fulfilled', value };
        } catch (reason) {
          outcome = { status: 'rejected', reason };
        }
        try {
          await finalize();
        } catch (error) {
          if (outcome.status === 'rejected' && outcome.reason !== error) {
            throw aggregateFailures([outcome.reason, error]);
          }
          throw error;
        }
        if (outcome.status === 'rejected') throw outcome.reason;
        return outcome.value;
      } finally {
        signal?.removeEventListener('abort', cancel);
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
    };
    const finishOutput = options.deferOutput ? deferCommandOutput() : undefined;
    let succeeded = false;
    try {
      const result = await (executes
        ? withRecipeSignals(execute, options.signal)
        : execute(options.signal));
      succeeded = true;
      return result;
    } finally {
      finishOutput?.(succeeded);
    }
  });
}
