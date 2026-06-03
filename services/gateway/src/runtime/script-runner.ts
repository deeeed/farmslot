// script-runner.ts — Spawn bash scripts with streaming stdout/stderr via events

import { type ChildProcess, spawn } from 'node:child_process';
import path from 'node:path';

import type { ExecResult, ScriptComplete, ScriptOutput } from '@farmslot/protocol';

import { farmslotRoot } from '../fleet/state.js';

export type OutputHandler = (output: ScriptOutput) => void;
export type CompleteHandler = (result: ScriptComplete) => void;

const scriptsDir = path.join(farmslotRoot, 'scripts');
const activeProcesses = new Map<string, ChildProcess>();

let requestCounter = 0;

function generateRequestId(): string {
  return `script-${Date.now()}-${++requestCounter}`;
}

export interface RunScriptOptions {
  script: string;
  args?: string[];
  requestId?: string;
  onOutput?: OutputHandler;
  onComplete?: CompleteHandler;
  cwd?: string;
  env?: Record<string, string>;
}

export function runScript(options: RunScriptOptions): string {
  const {
    script,
    args = [],
    requestId = generateRequestId(),
    onOutput,
    onComplete,
    cwd = farmslotRoot,
    env,
  } = options;

  const scriptPath = path.join(scriptsDir, script);
  const startTime = Date.now();

  const proc = spawn('bash', [scriptPath, ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  activeProcesses.set(requestId, proc);

  proc.stdout.on('data', (data: Buffer) => {
    onOutput?.({
      requestId,
      stream: 'stdout',
      data: data.toString(),
      timestamp: Date.now(),
    });
  });

  proc.stderr.on('data', (data: Buffer) => {
    onOutput?.({
      requestId,
      stream: 'stderr',
      data: data.toString(),
      timestamp: Date.now(),
    });
  });

  proc.on('close', (code) => {
    activeProcesses.delete(requestId);
    onComplete?.({
      requestId,
      exitCode: code ?? 1,
      duration: Date.now() - startTime,
    });
  });

  proc.on('error', (err) => {
    activeProcesses.delete(requestId);
    onOutput?.({
      requestId,
      stream: 'stderr',
      data: `spawn error: ${err.message}\n`,
      timestamp: Date.now(),
    });
    onComplete?.({
      requestId,
      exitCode: 1,
      duration: Date.now() - startTime,
    });
  });

  return requestId;
}

// Run a script and collect all output, returning when complete
export function runScriptCollect(script: string, args: string[] = []): Promise<ExecResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';

    runScript({
      script,
      args,
      onOutput(output) {
        if (output.stream === 'stdout') stdout += output.data;
        else stderr += output.data;
      },
      onComplete(result) {
        resolve({ stdout, stderr, exitCode: result.exitCode });
      },
    });
  });
}

export function cancelScript(requestId: string): boolean {
  const proc = activeProcesses.get(requestId);
  if (!proc) return false;
  proc.kill('SIGTERM');
  return true;
}
