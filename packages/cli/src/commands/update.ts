import type { Command } from 'commander';

import { bold, dim, green, red } from '../colors.js';
import { runDoctor } from '../onboarding/doctor.js';
import { farmslotUpdate } from '../onboarding/update.js';
import { resolveWorkspace } from '../onboarding/workspace.js';
import { OutputContext } from '../output.js';

export function registerUpdateCommand(program: Command): void {
  program
    .command('update')
    .description('Update the workspace farmslot clone, apply pool migrations, re-sync packs')
    .action(async (_: unknown, cmd: Command) => {
      const output = new OutputContext(cmd.optsWithGlobals().json ?? false);
      const ws = resolveWorkspace();
      if (!ws) {
        output.error('no workspace found — set FARMSLOT_WORKSPACE or run install.sh');
        process.exit(1);
      }
      const infos: string[] = [];
      try {
        const result = await farmslotUpdate(ws, {
          step: (label, detail) => {
            if (!output.json) {
              output.write(`${green('[OK]')} ${label}${detail ? dim(`  ${detail}`) : ''}\n`);
            }
          },
          info: (msg) => {
            infos.push(msg);
            if (!output.json) output.write(`${dim(msg)}\n`);
          },
        });

        // Every onboarding command ends with doctor.
        const report = runDoctor(ws);
        if (output.json) {
          output.writeJson({ ...result, notes: infos, doctor: report });
        } else {
          output.write(
            `\n${bold('update complete')} ${dim(`${result.branch} @ ${result.commit}`)}\n` +
              `  migrations: ${result.migrationsApplied.length ? result.migrationsApplied.join(', ') : 'none'}\n` +
              `  packs re-synced: ${result.packsSynced.length ? result.packsSynced.join(', ') : 'none'}\n`,
          );
          output.write(`\n${bold('doctor')}\n`);
          for (const section of report.sections) {
            for (const check of section.checks) {
              if (!check.ok) {
                output.write(
                  `${red('[FAIL]')} ${section.title}: ${check.name}${check.detail ? dim(`  ${check.detail}`) : ''}\n`,
                );
              }
            }
          }
          output.write(
            report.ok
              ? `${green('doctor: all checks passed')}\n`
              : `${red('doctor: checks failed')}\n`,
          );
        }
        if (!report.ok) process.exit(1);
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
