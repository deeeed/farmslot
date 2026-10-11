// Live adapter scripts: the library action implementation (`<root>/<platform>/
// <family>/<name>.mjs`) a recipe action runs as a child process. The script
// reads its input from the file in `<recipeEnvPrefix>_ADAPTER_INPUT` (also
// argv[2]) and writes JSON to the `outputPath` it names. A prepared script is
// bundled once so the approved bytes are the ones that run.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { access, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { Plugin, PluginBuild } from 'esbuild';

import type { ActionExecutionContext } from '@farmslot/recipe-runner';
import { runOwnedRecipeProcess } from '@farmslot/recipe-runner/adapters/core';

import { harnessAdapter, harnessAdapters } from './adapters.js';
import { trackCheckoutChild } from './checkout-lock.js';
import { recordCommandOutput } from './command-journal.js';
import { harnessHost, recipeEnvName } from './host.js';

function actionFileStem(action: string) {
  return String(action).replace(/[^a-zA-Z0-9._-]/g, '_');
}

// `<namespace>.<family>.<name>` and `<family>.<name>` resolve the same files.
function actionParts(action: string, namespace: string) {
  const parts = String(action).split('.').filter(Boolean);
  if (parts.length >= 3 && parts[0] === namespace) {
    return { family: parts[1], localName: parts.slice(2).join('.') };
  }
  if (parts.length >= 2) {
    return { family: parts[0], localName: parts.slice(1).join('.') };
  }
  return { family: 'actions', localName: String(action) };
}

function candidateStems(action: string, namespace: string) {
  const stem = actionFileStem(action);
  const { localName } = actionParts(action, namespace);
  const localStem = actionFileStem(localName);
  const stems = [stem];
  if (localStem && localStem !== stem) stems.push(localStem);
  return stems;
}

function candidateFamilies(action: string, namespace: string) {
  const { family } = actionParts(action, namespace);
  const families = [family];
  return [...new Set(families)];
}

/** The live script files tried for `action`, in order; the first that exists runs. */
export function candidatePaths(
  platform: string,
  action: string,
  namespace: string,
  runtimeEnv: NodeJS.ProcessEnv = process.env,
) {
  const stems = candidateStems(action, namespace);
  const families = candidateFamilies(action, namespace);
  const sourceMap = recipeEnvName('ACTION_SOURCE_MAP');
  const liveAdapterDir = recipeEnvName('LIVE_ADAPTER_DIR');
  const declaredRoot = declaredActionRoot(runtimeEnv[sourceMap] ?? process.env[sourceMap], action);
  // Without a declared root: the live adapter directory, then the host's
  // bundled library.
  const roots = [
    ...new Set(
      (declaredRoot
        ? [declaredRoot]
        : [
            runtimeEnv[liveAdapterDir] ?? process.env[liveAdapterDir],
            path.join(harnessHost().packageRoot, 'library/actions'),
          ]
      ).filter((entry): entry is string => Boolean(entry)),
    ),
  ];
  // A child's every file (each stem, then its dispatcher) comes before its
  // ancestor's. The adapter at the top of the chain keeps the order a built-in
  // has always had: each stem, then the shared one, then the dispatchers.
  const chain = platformChain(platform);
  const descendants = chain.slice(0, -1);
  const base = chain.at(-1)!;
  const files: string[] = [];
  for (const root of roots) {
    for (const family of families) {
      for (const descendant of descendants) {
        for (const candidateStem of stems) {
          files.push(path.join(root, descendant, family, `${candidateStem}.mjs`));
        }
        files.push(path.join(root, descendant, family, `${family}.mjs`));
      }
      for (const candidateStem of stems) {
        pushCandidateFiles(files, root, base, family, candidateStem);
      }
      pushDomainDispatcherFiles(files, root, base, family);
    }
  }
  return files;
}

/**
 * `platform`, then each adapter up its `extends` chain (a library plugin's
 * composed adapter carries its parent's id), so a child adapter runs its
 * parent's live scripts unless it has its own. A built-in extends nothing.
 */
function platformChain(platform: string): string[] {
  const registry = harnessAdapters();
  const chain = [platform];
  let current = registry.has(platform) ? registry.get(platform).extends : undefined;
  while (current !== undefined && !chain.includes(current)) {
    chain.push(current);
    current = registry.has(current) ? registry.get(current).extends : undefined;
  }
  return chain;
}

