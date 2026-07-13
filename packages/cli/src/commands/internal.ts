// internal.ts — gateway-free plumbing verbs for lifecycle scripts (Phase 2 of
// the CLI closeout). scripts/lib/slot-common.sh delegates slot resolution and
// hook expansion here, so the {{var}} vocabulary has exactly one
// implementation (@farmslot/slot-config, shared with the gateway) and works
// even when the gateway is down (teardown-slot.sh contract).

import type { Command } from 'commander';

import {
  expandDispatchCmd,
  expandHook,
  expandPlatformField,
  expandRecycleCmd,
  expandTemplate,
  getProjectField,
  loadProjectVars,
  loadSlotVars,
  renderFixtureTemplate,
  resolveProjectTaskDirName,
  resolveSlot,
  resolveSlotByRepo,
  type SlotVars,
} from '@farmslot/slot-config';

import { createEmitter } from '../envelope.js';
import { OutputContext } from '../output.js';

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/**
 * The exact variable set scripts/lib/slot-common.sh's load_slot_vars used to
 * assemble with python heredocs, including its backward-compat aliases.
 */
export function slotVarsShellLines(vars: SlotVars): string[] {
  const resource = (key: string) => vars.resourceVars[key] ?? '';
  const pairs: Array<[string, string]> = [
    ['MACHINE', vars.machine],
    ['PLATFORM', vars.platform],
    ['HOST', vars.host],
    ['SSH_USER', vars.sshUser],
    ['OS_TYPE', vars.osType],
    ['CLAUDE_PATH', vars.claudePath],
    ['CODEX_PATH', vars.codexPath],
    ['OPENCODE_PATH', vars.opencodePath],
    ['CURSOR_PATH', vars.cursorPath],
    ['GROK_PATH', vars.grokPath],
    ['DISPATCH_CMD', vars.dispatchCmd],
    ['RECYCLE_CMD', vars.recycleCmd],
    ['REPO', vars.repo],
    ['SESSION', vars.session],
    ['APP', resource('app')],
    ...Object.entries(vars.resourceVars).map(
      ([key, value]) => [key.toUpperCase(), value] as [string, string],
    ),
    ['WATCHER_PORT', resource('port')],
    ['METRO_PORT', resource('port')],
    ['IOS_SIMULATOR', resource('simulator')],
    ['ANDROID_AVD', resource('avd')],
    ['AVD_NAME', resource('avd')],
    ['CDP_PORT', resource('cdp_port')],
    ['ADB_SERIAL', resource('adb_serial')],
    ['SNAPSHOT', resource('snapshot')],
    ['SLOT_ID', vars.slotId],
    ['SLOT_MODE', vars.slotMode],
    ['SLOT_ENABLED', vars.slotEnabled ? 'True' : 'False'],
    ['SSH_TARGET', vars.sshTarget],
    ['REMOTE_REPO', vars.remoteRepo],
  ];
  return pairs.map(([key, value]) => `${key}=${shellQuote(value)}`);
}

