import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isRecord } from '@farmslot/protocol';

import type { TaskRetainedInput } from './execution-provenance.js';

const ignored = new Set(['.git', '.omc', '.omx']);
const workspaceIgnored = new Set([
  'node_modules',
  '.cache',
  '.expo',
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  '.DS_Store',
  'coverage',
]);

interface InputRetentionOptions {
  dependencies?: boolean;
  onDependency?: (input: TaskRetainedInput) => void;
}

/** Content and executable modes, including installed dependencies and link targets. */
export function taskInputDigest(root: string): string {
  const hash = createHash('sha256');
  const walk = (file: string, relative: string): void => {
    const stat = fs.lstatSync(file);
    if (stat.isDirectory()) {
      hash.update(`d\0${relative}\0`);
      for (const name of fs.readdirSync(file).sort()) {
        if (!ignored.has(name)) walk(path.join(file, name), path.join(relative, name));
      }
    } else if (stat.isSymbolicLink()) {
      hash.update(`l\0${relative}\0${fs.readlinkSync(file)}\0`);
    } else if (stat.isFile()) {
      hash.update(`f\0${relative}\0${stat.mode & 0o111}\0${stat.size}\0`);
      hash.update(fs.readFileSync(file));
      hash.update('\0');
    } else throw new Error(`Unsupported task input: ${file}`);
  };
  walk(root, '');
  return hash.digest('hex');
}

