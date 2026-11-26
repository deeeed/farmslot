#!/usr/bin/env node
// Learnings v1 (ADR-026 Amendment 4) warnings for a task's artifacts/learnings.md.
// A warning never fails a mark or a finished run: the worker sees it while it can
// still fix the file, and the gateway reads the file as written.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let protocol;
let unavailable;
try {
  protocol = await import('@farmslot/protocol/contracts/learnings');
} catch (error) {
  // A warning must never fail a mark or a run, so any load failure (a source checkout before
  // @farmslot/protocol has built, an older install) only turns the checks off, and says so.
  unavailable = `learnings v1 checks unavailable: ${error?.code ?? error?.message ?? error}`;
}

/** The issues of a v1 learnings file, each `line N: ...`; none for a legacy or missing file. */
export function learningsWarnings(taskDir) {
  let text;
  try {
    text = readFileSync(path.join(taskDir, 'artifacts', 'learnings.md'), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    // An unreadable file is the contract's to judge; this check only reports it.
    return [`learnings.md is unreadable (${error?.code ?? error?.message ?? error})`];
  }
  if (!protocol) {
    if (process.env.FARMSLOT_DEBUG_AGENT_RUNTIME) console.warn(`[agent-runtime] ${unavailable}`);
    return [];
  }
  const parsed = protocol.parseLearnings(text);
  return parsed.version === 1 ? parsed.issues : [];
}

/** The warning block a worker sees, with the format to fix the file against. */
export function learningsWarningText(warnings) {
  if (!warnings.length) return '';
  return [
    'LEARNINGS_V1_WARN artifacts/learnings.md (fix it before the run ends; this does not block):',
    ...warnings.map((warning) => `- ${warning}`),
    '',
    ...(protocol ? [protocol.LEARNINGS_V1_FORMAT, ''] : []),
  ].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const taskDir = process.argv[2];
  if (!taskDir) {
    console.error('usage: learnings-check.mjs <task-dir>');
    process.exit(2);
  }
  process.stderr.write(learningsWarningText(learningsWarnings(taskDir)));
}
