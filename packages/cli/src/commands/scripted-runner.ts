import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Command } from 'commander';

import type { WorkerSignal } from '@farmslot/protocol';

export interface ScriptedRunnerOptions {
  taskDir: string;
  mode: 'scenario' | 'command';
  scenario?: 'success' | 'failure' | 'timeout';
  stepDelayMs?: string | number;
  commandRef?: string;
  command?: string;
  cwd?: string;
  timeoutMs?: string | number;
}

interface CommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runCommand(
  command: string,
  cwd: string,
  timeoutMs?: number,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
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

export async function runScriptedRunner(options: ScriptedRunnerOptions): Promise<number> {
  if (options.mode === 'scenario' && process.env.FARMSLOT_ENABLE_SCRIPTED_SCENARIOS !== '1') {
    throw new Error('scripted scenario mode requires FARMSLOT_ENABLE_SCRIPTED_SCENARIOS=1');
  }
  const farmslotRoot = await resolveFarmslotRoot(process.cwd());
  const taskDir = path.resolve(process.cwd(), options.taskDir);
  const artifactsDir = path.join(taskDir, 'artifacts');
  await mkdir(artifactsDir, { recursive: true });

  const provenance = {
    kind: 'farmslot-scripted-runner',
    cliEntrypoint: process.argv[1] ?? null,
    farmslotRoot,
    packageVersion: await packageVersion(farmslotRoot),
    gitSha: await gitSha(farmslotRoot),
    mode: options.mode,
    scenario: options.scenario ?? null,
    commandRef: options.commandRef ?? null,
    cwd: options.cwd ?? process.cwd(),
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
    if (!options.commandRef?.trim()) throw new Error('--command-ref is required for command mode');
    if (!options.command?.trim()) throw new Error('--command is required for command mode');
    const cwd = path.resolve(process.cwd(), options.cwd ?? '.');
    const timeoutMs = parsePositiveInt(options.timeoutMs);
    const result = await runCommand(options.command, cwd, timeoutMs);
    await writeTextFile(path.join(artifactsDir, 'scripted-command.stdout.txt'), result.stdout);
    await writeTextFile(path.join(artifactsDir, 'scripted-command.stderr.txt'), result.stderr);
    await writeTextFile(
      path.join(artifactsDir, 'scripted-command-result.json'),
      `${JSON.stringify({ commandRef: options.commandRef, cwd, exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut }, null, 2)}\n`,
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
  return exitCode;
}

export function registerScriptedRunnerCommand(program: Command): void {
  program
    .command('scripted-runner')
    .description('Internal checkout-local non-LLM worker harness for Farmslot validation')
    .requiredOption('--task-dir <path>', 'Worker task directory relative to the launched repo')
    .requiredOption('--mode <mode>', 'scripted mode: scenario or command')
    .option('--scenario <name>', 'Scenario mode: success, failure, or timeout')
    .option('--step-delay-ms <ms>', 'Scenario step delay in ms')
    .option('--command-ref <name>', 'Project-owned command reference name')
    .option('--command <command>', 'Resolved project-owned command string')
    .option('--cwd <path>', 'Command working directory relative to the launched repo')
    .option('--timeout-ms <ms>', 'Command timeout in ms')
    .action(async (opts: ScriptedRunnerOptions) => {
      const exitCode = await runScriptedRunner(opts);
      process.exitCode = exitCode;
    });
}