/** Generalized task-local pinning; never installs packages or changes a global pointer. */
export function retainTaskInput(
  source: string,
  destination: string,
  excluded: readonly string[] = [],
  options: InputRetentionOptions = {},
): TaskRetainedInput {
  source = fs.realpathSync(source);
  destination = path.resolve(destination);
  if (destination === source) throw new Error('A retained input cannot replace its source.');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const staging = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'farmslot-task-pin-')));
  const copy = path.join(staging, 'input');
  try {
    const mappings = new Map<string, string>();
    const links: Array<{ original: string; retained: string }> = [];
    const within = (root: string, file: string) =>
      file === root || file.startsWith(`${root}${path.sep}`);
    const copySource = (original: string, retained: string): void => {
      let selectedFiles: string[] | undefined;
      if (
        options.dependencies &&
        original === source &&
        !original.split(path.sep).includes('node_modules')
      ) {
        const manifest: unknown = JSON.parse(
          fs.readFileSync(path.join(original, 'package.json'), 'utf8'),
        );
        if (isRecord(manifest) && manifest.files !== undefined) {
          if (
            !Array.isArray(manifest.files) ||
            !manifest.files.every(
              (entry) =>
                typeof entry === 'string' &&
                !path.isAbsolute(entry) &&
                !entry.split('/').includes('..'),
            )
          )
            throw new Error('Tooling workspace files must be contained relative paths.');
          selectedFiles = [
            ...fs.globSync([...manifest.files, 'package.json'], {
              cwd: original,
              exclude: ['**/node_modules', '**/.git'],
            }),
          ];
        }
      }
      mappings.set(original, retained);
      fs.cpSync(original, retained, {
        recursive: true,
        preserveTimestamps: true,
        verbatimSymlinks: true,
        mode: fs.constants.COPYFILE_FICLONE,
        filter: (file) => {
          const name = path.basename(file);
          const relative = path.relative(original, file);
          if (
            selectedFiles &&
            relative &&
            !selectedFiles.some(
              (selected) =>
                relative === selected ||
                relative.startsWith(`${selected}${path.sep}`) ||
                selected.startsWith(`${relative}${path.sep}`),
            )
          )
            return false;

          return (
            !ignored.has(name) &&
            name !== '.npmrc' &&
            name !== '.env' &&
            !(name.startsWith('.env.') && !['.env.example', '.env.template'].includes(name)) &&
            !(
              options.dependencies &&
              file !== original &&
              (workspaceIgnored.has(name) || name === '.env' || name.startsWith('.env.'))
            ) &&
            !excluded.some((root) => within(root, file))
          );
        },
      });
      const visit = (file: string): void => {
        const stat = fs.lstatSync(file);
        if (stat.isDirectory())
          for (const name of fs.readdirSync(file)) visit(path.join(file, name));
        else if (stat.isSymbolicLink())
          links.push({
            original: path.join(original, path.relative(retained, file)),
            retained: file,
          });
      };
      visit(retained);
    };
    copySource(source, copy);
    const resolveDependency = (owner: string, name: string): string | undefined => {
      let directory = owner;
      for (;;) {
        const candidate = path.join(directory, 'node_modules', name);
        if (fs.existsSync(path.join(candidate, 'package.json'))) return fs.realpathSync(candidate);
        const parent = path.dirname(directory);
        if (parent === directory) return undefined;
        directory = parent;
      }
    };
    const retainDependencies = (original: string, retained: string, root = false): void => {
      const manifest: unknown = JSON.parse(
        fs.readFileSync(path.join(original, 'package.json'), 'utf8'),
      );
      if (!isRecord(manifest)) throw new Error(`Invalid dependency manifest: ${original}`);
      const fields =
        root && !original.split(path.sep).includes('node_modules')
          ? ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']
          : ['dependencies', 'optionalDependencies', 'peerDependencies'];
      const dependencies = new Map<string, boolean>();
      for (const field of fields) {
        const declared = manifest[field];
        if (declared === undefined) continue;
        if (!isRecord(declared)) throw new Error(`Invalid ${field}: ${original}`);
        for (const [name, version] of Object.entries(declared)) {
          if (typeof version !== 'string' || !/^(?:@[^/]+\/)?[^/@.][^/]*$/.test(name))
            throw new Error(`Invalid dependency declaration: ${name}`);
          const peerMeta = isRecord(manifest.peerDependenciesMeta)
            ? manifest.peerDependenciesMeta[name]
            : undefined;
          const optionalPeer =
            field === 'peerDependencies' && isRecord(peerMeta) && peerMeta.optional === true;
          dependencies.set(name, field === 'optionalDependencies' || optionalPeer);
        }
      }
      for (const [name, optional] of dependencies) {
        const dependency = resolveDependency(original, name);
        if (!dependency) {
          if (optional) continue;
          throw new Error(`Declared task dependency ${name} is not installed for ${original}.`);
        }
        const destination = path.join(retained, 'node_modules', name);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        const existing = mappings.get(dependency);
        if (existing)
          fs.symlinkSync(path.relative(path.dirname(destination), existing) || '.', destination);
        else {
          copySource(dependency, destination);
          retainDependencies(dependency, destination);
        }
        const dependencyManifest: unknown = JSON.parse(
          fs.readFileSync(path.join(dependency, 'package.json'), 'utf8'),
        );
        if (!isRecord(dependencyManifest))
          throw new Error(`Invalid dependency manifest: ${dependency}`);
        const bins =
          typeof dependencyManifest.bin === 'string'
            ? { [name.split('/').at(-1)!]: dependencyManifest.bin }
            : dependencyManifest.bin;
        if (isRecord(bins))
          for (const [bin, entry] of Object.entries(bins)) {
            if (typeof entry !== 'string' || bin.includes('/') || bin === '..')
              throw new Error(`Invalid dependency binary: ${bin}`);
            const target = path.resolve(destination, entry);
            if (!within(destination, target))
              throw new Error(`Dependency binary escapes its package: ${bin}`);
            const link = path.join(retained, 'node_modules', '.bin', bin);
            fs.mkdirSync(path.dirname(link), { recursive: true });
            if (!fs.existsSync(link))
              fs.symlinkSync(path.relative(path.dirname(link), target), link);
          }
      }
    };
    if (options.dependencies) retainDependencies(source, copy, true);
    for (const link of links) {
      const target = fs.realpathSync(link.original);
      const selected = [...mappings]
        .filter(([root]) => within(root, target))
        .sort(([a], [b]) => b.length - a.length)[0];
      if (!selected)
        throw new Error(`Task input has a dependency outside its installation: ${link.original}`);
      const mapped = path.join(selected[1], path.relative(selected[0], target));
      if (!fs.existsSync(mapped))
        throw new Error(`Task input dependency was excluded: ${link.original}`);
      fs.unlinkSync(link.retained);
      fs.symlinkSync(path.relative(path.dirname(link.retained), mapped) || '.', link.retained);
    }
    const sha256 = taskInputDigest(copy);
    fs.renameSync(copy, destination);
    for (const [original, retained] of mappings) {
      if (original === source) continue;
      const file = path.join(destination, path.relative(copy, retained));
      options.onDependency?.({ source: original, path: file, sha256: taskInputDigest(file) });
    }
    return { source, path: destination, sha256 };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}
