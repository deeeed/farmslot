// A headless Node platform: no app, ports, dev server, logs or launch. Installed
// dependencies are the only runtime signal, and lifecycle commands teach the
// headless path. The host supplies identity, detection, wording and its action
// set; product checks stay in the host.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  type AdapterActions,
  type AdapterDetect,
  type AdapterHarness,
  type AdapterHints,
  type AdapterRun,
  type AdapterRuntimeContextSpec,
  defineAdapter,
  type PlatformAdapter,
} from '@farmslot/adapter-sdk';
import { depsCheck } from '@farmslot/recipe-runner/runtime/deps-readiness';

import { nodeDependencyBlock, yarnInstallCommand } from './dependencies.js';
import { type WorkspacePackages, workspaceTsconfigEnv } from './workspace-tsconfig.js';

/** Absolute path of the shipped overlay cleanup leaf (`cleanup.sh --adapter <id>`). */
export const NODE_CLEANUP_SCRIPT = fileURLToPath(new URL('../scripts/cleanup.sh', import.meta.url));

/** Runtime-context fields a headless checkout never records: it has no ports or device. */
export const HEADLESS_FORBIDDEN_FIELDS: readonly string[] = [
  'cdpPort',
  'watcherPort',
  'metroPort',
  'devServerPort',
  'simulator',
  'simulatorUdid',
  'adbSerial',
  'extensionId',
];

/** A refusal a headless platform prints instead of acting. */
export interface NodeAdapterNotice {
  message: string;
  userAction: string;
}

/** Every line the adapter prints. Defaults name the adapter id and its `hints`. */
export interface NodeAdapterWording {
  /** `runtimeStatus` reason when dependencies are installed. */
  ready: string;
  /** `runtimeStatus` reason otherwise. */
  notReady: string;
  /** `devServer.stop`: there is no dev server. */
  devServerStop: NodeAdapterNotice;
  /** `launch`: there is nothing to launch. */
  launch: NodeAdapterNotice;
}

/** What a run or one action is about to use, as `run.dependencyBlock` receives it. */
export type NodeDependencyUse = Parameters<NonNullable<AdapterRun['dependencyBlock']>>[1];

/** The dependency check `run` and `call` apply before they start. */
export interface NodeAdapterDependencies {
  /** Packages the checkout must resolve at runtime. Default: none. */
  runtimeDeps?: readonly string[];
  /** Executables the actions run (e.g. `tsx`). Default: none. */
  bins?: readonly string[];
  /** Finds a bin for the checkout; pass the resolver execution uses. Default: `<target>/node_modules/.bin`. */
  resolveBin?(target: string, bin: string): string | null;
  /** Next step when a bin cannot be found. Default: the install command. */
  missingBinAction?(target: string, bin: string): string;
  /** Whether this run or action needs the checkout's dependencies. Default: always. */
  requiredFor?(target: string, use: NodeDependencyUse): boolean | Promise<boolean>;
}

export interface NodeAdapterConfig {
  /** Registry key and the value of `--adapter`. */
  id: string;
  hints: AdapterHints;
  actions: AdapterActions;
  harness: AdapterHarness;
  detect?: AdapterDetect;
  /** Host run members. A host `dependencyBlock` replaces the built-in check. */
  run?: AdapterRun;
  wording?: Partial<NodeAdapterWording>;
  dependencies?: NodeAdapterDependencies;
  /**
   * Workspace packages live adapter scripts import from src: a map, or
   * `checkoutWorkspacePackages` to take every package the checkout declares.
   * When set and `actions.tsxLiveScripts` is absent, scripts run under tsx with
   * `workspaceTsconfigEnv` (`<id>-adapter.tsconfig.json`).
   */
  workspacePackages?: WorkspacePackages;
  /** Next step when dependencies are missing. Default: `yarnInstallCommand`. */
  installCommand?(target: string): string;
  /** Default: `HEADLESS_FORBIDDEN_FIELDS`. */
  runtimeContext?: AdapterRuntimeContextSpec;
}

/** A headless `PlatformAdapter`; spread it to add host members. */
export function createNodeAdapter(config: NodeAdapterConfig): PlatformAdapter {
  const { id, hints } = config;
  const installCommand = config.installCommand ?? yarnInstallCommand;
  const wording: NodeAdapterWording = {
    ready: `${id} is headless; dependencies are installed.`,
    notReady: `${id} is headless; dependencies are not fully installed.`,
    devServerStop: {
      message: `${id} is headless; no dev server runs for a ${id} checkout`,
      userAction: hints.relaunch,
    },
    launch: {
      message: `${id} is headless; there is nothing to launch.`,
      userAction: hints.relaunch,
    },
    ...config.wording,
  };
  const dependencies = config.dependencies ?? {};
  const dependencyBlockFor = (target: string) =>
    nodeDependencyBlock(target, {
      runtimeDeps: dependencies.runtimeDeps,
      bins: dependencies.bins,
      resolveBin: dependencies.resolveBin,
      missingBinAction: dependencies.missingBinAction,
      label: id,
      installCommand,
    });
  const workspacePackages = config.workspacePackages;

  return defineAdapter<PlatformAdapter>({
    id,
    sdkVersion: 1,
    headless: true,

    resolveSlotPorts(): void {
      // Headless: no ports or device to resolve.
    },

    async runtimeStatus(target) {
      const deps = depsCheck(path.resolve(target));
      if (deps.status !== 'current') {
        return {
          decision: 'install',
          reasonCode: `deps-${deps.status}`,
          reasons: [wording.notReady],
          nextAction: installCommand(target),
          deps: deps.status,
        };
      }
      // Installed is not enough: the actions must find their runtime too, so
      // doctor and verify report what run and call would refuse.
      const block = dependencyBlockFor(target);
      if (block) {
        return {
          decision: 'install',
          reasonCode: 'deps-incomplete',
          reasons: [wording.notReady, block.message],
          nextAction: block.userAction,
          deps: deps.status,
        };
      }
      return {
        decision: 'ready',
        reasonCode: 'deps-present',
        reasons: [wording.ready],
        nextAction: undefined,
        deps: deps.status,
      };
    },

    devServer: {
      label: 'dev-server',
      describe: () => 'no dev server (headless)',
      stop: () => ({ kind: 'headless', ...wording.devServerStop }),
    },

    logSources: () => [],
    appLogSource: () => null,

    hints,
    detect: config.detect,

    launch: async ({ usage }) => usage(wording.launch.message, wording.launch.userAction),

    actions:
      workspacePackages && !config.actions.tsxLiveScripts
        ? {
            ...config.actions,
            tsxLiveScripts: {
              env: (projectRoot, tempDir) =>
                workspaceTsconfigEnv(projectRoot, tempDir, {
                  packages: workspacePackages,
                  fileName: `${id}-adapter.tsconfig.json`,
                }),
            },
          }
        : config.actions,

    harness: config.harness,
    runtimeContext: config.runtimeContext ?? { forbiddenFields: HEADLESS_FORBIDDEN_FIELDS },

    run: {
      async dependencyBlock(target, use) {
        const required = dependencies.requiredFor
          ? await dependencies.requiredFor(target, use)
          : true;
        if (!required) return null;
        return dependencyBlockFor(target);
      },
      ...config.run,
    },
  });
}
