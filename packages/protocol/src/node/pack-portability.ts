import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import path from 'node:path';

const PRIVATE_PATH =
  /(?:~|\$HOME|\$\{HOME\})\/xreview(?:\/|\b)|\/(?:Users|home)\/[^\s/]+|\/var\/root(?:\/|\b)|[A-Za-z]:[\\/]Users[\\/]/;
const MACHINE_NAME = /\b(?:macpro|macwork|mini)(?:\.local)?\b/i;

/** Pack admission and gateway sync use the same portability policy. */
export function validatePackFilePortability(file: string, content: string): string[] {
  return content.split(/\r?\n/).flatMap((line, index) => {
    const match = PRIVATE_PATH.exec(line) ?? MACHINE_NAME.exec(line);
    return match
      ? [
          `${file}:${index + 1}: nonportable reference ${JSON.stringify(match[0])}; use a relative pack path or a pool/slot {{placeholder}} for node-specific values`,
        ]
      : [];
  });
}

/** Scan pack-owned files, excluding Git-ignored runtime data and dependency trees. */
export function validatePackPortability(root: string, prefix = ''): string[] {
  const errors: string[] = [];
  const isGitPack = existsSync(path.join(root, '.git'));
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (name === '.git' || name === 'node_modules') continue;
      const full = path.join(dir, name);
      const relative = path.relative(root, full).replaceAll(path.sep, '/');
      if (isGitPack) {
        const ignored = spawnSync('git', ['-C', root, 'check-ignore', '--quiet', '--', relative]);
        if (ignored.status === 0) continue;
        if (ignored.status !== 1)
          throw new Error('Cannot determine pack-owned files for portability validation');
      }
      const stat = lstatSync(full);
      const file = prefix ? `${prefix}/${relative}` : relative;
      if (stat.isSymbolicLink()) {
        errors.push(...validatePackFilePortability(file, readlinkSync(full)));
      } else if (stat.isDirectory()) {
        walk(full);
      } else if (stat.isFile()) {
        const content = readFileSync(full);
        if (!content.includes(0))
          errors.push(...validatePackFilePortability(file, content.toString('utf8')));
      }
    }
  };
  walk(root);
  return errors;
}
