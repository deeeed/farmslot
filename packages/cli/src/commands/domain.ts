import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { Command } from 'commander';

import { dim } from '../colors.js';
import { repoRoot, resolveWorkspace } from '../onboarding/workspace.js';
import { OutputContext } from '../output.js';

const RESERVED_DOMAIN_DIR = '_template';

/**
 * Domains registered across configured projects: every `domains/<name>/`
 * directory under a project's fixtures, excluding the reserved `_template`
 * starter. This is the single source of discovery for the CLI, the
 * installer, and any future dispatch domain picker.
 */
export function listDomains(projectsRoot: string): string[] {
  const names = new Set<string>();
  if (!existsSync(projectsRoot)) return [];
  for (const project of readdirSync(projectsRoot, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    if (!existsSync(join(projectsRoot, project.name, 'project.json'))) continue;
    const domainsDir = join(projectsRoot, project.name, 'fixtures', 'domains');
    if (!existsSync(domainsDir)) continue;
    for (const entry of readdirSync(domainsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === RESERVED_DOMAIN_DIR) continue;
      names.add(entry.name);
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

export function registerDomainCommand(program: Command): void {
  const domain = program.command('domain').description('Domain overlay discovery');

  domain
    .command('ls')
    .description('List domains discovered across configured projects')
    .action((_: unknown, cmd: Command) => {
      const output = new OutputContext(cmd.optsWithGlobals().json ?? false);
      const ws = resolveWorkspace();
      const projectsRoot = join(ws?.farmslotDir ?? repoRoot, 'projects');
      const domains = listDomains(projectsRoot);

      if (output.json) {
        output.writeJson(domains);
        return;
      }
      if (domains.length === 0) {
        output.write(`${dim('no domains found')}\n`);
        return;
      }
      for (const name of domains) output.write(`${name}\n`);
    });
}
