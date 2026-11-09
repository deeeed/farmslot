import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { watch } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Command } from 'commander';

import type { ScriptedRunnerScenario, WorkerSignal } from '@farmslot/protocol';

import { repoRoot } from '../onboarding/workspace.js';

export interface ScriptedRunnerOptions {
  taskDir: string;
  mode: 'scenario' | 'command';
  scenario?: ScriptedRunnerScenario;
  stepDelayMs?: string | number;
  promptScenario?: 'success' | 'edit-forbidden-file';
  commandRef?: string;
  project?: string;
  timeoutMs?: string | number;
}

export interface ScriptedRunnerIO {
  writeTextFile: (filePath: string, content: string) => Promise<void>;
}

interface CommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

interface ProjectScriptedCommand {
  command: string;
  cwd?: string;
  timeoutMs?: number;
}

function parseNonNegativeInt(value: string | number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Expected non-negative integer, got ${String(value)}`);
  }
  return parsed;
}

function parsePositiveInt(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected positive integer, got ${String(value)}`);
  }
  return parsed;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath, 'utf-8');
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

async function resolveFarmslotRoot(startDir: string): Promise<string> {
  if (process.env.FARMSLOT_ROOT) return process.env.FARMSLOT_ROOT;
  let current = path.resolve(startDir);
  while (true) {
    if (await fileExists(path.join(current, 'packages/cli/package.json'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(startDir);
    current = parent;
  }
}

async function packageVersion(farmslotRoot: string): Promise<string | null> {
  try {
    const raw = await readFile(path.join(farmslotRoot, 'packages/cli/package.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch (err) {
    throw new Error(
      `Failed to read CLI package version from ${farmslotRoot}: ${(err as Error).message}`,
    );
  }
}

async function gitSha(farmslotRoot: string): Promise<string | null> {
  const result = await runCommand('git rev-parse HEAD', farmslotRoot, 5000);
  if (result.exitCode !== 0) return null;
  return result.stdout.trim() || null;
}

async function resolveProjectScriptedCommand(
  farmslotRoot: string,
  project: string,
  commandRef: string,
): Promise<ProjectScriptedCommand> {
  const projectConfigPath = path.join(farmslotRoot, 'projects', project, 'project.json');
  let parsed: {
    scripted?: {
      commands?: Record<
        string,
        { command?: unknown; cwd?: unknown; timeout_ms?: unknown; timeoutMs?: unknown }
      >;
    };
  };
  try {
    parsed = JSON.parse(await readFile(projectConfigPath, 'utf-8'));
  } catch (err) {
    throw new Error(
      `Failed to read project config for scripted command '${commandRef}' at ${projectConfigPath}: ${(err as Error).message}`,
    );
  }
  const raw = parsed.scripted?.commands?.[commandRef];
  if (!raw || typeof raw.command !== 'string' || !raw.command.trim()) {
    throw new Error(`scripted commandRef '${commandRef}' is not declared for project ${project}`);
  }
  const timeoutMs = raw.timeout_ms ?? raw.timeoutMs;
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || Number(timeoutMs) <= 0)) {
    throw new Error(`scripted.commands.${commandRef}.timeout_ms must be a positive integer`);
  }
  return {
    command: raw.command,
    ...(typeof raw.cwd === 'string' && raw.cwd.trim() ? { cwd: raw.cwd } : {}),
    ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runCommand(
  command: string,
  cwd: string,
  timeoutMs?: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd, env, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
        }, timeoutMs)
      : null;
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (exitCode, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode, signal, timedOut, stdout, stderr });
    });
  });
}

async function writeTextFile(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf-8');
}

