// methods/diagnostics.ts — diagnostics.run (project-configurable type/lint checking)

import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';

import type { Diagnostic, DiagnosticsRunParams, DiagnosticsRunResult } from '@farmslot/protocol';

import { isLocal, loadSlotVars } from '../core/index.js';
import { loadPoolConfigs, loadProjectConfig } from '../fleet/state.js';

const exec = promisify(execCb);

async function resolveRepoPath(slotId: string): Promise<string> {
  const pools = await loadPoolConfigs();
  for (const pool of pools) {
    const slot = pool.slots.find((s) => s.id === slotId);
    if (slot?.repo) return slot.repo;
  }
  throw new Error(`Slot ${slotId} not found in pool configs`);
}

// Default command if project doesn't define a diagnostics hook
const DEFAULT_CMD = 'npx tsc --noEmit --pretty false';
const MAX_DIAGNOSTICS = 500;

async function runSingleSource(
  cmd: string,
  repoPath: string,
  sourceName: string,
): Promise<Diagnostic[]> {
  let stdout = '';
  try {
    const result = await exec(cmd, {
      cwd: repoPath,
      maxBuffer: 5 * 1024 * 1024,
      timeout: 120_000,
    });
    stdout = result.stdout;
  } catch (err: any) {
    // Non-zero exit is expected when there are errors
    stdout = err.stdout || '';
  }

  const diagnostics = parseDiagnostics(stdout);
  for (const d of diagnostics) d.source = sourceName;
  return diagnostics;
}

export async function diagnosticsRun(params: DiagnosticsRunParams): Promise<DiagnosticsRunResult> {
  const vars = await loadSlotVars(params.slotId);
  if (!isLocal(vars.host, vars.machine)) {
    throw new Error('Diagnostics only supported on local slots');
  }

  const repoPath = await resolveRepoPath(params.slotId);

  // Check project.json for a diagnostics hook
  const project = await loadProjectConfig(vars.projectName);
  const cmd = project?.hooks?.diagnostics || DEFAULT_CMD;

  let diagnostics: Diagnostic[];

  if (typeof cmd === 'string') {
    // Backward compat: single command, tagged as 'tsc'
    diagnostics = await runSingleSource(cmd, repoPath, 'tsc');
  } else {
    // Multi-source: run all in parallel, tag each with source name
    const results = await Promise.all(
      Object.entries(cmd).map(([name, command]) => runSingleSource(command, repoPath, name)),
    );
    diagnostics = results.flat();
  }

  const truncated = diagnostics.length >= MAX_DIAGNOSTICS;
  diagnostics = diagnostics.slice(0, MAX_DIAGNOSTICS);
  return { diagnostics, truncated };
}

// Parse tsc-style output: file(line,col): error TSxxxx: message
// Also handles eslint --format compact: file: line:col error message (rule)
function parseDiagnostics(output: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  // tsc format: file(line,col): error TSxxxx: message
  const tscPattern = /^(.+)\((\d+),(\d+)\): (error|warning) (TS\d+): (.+)$/;
  // eslint compact: /path/file.ts: line 5, col 10, Error - msg (rule-name)
  const eslintPattern = /^(.+): line (\d+), col (\d+), (Error|Warning) - (.+?)(?:\s+\((.+)\))?$/;

  for (const line of output.split('\n')) {
    if (diagnostics.length >= MAX_DIAGNOSTICS) break;

    let match = line.match(tscPattern);
    if (match) {
      diagnostics.push({
        file: match[1],
        line: parseInt(match[2], 10),
        column: parseInt(match[3], 10),
        severity: match[4] as 'error' | 'warning',
        code: match[5],
        message: match[6],
      });
      continue;
    }

    match = line.match(eslintPattern);
    if (match) {
      diagnostics.push({
        file: match[1],
        line: parseInt(match[2], 10),
        column: parseInt(match[3], 10),
        severity: match[4].toLowerCase() as 'error' | 'warning',
        code: match[6] || undefined,
        message: match[5],
      });
    }
  }

  return diagnostics;
}
