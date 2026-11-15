#!/usr/bin/env node
// Transpile the installed CLI's TypeScript to JavaScript once, at install time, so each call
// starts without TSX transforming every module (about 80% of a call's CPU before).
//   node packages/cli/bin/build-prebuilt.mjs <revision>
//
// Every workspace package's src/**/*.ts(x) gets a sibling .js, with the compiler options TSX
// applies to the CLI (TSX_TSCONFIG_PATH is the CLI's tsconfig). Files stay where they are, so
// code that resolves paths from its own location keeps working. A source directory that
// already holds a .js of the same name is refused, never overwritten. PREBUILT.json is written
// last: the launcher uses the build only when it names this snapshot's deployed revision.
//
// Run only in an immutable CLI snapshot (scripts/lib/node-cli-refresh.sh), never in a
// checkout whose sources change: the build is not kept in step with edits.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const revision = process.argv[2];
if (!revision) {
  console.error('usage: build-prebuilt.mjs <revision>');
  process.exit(2);
}
const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(cli, '../..');
if (existsSync(path.join(root, '.git')))
  throw new Error(`refusing to prebuild ${root}: it is a git checkout, whose sources change`);
const esbuild = createRequire(path.join(cli, 'package.json'))('esbuild');

/** The CLI tsconfig's compiler options with everything it extends merged in, as TSX reads them. */
function compilerOptions(file) {
  const config = JSON.parse(readFileSync(file, 'utf8'));
  const base = config.extends
    ? compilerOptions(path.resolve(path.dirname(file), config.extends))
    : {};
  return { ...base, ...config.compilerOptions };
}
const options = compilerOptions(path.join(cli, 'tsconfig.json'));
const tsconfigRaw = {
  compilerOptions: {
    experimentalDecorators: options.experimentalDecorators,
    useDefineForClassFields: options.useDefineForClassFields,
    verbatimModuleSyntax: options.verbatimModuleSyntax,
    jsx: options.jsx,
    jsxImportSource: options.jsxImportSource,
  },
};

function sources(directory) {
  const found = [];
  for (const name of readdirSync(directory)) {
    const file = path.join(directory, name);
    if (statSync(file).isDirectory()) found.push(...sources(file));
    else if (/\.tsx?$/.test(name) && !name.endsWith('.d.ts') && !/\.test\.tsx?$/.test(name))
      found.push(file);
  }
  return found;
}

const packages = path.join(root, 'packages');
let count = 0;
for (const name of readdirSync(packages).sort()) {
  const src = path.join(packages, name, 'src');
  const manifest = path.join(packages, name, 'package.json');
  if (!existsSync(src) || !existsSync(manifest)) continue;
  const format = JSON.parse(readFileSync(manifest, 'utf8')).type === 'module' ? 'esm' : 'cjs';
  for (const file of sources(src)) {
    const out = file.replace(/\.tsx?$/, '.js');
    if (existsSync(out))
      throw new Error(`refusing to overwrite ${out}: a source file has that name`);
    const { code } = esbuild.transformSync(readFileSync(file, 'utf8'), {
      loader: file.endsWith('.tsx') ? 'tsx' : 'ts',
      format,
      target: 'node22',
      sourcefile: file,
      tsconfigRaw,
    });
    writeFileSync(out, code);
    count++;
  }
}
writeFileSync(
  path.join(cli, 'PREBUILT.json'),
  `${JSON.stringify({ revision, files: count }, null, 2)}\n`,
);
console.log(`prebuilt ${count} modules for ${revision}`);