export async function runScriptedRunner(
  options: ScriptedRunnerOptions,
  io: ScriptedRunnerIO = { writeTextFile },
): Promise<number> {
  const { writeTextFile } = io;
  if (options.mode === 'scenario' && process.env.FARMSLOT_ENABLE_SCRIPTED_SCENARIOS !== '1') {
    throw new Error('scripted scenario mode requires FARMSLOT_ENABLE_SCRIPTED_SCENARIOS=1');
  }
  const farmslotRoot = await resolveFarmslotRoot(process.cwd());
  const taskDir = path.resolve(process.cwd(), options.taskDir);
  const artifactsDir = path.join(taskDir, 'artifacts');
  await mkdir(artifactsDir, { recursive: true });

  let scriptedCommand: ProjectScriptedCommand | null = null;
  let commandCwd = process.cwd();
  if (options.mode === 'command') {
    if (!options.commandRef?.trim()) throw new Error('--command-ref is required for command mode');
    if (!options.project?.trim()) throw new Error('--project is required for command mode');
    scriptedCommand = await resolveProjectScriptedCommand(
      farmslotRoot,
      options.project,
      options.commandRef,
    );
    commandCwd = path.resolve(process.cwd(), scriptedCommand.cwd ?? '.');
  }

  const provenance = {
    kind: 'farmslot-scripted-runner',
    cliEntrypoint: process.argv[1] ?? null,
    farmslotRoot,
    cliRoot: repoRoot(),
    packageVersion: await packageVersion(repoRoot()),
    gitSha: await gitSha(repoRoot()),
    mode: options.mode,
    scenario: options.scenario ?? null,
    project: options.project ?? null,
    commandRef: options.commandRef ?? null,
    cwd: commandCwd,
    startedAt: new Date().toISOString(),
  };
  await writeTextFile(
    path.join(artifactsDir, 'scripted-runner-provenance.json'),
    `${JSON.stringify(provenance, null, 2)}\n`,
  );

  let status: WorkerSignal['status'] = 'complete';
  let outcome: WorkerSignal['outcome'] = 'success';
  let disposition: WorkerSignal['disposition'] = 'fixed';
  let reason = 'scripted scenario completed successfully';
  let exitCode = 0;

  if (options.mode === 'scenario') {
    const scenario = options.scenario ?? 'success';
    const stepDelayMs = parseNonNegativeInt(options.stepDelayMs, 500);
    if (scenario === 'silent') {
      await sleep(stepDelayMs);
      return 0;
    }
    if (scenario === 'commit-out-of-band' || scenario === 'edit-forbidden-file') {
      const relative =
        scenario !== 'edit-forbidden-file'
          ? 'scripted-change.txt'
          : '.github/workflows/scripted.yml';
      await writeTextFile(
        path.join(commandCwd, relative),
        `scripted fixture ${provenance.startedAt}\n`,
      );
      const result = await runCommand(
        `git add -- ${relative} && git -c user.name=Fixture -c user.email=fixture@example.invalid -c commit.gpgsign=false -c core.hooksPath=/dev/null commit --only -qm 'test: scripted change' -- ${relative}`,
        commandCwd,
        2000,
      );
      if (result.exitCode !== 0) throw new Error(`Scripted commit failed: ${result.stderr}`);
    }
    if (scenario === 'timeout') {
      await sleep(stepDelayMs || 60_000);
      reason = 'scripted timeout scenario intentionally left without terminal success';
      status = 'failed';
      outcome = 'failure';
      disposition = 'failed';
      exitCode = 124;
    } else {
      await sleep(stepDelayMs);
      if (scenario === 'failure') {
        status = 'failed';
        outcome = 'failure';
        disposition = 'failed';
        reason = 'scripted failure scenario';
        exitCode = 1;
      }
    }
  } else if (options.mode === 'command') {
    if (!scriptedCommand) throw new Error('scripted command mode requires a project commandRef');
    const timeoutMs = parsePositiveInt(options.timeoutMs) ?? scriptedCommand.timeoutMs;
    const result = await runCommand(scriptedCommand.command, commandCwd, timeoutMs, {
      ...process.env,
      FARMSLOT_TASK_DIR: taskDir,
    });
    await writeTextFile(path.join(artifactsDir, 'scripted-command.stdout.txt'), result.stdout);
    await writeTextFile(path.join(artifactsDir, 'scripted-command.stderr.txt'), result.stderr);
    await writeTextFile(
      path.join(artifactsDir, 'scripted-command-result.json'),
      `${JSON.stringify(
        {
          commandRef: options.commandRef,
          project: options.project,
          cwd: commandCwd,
          exitCode: result.exitCode,
          signal: result.signal,
          timedOut: result.timedOut,
        },
        null,
        2,
      )}\n`,
    );
    if (result.timedOut || result.exitCode !== 0) {
      status = 'failed';
      outcome = 'failure';
      disposition = 'failed';
      reason = result.timedOut
        ? `scripted command '${options.commandRef}' timed out`
        : `scripted command '${options.commandRef}' exited ${result.exitCode}`;
      exitCode = result.timedOut ? 124 : (result.exitCode ?? 1);
    } else {
      reason = `scripted command '${options.commandRef}' completed successfully`;
    }
  } else {
    throw new Error(`Unsupported scripted mode: ${(options as { mode?: string }).mode}`);
  }

  const reportPath = path.join(artifactsDir, 'report.md');
  await writeTextFile(
    reportPath,
    `# Scripted Runner Report\n\n- Mode: ${options.mode}\n- Scenario: ${options.scenario ?? 'n/a'}\n- Command ref: ${options.commandRef ?? 'n/a'}\n- Status: ${status}\n- Outcome: ${outcome}\n- Reason: ${reason}\n`,
  );

  if (options.mode === 'scenario') {
    await writeTextFile(
      path.join(artifactsDir, 'pr-description.md'),
      '# Scripted change\n\nDeterministic recovery fixture.\n',
    );
    await writeTextFile(
      path.join(artifactsDir, 'comments-report.md'),
      '# Comments\n\nFixture comments addressed.\n',
    );
    await writeTextFile(
      path.join(artifactsDir, 'learnings.md'),
      '# Learnings\n\n- Recovery fixture completed.\n',
    );
  }
  const signal: WorkerSignal = {
    status,
    outcome,
    disposition,
    reason,
    evidence: {
      reportPath: 'artifacts/report.md',
      artifacts: ['artifacts/scripted-runner-provenance.json'],
    },
    timestamp: new Date().toISOString(),
  };
  await writeTextFile(path.join(taskDir, 'SIGNAL.json'), `${JSON.stringify(signal, null, 2)}\n`);
  if (options.mode === 'scenario' && options.scenario === 'late-ack')
    await runScriptedSession(
      taskDir,
      parseNonNegativeInt(options.stepDelayMs, 100),
      options.promptScenario,
    );
  return exitCode;
}

