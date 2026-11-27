// Module resolution for a prebuilt CLI snapshot (build-prebuilt.mjs): the same graph TSX loads,
// with each in-tree .ts replaced by the .js built beside it.
// - `@farmslot/<package>[/<subpath>]` follows the CLI tsconfig's `paths`, as TSX does.
// - Any other specifier resolves as usual; a result that is an in-tree .ts(x) becomes its .js.
// A missing build of an in-tree .ts is an error naming it: the snapshot's build is incomplete.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** @type {{ root: string; paths: Array<{ pattern: string; target: string }>; commonjs: string[] }} */
let state;

export function initialize(data) {
  state = data;
}

function built(file) {
  if (!/\.tsx?$/.test(file)) return file;
  const js = file.replace(/\.tsx?$/, '.js');
  if (!existsSync(js)) throw new Error(`prebuilt CLI is missing ${js}; reinstall the CLI snapshot`);
  return js;
}

/**
 * The source a tsconfig `paths` target names, completed as TSX's resolver completes it, or
 * undefined when no such source exists: TSX then falls back to the package's own exports.
 */
export function complete(file) {
  const candidates = [file, `${file}.ts`, `${file}.tsx`, path.join(file, 'index.ts')];
  if (file.endsWith('.js')) candidates.unshift(file.replace(/\.js$/, '.ts'));
  return candidates.find((candidate) => /\.tsx?$/.test(candidate) && existsSync(candidate));
}

function mapped(specifier) {
  for (const { pattern, target } of state.paths) {
    if (pattern.endsWith('/*')) {
      const prefix = pattern.slice(0, -1);
      if (specifier.startsWith(prefix)) {
        const file = complete(target.replace('*', specifier.slice(prefix.length)));
        if (file) return file;
      }
    } else if (specifier === pattern && existsSync(target)) return target;
  }
  return undefined;
}

function prebuilt(specifier) {
  if (!specifier.startsWith('@farmslot/')) return undefined;
  const file = mapped(specifier);
  return file ? { url: pathToFileURL(built(file)).href, shortCircuit: true } : undefined;
}

/** The workspace package whose src/ holds `file`, when it does: only those sources are built. */
function sourcePackage(file) {
  const relative = path.relative(path.join(state.root, 'packages'), file);
  const [name, src] = relative.split(path.sep);
  return relative.startsWith('..') || src !== 'src' ? undefined : name;
}

function settled(result) {
  if (result.url.startsWith('file:')) {
    const file = fileURLToPath(result.url);
    // TypeScript anywhere else (migrations, package scripts, a project's files) is TSX's.
    if (/\.tsx?$/.test(file) && sourcePackage(file))
      return { ...result, url: pathToFileURL(built(file)).href };
  }
  return result;
}

/** In-thread resolve hook for `module.registerHooks`; `initialize` must run first. */
export function resolveSync(specifier, context, next) {
  return prebuilt(specifier) ?? settled(next(specifier, context));
}

/**
 * A prebuilt in-tree module is already plain JavaScript: hand Node its source, so TSX's own load
 * hook (still registered for TypeScript from outside the CLI) does not transform it again.
 */
function prebuiltSource(url) {
  if (!url.startsWith('file:') || !url.endsWith('.js')) return undefined;
  const file = fileURLToPath(url);
  const name = sourcePackage(file);
  const base = file.replace(/\.js$/, '');
  if (!name || !(existsSync(`${base}.ts`) || existsSync(`${base}.tsx`))) return undefined;
  return {
    format: state.commonjs.includes(name) ? 'commonjs' : 'module',
    source: readFileSync(file, 'utf8'),
    shortCircuit: true,
  };
}

/** In-thread load hook for `module.registerHooks`. */
export function loadSync(url, context, next) {
  return prebuiltSource(url) ?? next(url, context);
}
