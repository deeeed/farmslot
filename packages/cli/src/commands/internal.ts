// internal.ts — gateway-free plumbing verbs for lifecycle scripts (Phase 2 of
// the CLI closeout). scripts/lib/slot-common.sh delegates slot resolution and
// hook expansion here, so the {{var}} vocabulary has exactly one
// implementation (@farmslot/slot-config, shared with the gateway) and works
// even when the gateway is down (teardown-slot.sh contract).

import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Command } from 'commander';

import {
  computePRRecommendation,
  deriveScoreKey,
  parseBugInput,
  validateBugScore,
} from '@farmslot/protocol';
import {
  computeFixturePlan,
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
  runSessionUsage,
  type SessionAction,
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
  const validName = /^[A-Za-z_][A-Za-z0-9_]*$/;
  return pairs
    .filter(([key]) => {
      if (validName.test(key)) return true;
      // A resource field that is not a valid shell identifier cannot become an
      // eval-able assignment; surface it instead of emitting broken syntax.
      process.stderr.write(
        `slot-vars: skipping resource field '${key}' — not a shell identifier\n`,
      );
      return false;
    })
    .map(([key, value]) => `${key}=${shellQuote(value)}`);
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
        if (opts.shell) return rawFail(err);
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
          if (opts.raw) return rawFail(err);
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
        if (opts.shell) return rawFail(err);
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
        if (opts.raw) return rawFail(err);
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
          if (opts.raw) return rawFail(err);
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
        if (opts.raw) return rawFail(err);
        emit.fail(err);
      }
    });

  internal
    .command('expand-template <slotId> <text>')
    .description('Expand {{var}} placeholders in a string with slot/project variables')
    .option('--var <key=value>', 'Extra template variable (repeatable)', collectVar, [])
    .action(async (slotId: string, text: string, opts: { var: string[] }, _cmd: Command) => {
      try {
        const extraVars = parseExtraVars(opts.var);
        const vars = await loadSlotVars(slotId);
        const projectVars = await loadProjectVars(vars.projectName);
        // Raw plumbing output — the expand_slot_template contract.
        process.stdout.write(`${expandTemplate(text, vars, projectVars, extraVars)}\n`);
      } catch (err) {
        rawFail(err);
      }
    });

  internal
    .command('expand-platform-field <slotId> <field>')
    .description('Expand a project.json platforms.<platform>.<field> command for the slot')
    .action(async (slotId: string, field: string, _opts: unknown, _cmd: Command) => {
      try {
        const vars = await loadSlotVars(slotId);
        const projectVars = await loadProjectVars(vars.projectName);
        // Raw plumbing output — empty when the platform/field is undefined.
        process.stdout.write(
          `${expandPlatformField(field, projectVars.projectJson, vars, projectVars)}\n`,
        );
      } catch (err) {
        rawFail(err);
      }
    });

  internal
    .command('render-fixture-template <slotId> <srcPath>')
    .description('Render a fixture template file with slot/project variables to stdout')
    .option('--var <key=value>', 'Extra template variable (repeatable)', collectVar, [])
    .action(async (slotId: string, srcPath: string, opts: { var: string[] }, _cmd: Command) => {
      try {
        const extraVars = parseExtraVars(opts.var);
        const vars = await loadSlotVars(slotId);
        const projectVars = await loadProjectVars(vars.projectName);
        // Raw plumbing output — sync-fixtures.sh writes it to the slot repo.
        process.stdout.write(await renderFixtureTemplate(srcPath, vars, projectVars, extraVars));
      } catch (err) {
        rawFail(err);
      }
    });

  internal
    .command('fixture-plan <slotId>')
    .description(
      'Render the fixture template/compose plan for a slot in one pass: writes each rendered file into --stage and lists "<dst>\\t<staged-file>" in --manifest; prints the [OK]/[SKIP]/[WARN] log',
    )
    .option('--flow-type <type>', 'Compose selection value (the FLOW_TYPE variant key)')
    .option('--app <path>', 'APP compose selection value')
    .option('--domain <name>', 'Domain overlay for {{domain}} and overlay path selection')
    .requiredOption('--stage <dir>', 'Existing directory to write rendered fixture files into')
    .requiredOption('--manifest <file>', 'File to write the dst→staged-file manifest into')
    .action(
      async (
        slotId: string,
        opts: {
          flowType?: string;
          app?: string;
          domain?: string;
          stage: string;
          manifest: string;
        },
        _cmd: Command,
      ) => {
        try {
          const vars = await loadSlotVars(slotId);
          const projectVars = await loadProjectVars(vars.projectName);
          // Compose selection vars. Bash used indirect expansion
          // (`${!COMPOSE_VAR:-}`), so a project's `compose.var` could name ANY
          // exported variable (e.g. `TARGET`), not just FLOW_TYPE/APP/DOMAIN.
          // Seed from the inherited environment to keep that reach, then overlay
          // the explicit flags — a passed flag wins (mirroring bash's
          // `export FLOW_TYPE=...`), an absent flag leaves the env value. The
          // decision core stays env-free; this CLI edge does the env read.
          const selectionVars: Record<string, string> = {};
          for (const [key, value] of Object.entries(process.env)) {
            if (typeof value === 'string') selectionVars[key] = value;
          }
          if (opts.flowType !== undefined) selectionVars.FLOW_TYPE = opts.flowType;
          if (opts.app !== undefined) selectionVars.APP = opts.app;
          if (opts.domain !== undefined) selectionVars.DOMAIN = opts.domain;
          // Custom slots default to the 'custom' compose variant (sync-fixtures.sh parity).
          if (!selectionVars.FLOW_TYPE && vars.slotMode === 'custom') {
            selectionVars.FLOW_TYPE = 'custom';
          }
          // Only DOMAIN flows into template expansion as an extra var, matching the
          // bash expand_slot_template contract (--var domain=$DOMAIN); FLOW_TYPE/APP
          // are compose-selection keys, not {{placeholders}}.
          const extraVars = opts.domain ? { domain: opts.domain } : undefined;
          const plan = await computeFixturePlan({
            slotVars: vars,
            projectVars,
            selectionVars,
            extraVars,
          });
          const manifestLines: string[] = [];
          for (let i = 0; i < plan.files.length; i++) {
            const staged = path.join(opts.stage, `fixture-${i}`);
            await writeFile(staged, plan.files[i].content);
            manifestLines.push(`${plan.files[i].dst}\t${staged}`);
          }
          await writeFile(
            opts.manifest,
            manifestLines.length ? `${manifestLines.join('\n')}\n` : '',
          );
          // Raw plumbing output — the operator-visible log sync-fixtures.sh streams.
          const out = plan.logs.map((l) => `  [${l.level}] ${l.message}`).join('\n');
          if (out) process.stdout.write(`${out}\n`);
        } catch (err) {
          rawFail(err);
        }
      },
    );

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
          if (opts.raw) return rawFail(err);
          emit.fail(err);
        }
      },
    );

  internal
    .command('session-usage <slotId> <action>')
    .description('Extract runner session token usage (snapshot / report / total)')
    .action(async (slotId: string, action: string, _opts: unknown, _cmd: Command) => {
      try {
        const vars = await loadSlotVars(slotId);
        const result = await runSessionUsage({
          repo: vars.remoteRepo,
          slotId,
          action: action as SessionAction,
          // RUNNER_SESSION_PATH / RUNNER_SESSION_RUNNER flow through exec from
          // the thin bash wrapper; treat empty string the same as unset.
          forcedPath: process.env.RUNNER_SESSION_PATH || undefined,
          forcedRunner: process.env.RUNNER_SESSION_RUNNER || undefined,
        });
        // Raw plumbing output — consumed by scripts and the gateway, never enveloped.
        process.stdout.write(result);
      } catch (err) {
        rawFail(err);
      }
    });
  internal
    .command('parse-bug-input <source>')
    .description(
      'Parse a raw gh/Jira API response from stdin into BugInput JSON (source: github | jira)',
    )
    .action(async (source: string, _opts: unknown, _cmd: Command) => {
      try {
        if (source !== 'github' && source !== 'jira') {
          throw Object.assign(new Error(`source must be "github" or "jira", got: "${source}"`), {
            code: 'USAGE_ERROR',
            userAction: 'Run `farmslot internal parse-bug-input <github|jira>`.',
          });
        }
        const raw = await readStdin();
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          throw Object.assign(new Error('stdin is not valid JSON'), {
            code: 'INVALID_JSON',
            userAction: 'Pipe the raw `gh issue view --json ...` or Jira API response to stdin.',
          });
        }
        const bugInput = parseBugInput(source, parsed);
        // Raw plumbing output — consumed by triage-bug.sh and download scripts.
        process.stdout.write(`${JSON.stringify(bugInput, null, 2)}\n`);
      } catch (err) {
        rawFail(err);
      }
    });

  internal
    .command('validate-bug-score')
    .description(
      'Validate scorer output JSON (difficulty enum, one_shot_probability ∈ [0,1], required fields); exit 0/1',
    )
    .action(async (_opts: unknown, _cmd: Command) => {
      try {
        const raw = await readStdin();
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          throw Object.assign(new Error('scorer output is not valid JSON'), {
            code: 'INVALID_JSON',
            userAction: 'Ensure the scoring script emits valid JSON to stdout.',
          });
        }
        validateBugScore(parsed);
        // Re-emit validated JSON — matches score-bug.sh contract (pretty-print to stdout).
        process.stdout.write(`${JSON.stringify(parsed, null, 2)}\n`);
      } catch (err) {
        rawFail(err);
      }
    });

  internal
    .command('pr-recommendation')
    .description('Compute a PR recommendation from PR facts (decision core, gateway-free)')
    .option('--state <state>', 'PR state: OPEN | CLOSED | MERGED', 'OPEN')
    .option('--worker-active', 'A worker session is alive on the slot')
    .option('--any-failed', 'At least one CI check failed')
    .option('--merge-conflict', 'The PR has merge conflicts')
    .option('--actionable <n>', 'Unresolved actionable comment count', '0')
    .option('--all-passed', 'Every CI check passed')
    .option('--approved', 'The PR has reviewer approval')
    .option('--raw', 'Print only the recommendation token')
    .action(
      async (
        opts: {
          state: string;
          workerActive?: boolean;
          anyFailed?: boolean;
          mergeConflict?: boolean;
          actionable: string;
          allPassed?: boolean;
          approved?: boolean;
          raw?: boolean;
        },
        cmd: Command,
      ) => {
        const output = new OutputContext(Boolean(cmd.optsWithGlobals().json));
        const emit = createEmitter(output, cmd);
        try {
          const state = opts.state.toUpperCase();
          if (state !== 'OPEN' && state !== 'CLOSED' && state !== 'MERGED') {
            throw Object.assign(
              new Error(`--state must be OPEN, CLOSED, or MERGED; got ${opts.state}`),
              {
                code: 'USAGE_ERROR',
                userAction: 'Pass --state OPEN|CLOSED|MERGED.',
              },
            );
          }
          const recommendation = computePRRecommendation({
            prState: state,
            workerActive: Boolean(opts.workerActive),
            anyFailed: Boolean(opts.anyFailed),
            mergeConflict: Boolean(opts.mergeConflict),
            actionableCount: Number(opts.actionable) || 0,
            allPassed: Boolean(opts.allPassed),
            approved: Boolean(opts.approved),
            familyContext: null,
          });
          if (opts.raw) {
            process.stdout.write(`${recommendation}\n`);
            return;
          }
          emit.ok({ recommendation });
        } catch (err) {
          if (opts.raw) return rawFail(err);
          emit.fail(err);
        }
      },
    );

  internal
    .command('derive-score-key')
    .description('Derive the scores/ file key from a bug-input.json on stdin')
    .action(async (_opts: unknown, _cmd: Command) => {
      try {
        const raw = await readStdin();
        const bug = JSON.parse(raw) as Parameters<typeof deriveScoreKey>[0];
        // Raw plumbing output — triage-bug.sh captures the bare key.
        process.stdout.write(`${deriveScoreKey(bug)}\n`);
      } catch (err) {
        rawFail(err);
      }
    });
}

/**
 * Raw plumbing failure contract: nothing on stdout (the data channel),
 * reason + Next line on stderr, exit 1. Envelope failures are only for the
 * non-raw modes of these verbs.
 */
function rawFail(err: unknown): void {
  const reason = err instanceof Error ? err.message : String(err);
  const action = (err as { userAction?: string }).userAction;
  process.stderr.write(`${reason}${action ? `\nNext: ${action}` : ''}\n`);
  process.exitCode = 1;
}

function collectVar(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function readStdin(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}