/** A session consumes only requests delivered by the shared runner adapter. */
export async function runScriptedSession(
  taskDir: string,
  ackDelayMs: number,
  promptScenario = 'success',
): Promise<void> {
  const pane = process.env.TMUX_PANE;
  if (!pane || !/^%[0-9]+$/.test(pane)) throw new Error('Scripted session requires a tmux pane');
  const directory = path.join(process.cwd(), '.agent', `scripted-${pane.slice(1)}`);
  await mkdir(directory, { recursive: true });
  let promptDigest: string | undefined;
  let acknowledged = false;
  let turnStartedAt: number | undefined;
  const receipt = async (active: boolean) => {
    const pending = path.join(directory, 'session.pending');
    await writeTextFile(
      pending,
      JSON.stringify({
        pid: process.pid,
        active,
        promptDigest,
        acknowledged,
        turnStartedAt,
        observedAt: Date.now(),
      }),
    );
    await rename(pending, path.join(directory, 'session.json'));
  };
  await receipt(false);
  const inbox = path.join(directory, 'prompt.json');
  await new Promise<void>((resolve, reject) => {
    let working = false;
    let stopping = false;
    const watcher = watch(directory, () => {
      void consume().catch(fail);
    });
    const close = () => {
      watcher.close();
      process.removeListener('SIGTERM', finish);
      process.removeListener('SIGINT', finish);
    };
    const finish = () => {
      stopping = true;
      close();
      if (!working) resolve();
    };
    const fail = (error: unknown) => {
      close();
      reject(error);
    };
    process.once('SIGTERM', finish);
    process.once('SIGINT', finish);
    async function consume() {
      if (working || stopping) return;
      working = true;
      try {
        if (!(await fileExists(inbox))) return;
        const request: unknown = JSON.parse(await readFile(inbox, 'utf8'));
        if (
          !request ||
          typeof request !== 'object' ||
          !('prompt' in request) ||
          typeof request.prompt !== 'string' ||
          !('taskDir' in request) ||
          typeof request.taskDir !== 'string'
        )
          throw new Error('Invalid scripted prompt request');
        await unlink(inbox);
        promptDigest = createHash('sha256').update(request.prompt).digest('hex');
        acknowledged = false;
        turnStartedAt = Date.now();
        await receipt(true);
        await sleep(ackDelayMs);
        const requested = path.resolve(process.cwd(), request.taskDir);
        if (requested !== path.resolve(taskDir))
          throw new Error('Scripted prompt targets a different task');
        const relative =
          promptScenario === 'edit-forbidden-file'
            ? '.github/workflows/scripted.yml'
            : 'scripted-change.txt';
        const change = path.join(process.cwd(), relative);
        await writeTextFile(change, `scripted fix ${Date.now()}\n`);
        const committed = await runCommand(
          `git add -- ${relative} && git -c commit.gpgsign=false -c core.hooksPath=/dev/null commit --only -qm 'test: apply scripted fix' -- ${relative}`,
          process.cwd(),
          2000,
        );
        if (committed.exitCode !== 0)
          throw new Error(`Scripted fix commit failed: ${committed.stderr}`);
        const mark = path.join(taskDir, 'mark');
        const checklist = request.prompt.includes('CI-FIX.md') ? 'CI-FIX' : 'REVIEW-FIX';
        const rows =
          (await readFile(path.join(taskDir, `${checklist}.md`), 'utf8')).match(/^- \[ \]/gm)
            ?.length ?? 0;
        const command = (args: string) =>
          `"${mark}" --checklist ${checklist}.md --signal ${checklist}-SIGNAL.json ${args}`;
        const result = await runCommand(
          [
            ...Array.from({ length: Math.max(0, rows - 1) }, (_, index) =>
              command(String(index + 1)),
            ),
            command('complete --mark-last'),
          ].join(' && '),
          process.cwd(),
          5000,
        );
        if (result.exitCode !== 0)
          throw new Error(`Scripted acknowledgement failed: ${result.stderr}`);
        acknowledged = true;
        await receipt(false);
      } finally {
        working = false;
        if (stopping) resolve();
      }
    }
    void consume().catch(fail);
  });
}

export function registerScriptedRunnerCommand(program: Command): void {
  program
    .command('scripted-runner')
    .description('Internal checkout-local non-LLM worker harness for Farmslot validation')
    .requiredOption('--task-dir <path>', 'Worker task directory relative to the launched repo')
    .requiredOption('--mode <mode>', 'scripted mode: scenario or command')
    .option(
      '--scenario <name>',
      'Scenario mode: success, failure, timeout, silent, late-ack, commit-out-of-band, or edit-forbidden-file',
    )
    .option(
      '--prompt-scenario <name>',
      'Interactive prompt behaviour: success or edit-forbidden-file',
    )
    .option('--step-delay-ms <ms>', 'Scenario step delay in ms')
    .option('--command-ref <name>', 'Project-owned command reference name')
    .option('--project <name>', 'Project whose project.json owns the command ref')
    .option('--timeout-ms <ms>', 'Command timeout override in ms')
    .action(async (opts: ScriptedRunnerOptions) => {
      const exitCode = await runScriptedRunner(opts);
      process.exitCode = exitCode;
    });
}
