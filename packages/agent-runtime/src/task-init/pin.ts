import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { TaskRetainedInput } from './execution-provenance.js';

const ignored = new Set(['.git', '.omc', '.omx']);

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
): TaskRetainedInput {
  source = fs.realpathSync(source);
  destination = path.resolve(destination);
  if (destination === source) throw new Error('A retained input cannot replace its source.');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'farmslot-task-pin-'));
  const copy = path.join(staging, 'input');
  try {
    fs.cpSync(source, copy, {
      recursive: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
      mode: fs.constants.COPYFILE_FICLONE,
      filter: (file) =>
        !ignored.has(path.basename(file)) &&
        !excluded.some((root) => file === root || file.startsWith(`${root}${path.sep}`)),
    });
    const relink = (file: string): void => {
      const stat = fs.lstatSync(file);
      if (stat.isDirectory()) {
        for (const name of fs.readdirSync(file)) relink(path.join(file, name));
      } else if (stat.isSymbolicLink()) {
        const target = fs.realpathSync(file);
        if (target !== copy && !target.startsWith(`${copy}${path.sep}`)) {
          if (target !== source && !target.startsWith(`${source}${path.sep}`)) {
            throw new Error(`Task input has a dependency outside its installation: ${file}`);
          }
          fs.unlinkSync(file);
          fs.symlinkSync(
            path.relative(path.dirname(file), path.join(copy, path.relative(source, target))) ||
              '.',
            file,
          );
        }
      }
    };
    relink(copy);
    const sha256 = taskInputDigest(copy);
    fs.renameSync(copy, destination);
    return { source, path: destination, sha256 };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}