function parseExtraVars(extras: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of extras) {
    const eq = entry.indexOf('=');
    if (eq <= 0) {
      throw Object.assign(new Error(`Invalid --var '${entry}' — expected KEY=value.`), {
        code: 'USAGE_ERROR',
        userAction: 'Pass extra template variables as --var key=value (repeatable).',
      });
    }
    out[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return out;
}

export function registerInternalCommand(program: Command): void {
  const internal = program
    .command('internal')
    .description('Gateway-free plumbing for lifecycle scripts (stable output contracts)');

  internal
    .command('slot-vars <slotId>')
    .description('Resolve a slot and print its variables (--shell emits eval-able exports)')
    .option('--shell', 'Print KEY=value lines for `eval` (the load_slot_vars contract)')
    .action(async (slotId: string, opts: { shell?: boolean }, cmd: Command) => {
      const output = new OutputContext(Boolean(cmd.optsWithGlobals().json));
      const emit = createEmitter(output, cmd);
      try {
        const vars = await loadSlotVars(slotId);
        if (opts.shell) {
          // Raw plumbing output — consumed by `eval` in bash, never enveloped.
          process.stdout.write(`${slotVarsShellLines(vars).join('\n')}\n`);
          return;
        }
        emit.ok({ vars });
      } catch (err) {
        emit.fail(err);
      }
    });

  internal
    .command('resolve-slot [slotId]')
    .description('Locate a slot across pool JSONs (pool-level fields + slot + poolFile)')
    .option('--by-repo <dir>', 'Reverse-lookup by checkout directory instead of id')
    .option('--raw', 'Print the pool+slot JSON blob only (the SLOT_RESULT contract)')
    .action(
      async (
        slotId: string | undefined,
        opts: { byRepo?: string; raw?: boolean },
        cmd: Command,
      ) => {
        const output = new OutputContext(Boolean(cmd.optsWithGlobals().json));
        const emit = createEmitter(output, cmd);
        try {
          if (!slotId && !opts.byRepo) {
            throw Object.assign(new Error('Pass a slot id or --by-repo <dir>.'), {
              code: 'USAGE_ERROR',
              userAction:
                'Run `farmslot internal resolve-slot <slotId>` or `farmslot internal resolve-slot --by-repo <dir>`.',
            });
          }
          const resolved = opts.byRepo
            ? await resolveSlotByRepo(opts.byRepo)
            : await resolveSlot(slotId as string);
          if (opts.raw) {
            // The bash SLOT_RESULT shape: pool-level fields + the slot under 'slot'.
            const poolLevel = Object.fromEntries(
              Object.entries(resolved.pool).filter(([key]) => key !== 'slots'),
            );
            process.stdout.write(
              `${JSON.stringify({ ...poolLevel, slot: resolved.slot, poolFile: resolved.poolFile })}\n`,
            );
            return;
          }
          emit.ok({ resolved });
        } catch (err) {
          emit.fail(err);
        }
      },
    );

  internal
    .command('project-vars <projectName>')
    .description('Resolve project.json paths/dirs (--shell emits the load_project_config contract)')
    .option('--shell', 'Print KEY=value lines for `eval`')
    .action(async (projectName: string, opts: { shell?: boolean }, cmd: Command) => {
      const output = new OutputContext(Boolean(cmd.optsWithGlobals().json));
      const emit = createEmitter(output, cmd);
      try {
        const vars = await loadProjectVars(projectName);
        if (opts.shell) {
          const lines: Array<[string, string]> = [
            ['PROJECT_NAME', vars.projectName],
            ['PROJECT_CONFIG', vars.projectConfig],
            ['PROJECT_FIXTURES_DIR', vars.projectFixturesDir],
            ['PROJECT_TEMPLATES_DIR', vars.projectTemplatesDir],
            ['RUNTIME_DIR', vars.runtimeDir],
            ['ARTIFACT_DIR', vars.artifactDir],
            ['RECIPE_DIR', vars.recipeDir ?? `${vars.runtimeDir}/recipes`],
            ['WORKER_TASK_DIR_NAME', resolveProjectTaskDirName(vars.projectJson)],
          ];
          process.stdout.write(
            `${lines.map(([key, value]) => `${key}=${shellQuote(value)}`).join('\n')}\n`,
          );
          return;
        }
        const { projectJson: _projectJson, ...summary } = vars;
        emit.ok({ vars: summary });
      } catch (err) {
        emit.fail(err);
      }
    });

  internal
    .command('project-field <projectName> <dotpath>')
    .description('Read a dotted path from project.json (empty when missing)')
    .option('--raw', 'Print only the value')
    .action(async (projectName: string, dotpath: string, opts: { raw?: boolean }, cmd: Command) => {
      const output = new OutputContext(Boolean(cmd.optsWithGlobals().json));
      const emit = createEmitter(output, cmd);
      try {
        const vars = await loadProjectVars(projectName);
        const value = getProjectField(vars.projectJson, dotpath);
        if (opts.raw) {
          process.stdout.write(`${value}\n`);
          return;
        }
        emit.ok({ dotpath, value });
      } catch (err) {
        emit.fail(err);
      }
    });

  internal
    .command('expand-dispatch-cmd <slotId>')
    .description("Expand the pool's dispatch_cmd template for a runner/model/task")
    .option('--runner <name>', 'Runner id')
    .option('--model <name>', 'Model name')
    .option('--task-file <path>', 'Task file substitution')
    .option('--task-prompt <text>', 'Task prompt substitution')
    .option('--effort <level>', 'Effort substitution')
    .option('--raw', 'Print only the expanded command')
    .action(
      async (
        slotId: string,
        opts: {
          runner?: string;
          model?: string;
          taskFile?: string;
          taskPrompt?: string;
          effort?: string;
          raw?: boolean;
        },
        cmd: Command,
      ) => {
        const output = new OutputContext(Boolean(cmd.optsWithGlobals().json));
        const emit = createEmitter(output, cmd);
        try {
          const vars = await loadSlotVars(slotId);
          const expanded = expandDispatchCmd(vars, {
            runner: opts.runner,
            model: opts.model,
            taskFile: opts.taskFile,
            taskPrompt: opts.taskPrompt,
            effort: opts.effort,
          });
          if (opts.raw) {
            process.stdout.write(`${expanded}\n`);
            return;
          }
          emit.ok({ expanded });
        } catch (err) {
          emit.fail(err);
        }
      },
    );

  internal
    .command('expand-recycle-cmd <slotId>')
    .description("Expand the pool's recycle_cmd template")
    .option('--raw', 'Print only the expanded command')
    .action(async (slotId: string, opts: { raw?: boolean }, cmd: Command) => {
      const output = new OutputContext(Boolean(cmd.optsWithGlobals().json));
      const emit = createEmitter(output, cmd);
      try {
        const vars = await loadSlotVars(slotId);
        const expanded = expandRecycleCmd(vars);
        if (opts.raw) {
          process.stdout.write(`${expanded}\n`);
          return;
        }
        emit.ok({ expanded });
      } catch (err) {
        emit.fail(err);
      }
    });

  internal
    .command('expand-template <slotId> <text>')
    .description('Expand {{var}} placeholders in a string with slot/project variables')
    .action(async (slotId: string, text: string, _opts: unknown, cmd: Command) => {
      const output = new OutputContext(Boolean(cmd.optsWithGlobals().json));
      const emit = createEmitter(output, cmd);
      try {
        const vars = await loadSlotVars(slotId);
        const projectVars = await loadProjectVars(vars.projectName);
        // Raw plumbing output — the expand_slot_template contract.
        process.stdout.write(`${expandTemplate(text, vars, projectVars)}\n`);
      } catch (err) {
        emit.fail(err);
      }
    });

  internal
    .command('expand-platform-field <slotId> <field>')
    .description('Expand a project.json platforms.<platform>.<field> command for the slot')
    .action(async (slotId: string, field: string, _opts: unknown, cmd: Command) => {
      const output = new OutputContext(Boolean(cmd.optsWithGlobals().json));
      const emit = createEmitter(output, cmd);
      try {
        const vars = await loadSlotVars(slotId);
        const projectVars = await loadProjectVars(vars.projectName);
        // Raw plumbing output — empty when the platform/field is undefined.
        process.stdout.write(
          `${expandPlatformField(field, projectVars.projectJson, vars, projectVars)}\n`,
        );
      } catch (err) {
        emit.fail(err);
      }
    });

  internal
    .command('render-fixture-template <slotId> <srcPath>')
    .description('Render a fixture template file with slot/project variables to stdout')
    .action(async (slotId: string, srcPath: string, _opts: unknown, cmd: Command) => {
      const output = new OutputContext(Boolean(cmd.optsWithGlobals().json));
      const emit = createEmitter(output, cmd);
      try {
        const vars = await loadSlotVars(slotId);
        const projectVars = await loadProjectVars(vars.projectName);
        // Raw plumbing output — sync-fixtures.sh writes it to the slot repo.
        process.stdout.write(await renderFixtureTemplate(srcPath, vars, projectVars));
      } catch (err) {
        emit.fail(err);
      }
    });

  internal
    .command('expand-hook <slotId> <hookName>')
    .description('Expand a project.json hook with slot/project template variables')
    .option('--var <key=value>', 'Extra template variable (repeatable)', collectVar, [])
    .option('--raw', 'Print only the expanded command (empty when the hook is undefined)')
    .action(
      async (
        slotId: string,
        hookName: string,
        opts: { var: string[]; raw?: boolean },
        cmd: Command,
      ) => {
        const output = new OutputContext(Boolean(cmd.optsWithGlobals().json));
        const emit = createEmitter(output, cmd);
        try {
          const extraVars = parseExtraVars(opts.var);
          const vars = await loadSlotVars(slotId);
          const projectVars = await loadProjectVars(vars.projectName);
          const expanded = expandHook(
            hookName,
            projectVars.projectJson,
            vars,
            projectVars,
            extraVars,
          );
          if (opts.raw) {
            // Raw plumbing output — scripts capture it directly.
            process.stdout.write(`${expanded}\n`);
            return;
          }
          emit.ok({ hook: hookName, expanded });
        } catch (err) {
          emit.fail(err);
        }
      },
    );
}

function collectVar(value: string, previous: string[]): string[] {
  return [...previous, value];
}