function declaredActionRoot(raw: string | undefined, action: string): string | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    const root =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed[action] : undefined;
    return typeof root === 'string' && root.length > 0 ? root : undefined;
  } catch {
    return undefined;
  }
}

function pushCandidateFiles(
  files: string[],
  root: string,
  platform: string,
  family: string,
  stem: string,
) {
  files.push(path.join(root, platform, family, `${stem}.mjs`));
  files.push(path.join(root, 'shared', family, `${stem}.mjs`));
}

function pushDomainDispatcherFiles(
  files: string[],
  root: string,
  platform: string,
  family: string,
) {
  files.push(path.join(root, platform, family, `${family}.mjs`));
  files.push(path.join(root, 'shared', family, `${family}.mjs`));
}

async function firstExecutablePath(paths: string[]) {
  for (const file of paths) {
    try {
      await access(file);
      return file;
    } catch (error) {
      // Try the next candidate path. Missing optional live adapters are reported by the caller.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return null;
}

export interface PreparedLiveAdapter {
  action: string;
  platform: string;
  entryPath: string;
  sourceDigest: string;
  sourceText: string;
}

export async function prepareLiveAdapterScript({
  platform,
  action,
  namespace,
  implementationRoot,
  allowRuntimeImports = false,
}: {
  platform: string;
  action: string;
  // The library namespace an action name may start with (`<namespace>.family.name`).
  namespace: string;
  implementationRoot: string;
  allowRuntimeImports?: boolean;
}): Promise<PreparedLiveAdapter | null> {
  const entryPath = await firstExecutablePath(
    candidatePaths(platform, action, namespace, {
      [recipeEnvName('ACTION_SOURCE_MAP')]: JSON.stringify({ [action]: implementationRoot }),
    }),
  );
  if (!entryPath) return null;
  const rootReal = await realpath(implementationRoot);
  const entryReal = await realpath(entryPath);
  if (!isPathWithin(rootReal, entryReal)) {
    throw new Error(`Live adapter ${entryPath} resolves outside ${implementationRoot}.`);
  }
  // Loaded on first use: every harness command imports this module.
  const { build } = await import('esbuild');
  const result = await build({
    entryPoints: [entryReal],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    target: `node${process.versions.node.split('.')[0]}`,
    legalComments: 'none',
    sourcemap: false,
    banner: {
      // The banner is part of the approved bundle's digest: keep its bytes.
      js:
        `import { createRequire as __mmCreateRequire } from 'node:module';` +
        `const require = __mmCreateRequire(import.meta.url);` +
        `process.argv[1] = ${JSON.stringify(entryReal)};`,
    },
    plugins: [bindImportMetaUrls()],
    logLevel: 'silent',
  });
  const output = result.outputFiles[0];
  if (!output) throw new Error(`Bundling live adapter ${entryReal} produced no executable output.`);
  const sourceText = output.text;
  const { init, parse } = await import('es-module-lexer');
  await init;
  const [imports] = parse(sourceText);
  if (!allowRuntimeImports && imports.some((entry) => entry.d >= 0)) {
    const error = new Error(
      `Live adapter ${entryReal} contains a runtime dynamic import that cannot be bound to the approved bundle. ` +
        'Replace it with a static import so its implementation bytes are included in the plan digest.',
    );
    Object.assign(error, {
      code: 'RECIPE_TRUST_UNBOUND_IMPORT',
      userAction:
        'replace the computed import with a static import, or promote the adapter into an explicitly trusted engineer-owned library',
    });
    throw error;
  }
  return {
    action,
    platform,
    entryPath: entryReal,
    sourceText,
    sourceDigest: `sha256:${createHash('sha256').update(sourceText).digest('hex')}`,
  };
}

function bindImportMetaUrls(): Plugin {
  return {
    name: 'bind-import-meta-urls',
    setup(buildContext: PluginBuild) {
      buildContext.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async (args) => {
        const contents = await readFile(args.path, 'utf8');
        if (!contents.includes('import.meta.url')) return undefined;
        const extension = path.extname(args.path);
        const loader =
          extension === '.ts' || extension === '.mts' || extension === '.cts'
            ? 'ts'
            : extension === '.tsx'
              ? 'tsx'
              : extension === '.jsx'
                ? 'jsx'
                : 'js';
        return {
          contents: contents.replaceAll(
            'import.meta.url',
            JSON.stringify(pathToFileURL(args.path).href),
          ),
          loader,
        };
      });
    },
  };
}

// The platform's tsx contract for its live adapter scripts, if it has one.
function tsxLiveScripts(platform: string | undefined) {
  return platform && harnessAdapters().has(platform)
    ? harnessAdapter(platform).actions.tsxLiveScripts
    : undefined;
}

function commandFor(
  file: string,
  tsxCandidates: readonly string[],
  projectRoot?: string,
  platform?: string,
) {
  // A platform with tsxLiveScripts has actions that dynamically import the
  // checkout's TypeScript (a computed import() static analysis cannot see), so
  // they MUST run under tsx even though importsSourceTypescript is false —
  // otherwise bare node throws ERR_MODULE_NOT_FOUND on an unbuilt checkout's
  // extensionless src imports.
  const needsTsx = Boolean(tsxLiveScripts(platform)) || importsSourceTypescript(file);
  if (!needsTsx) {
    return { command: process.execPath, args: [file] };
  }
  const tsxBin = resolveTsxBin(tsxCandidates, projectRoot);
  if (!tsxBin) {
    const where = projectRoot ?? 'the checkout';
    const error = new Error(
      `this action runs TypeScript from the checkout but no tsx runtime was found.\n` +
        `  Next: run 'yarn install' in ${where} (tsx is a dev dependency of the checkout); ` +
        `if package imports still fail, run 'yarn build' there`,
    );
    (error as Error & { exitCode: number }).exitCode = 2;
    throw error;
  }
  return { command: tsxBin, args: [file] };
}

/**
 * The tsx a live adapter script runs under, or null. Exported so a readiness
 * check asks the same question execution does. Order: the `TSX_BIN` seam, the
 * target checkout's own tsx (a thin-installed slot has it; a published host
 * need not ship one), the host package's tsx, then the caller's candidates.
 */
export function resolveTsxBin(
  tsxCandidates: readonly string[],
  projectRoot?: string,
): string | null {
  if (process.env.TSX_BIN) return process.env.TSX_BIN;
  const candidates: string[] = [];
  if (projectRoot) candidates.push(path.join(projectRoot, 'node_modules/.bin/tsx'));
  candidates.push(path.join(harnessHost().packageRoot, 'node_modules/.bin/tsx'));
  candidates.push(...tsxCandidates);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function importsSourceTypescript(file: string): boolean {
  return importsSourceTypescriptFrom(file, new Set());
}

function importsSourceTypescriptFrom(file: string, visited: Set<string>): boolean {
  const absolute = path.resolve(file);
  if (visited.has(absolute)) return false;
  visited.add(absolute);
  const source = readFileSync(file, 'utf8');
  const importPattern = /(?:from\s+|import\(\s*)['"]([^'"]+)['"]/gu;
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1] ?? '';
    if (specifier.endsWith('.ts')) return true;
    if (!specifier.startsWith('.')) continue;
    if (!specifier.endsWith('.mjs')) continue;
    if (importsSourceTypescriptFrom(path.resolve(path.dirname(absolute), specifier), visited)) {
      return true;
    }
  }
  return false;
}

export async function resolveLiveAdapter(
  platform: string,
  action: string,
  namespace: string,
  runtimeEnv?: NodeJS.ProcessEnv,
) {
  return firstExecutablePath(candidatePaths(platform, action, namespace, runtimeEnv));
}

export interface LiveAdapterRun {
  platform: string;
  action: string;
  // The library namespace an action name may start with (`<namespace>.family.name`).
  namespace: string;
  node: Record<string, unknown>;
  context: Pick<
    ActionExecutionContext,
    'nodeId' | 'projectRoot' | 'artifactsDir' | 'env' | 'registerArtifact' | 'signal'
  >;
  prepared?: PreparedLiveAdapter;
  // Fields the script's input context carries after nodeId, projectRoot and artifactsDir.
  contextExtras?: Record<string, unknown>;
  // More tsx binaries to try after the checkout's and the host package's.
  tsxCandidates?: readonly string[];
}

export async function runLiveAdapterScript({
  platform,
  action,
  namespace,
  node,
  context,
  prepared,
  contextExtras,
  tsxCandidates = [],
}: LiveAdapterRun): Promise<{ script: string; result: unknown } | null> {
  const script =
    prepared?.entryPath ?? (await resolveLiveAdapter(platform, action, namespace, context.env));
  if (!script) return null;

  const tempDir = await mkdtemp(path.join(os.tmpdir(), `${harnessHost().name}-live-adapter-`));
  try {
    const inputPath = path.join(tempDir, 'input.json');
    const outputPath = path.join(tempDir, 'output.json');
    const input = {
      schemaVersion: 1,
      platform,
      action,
      node,
      context: {
        nodeId: context.nodeId,
        projectRoot: context.projectRoot,
        artifactsDir: context.artifactsDir,
        ...contextExtras,
      },
      outputPath,
    };
    await writeFile(inputPath, `${JSON.stringify(input, null, 2)}\n`);
    const command = prepared
      ? commandForPrepared(context.projectRoot, platform, tsxCandidates)
      : commandFor(script, tsxCandidates, context.projectRoot, platform);
    const platformEnv = (await tsxLiveScripts(platform)?.env(context.projectRoot, tempDir)) ?? {};
    const processTimeoutMs = liveAdapterProcessTimeoutMs(node);
    const result = await runOwnedRecipeProcess(command.command, [...command.args, inputPath], {
      cwd: context.projectRoot,
      env: {
        ...process.env,
        ...context.env,
        ...platformEnv,
        [recipeEnvName('ADAPTER_INPUT')]: inputPath,
        [recipeEnvName('ADAPTER_OUTPUT')]: outputPath,
      },
      timeoutMs: processTimeoutMs,
      signal: context.signal,
      ownProcessGroup: context.signal !== undefined,
      onSpawn: (pid, ownsGroup) => trackCheckoutChild(context.projectRoot, pid, ownsGroup),
      onOutput: (chunk) => recordCommandOutput(chunk),
      ...(prepared ? { input: prepared.sourceText } : {}),
    });
    if (result.timedOut) {
      throw new Error(`Live adapter ${script} timed out after ${processTimeoutMs}ms.`);
    }
    if (result.exitCode !== 0) {
      // Failed adapters may publish diagnostics before exiting; missing or partial output is optional.
      const failureOutput = await readFile(outputPath, 'utf8')
        .then(JSON.parse)
        .catch(() => null);
      if (Array.isArray(failureOutput?.artifacts)) {
        for (const artifact of failureOutput.artifacts) context.registerArtifact(artifact);
      }
      throw new Error(
        `Live adapter ${script} exited ${result.exitCode}: ${result.stderr || result.stdout}`,
      );
    }
    let parsed = null;
    try {
      parsed = JSON.parse(await readFile(outputPath, 'utf8'));
    } catch (_error) {
      const stdout = result.stdout.trim();
      if (!stdout) throw new Error(`Live adapter ${script} did not write JSON output.`);
      parsed = JSON.parse(stdout);
    }
    return { script, result: parsed };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export function liveAdapterProcessTimeoutMs(node: Record<string, unknown>): number {
  if (node.live_adapter_timeout_ms != null) {
    const timeoutMs = Number(node.live_adapter_timeout_ms);
    return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 60000;
  }
  const settleMs = Number(node.settle_ms);
  const settleAllowance = Number.isFinite(settleMs) && settleMs > 0 ? settleMs : 0;
  const actionTimeouts = [
    node.target_timeout_ms,
    node.unlock_timeout_ms,
    node.timeout_ms,
    node.wait_timeout_ms,
  ]
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0);
  if (actionTimeouts.length > 0) {
    return Math.max(
      60000,
      actionTimeouts.reduce((total, value) => total + value, 0) + settleAllowance + 5000,
    );
  }
  return 60000 + settleAllowance;
}

function commandForPrepared(
  projectRoot: string,
  platform: string,
  tsxCandidates: readonly string[],
) {
  if (!tsxLiveScripts(platform)) {
    return { command: process.execPath, args: ['--input-type=module', '-'] };
  }
  const tsxBin = resolveTsxBin(tsxCandidates, projectRoot);
  if (!tsxBin) {
    const error = new Error(
      `this action imports TypeScript from the checkout but no tsx runtime was found.\n` +
        `  Next: run 'yarn install' in ${projectRoot}`,
    );
    (error as Error & { exitCode: number }).exitCode = 2;
    throw error;
  }
  return { command: tsxBin, args: ['--input-type=module', '-'] };
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}
