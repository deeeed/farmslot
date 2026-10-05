// The headless dependency check: a Node checkout can run recipes once Yarn
// installed it (PnP or node_modules), the tools its actions run are found, and the
// packages its live scripts import resolve from the checkout.

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import type { AdapterDependencyBlock } from '@farmslot/adapter-sdk';

const requireFromPackage = createRequire(import.meta.url);

/** Options for {@link nodeDependencyBlock}. */
export interface NodeDependencyOptions {
  /** Packages the checkout must resolve at runtime. Default: none. */
  runtimeDeps?: readonly string[];
  /** Executables the actions run (e.g. `tsx`). Default: none. */
  bins?: readonly string[];
  /**
   * Finds `bin` for the checkout, or returns null. Pass the resolver execution
   * uses, so the check and the run agree. Default: `<target>/node_modules/.bin/<bin>`.
   */
  resolveBin?(target: string, bin: string): string | null;
  /** Names the checkout in messages ("<label> dependencies are …"). Default: `node`. */
  label?: string;
  /** Code prefix: `<prefix>_DEPS_MISSING`, `<prefix>_DEPS_INCOMPLETE`. Default: the label, upper-cased. */
  codePrefix?: string;
  /** The block's next step. Default: {@link yarnInstallCommand}. */
  installCommand?(target: string): string;
}

/**
 * Why the checkout at `target` cannot run yet, or null when it can. Under Yarn PnP
 * the install marker `.pnp.cjs` is the whole check; otherwise node_modules, each
 * bin, then each runtime dependency.
 */
export function nodeDependencyBlock(
  target: string,
  options: NodeDependencyOptions = {},
): AdapterDependencyBlock | null {
  const resolved = path.resolve(target);
  const label = options.label ?? 'node';
  const prefix = options.codePrefix ?? label.toUpperCase().replace(/[^A-Z0-9]+/gu, '_');
  const missing = `${prefix}_DEPS_MISSING`;
  const incomplete = `${prefix}_DEPS_INCOMPLETE`;
  const userAction = (options.installCommand ?? yarnInstallCommand)(resolved);
  const nodeLinker = readYarnNodeLinker(resolved);

  if (nodeLinker === 'pnp') {
    if (fs.existsSync(path.join(resolved, '.pnp.cjs'))) return null;
    return {
      code: missing,
      message: `${label} dependencies are not installed for Yarn PnP (.pnp.cjs is missing).`,
      userAction,
    };
  }

  if (!fs.existsSync(path.join(resolved, 'node_modules'))) {
    return {
      code: missing,
      message:
        nodeLinker === 'node-modules'
          ? `${label} dependencies are not installed (nodeLinker requires node_modules, but node_modules is missing).`
          : `${label} dependencies are not installed (node_modules is missing).`,
      userAction,
    };
  }

  for (const bin of options.bins ?? []) {
    if (options.resolveBin ? options.resolveBin(resolved, bin) : localBin(resolved, bin)) continue;
    return {
      code: incomplete,
      message: options.resolveBin
        ? `${label} dependencies are incomplete (no ${bin} runtime found for the checkout).`
        : `${label} dependencies are incomplete (node_modules/.bin/${bin} is missing).`,
      userAction,
    };
  }

  for (const dependency of options.runtimeDeps ?? []) {
    if (!canResolveFromTarget(dependency, resolved)) {
      return {
        code: incomplete,
        message: `${label} dependencies are incomplete (cannot resolve ${dependency} from the target checkout).`,
        userAction,
      };
    }
  }

  return null;
}

/** `current` plus `--require <target>/.pnp.cjs` when the checkout is a Yarn PnP install. */
export function pnpNodeOptions(target: string, current: string | undefined): string | undefined {
  if (readYarnNodeLinker(target) !== 'pnp') return current;
  const pnp = path.join(path.resolve(target), '.pnp.cjs');
  if (!fs.existsSync(pnp)) return current;
  const pnpOption = `--require ${pnp}`;
  return current ? `${current} ${pnpOption}` : pnpOption;
}

/** `cd '<target>' && yarn install --immutable`. */
export function yarnInstallCommand(target: string): string {
  return `cd ${shellQuote(path.resolve(target))} && yarn install --immutable`;
}

function canResolveFromTarget(specifier: string, target: string): boolean {
  try {
    requireFromPackage.resolve(specifier, { paths: [target] });
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Not found from the checkout is the answer this check asks for.
    if (code === 'MODULE_NOT_FOUND') return false;
    // Installed, but its exports offer no require() entry (ESM-only): present.
    if (code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') return true;
    throw error;
  }
}

function localBin(target: string, bin: string): string | null {
  const file = path.join(target, 'node_modules/.bin', bin);
  return fs.existsSync(file) ? file : null;
}

function readYarnNodeLinker(target: string): string | undefined {
  const yarnrc = path.join(target, '.yarnrc.yml');
  if (!fs.existsSync(yarnrc)) return undefined;
  return /^nodeLinker:\s*["']?([^"'\s#]+)["']?/mu.exec(fs.readFileSync(yarnrc, 'utf8'))?.[1];
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}
