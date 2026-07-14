#!/usr/bin/env node
// backfill-orphan-runs.mjs — rehydrate Run JSON for task dirs whose
// session-metrics.json references a runId with no matching .runs/{id}.json.
//
// Usage:
//   node scripts/backfill-orphan-runs.mjs            # dry-run (default)
//   node scripts/backfill-orphan-runs.mjs --write    # actually persist

import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const WRITE = process.argv.includes('--write');
const ROOT = path.resolve(new URL('..', import.meta.url).pathname, '..');
const RUNS_DIR = path.join(ROOT, '.runs');
const PROJECTS_DIR = path.join(ROOT, 'projects');

// ADR-023 epoch — runs before this get safetyTier:"dangerous" to match legacy posture.
const SAFETY_TIER_EPOCH_ISO = '2026-04-20T00:00:00Z';
const SAFETY_TIER_EPOCH = Date.parse(SAFETY_TIER_EPOCH_ISO);

// Mirrors FLOW_STEPS in packages/protocol/src/types.ts. This script runs
// outside the workspace TS build path; the literal must be hand-updated when
// protocol changes order or adds/removes a step.
const FLOW_STEPS = {
  'fix-bug': [
    'find-slot',
    'grade',
    'write-task',
    'prepare',
    'dispatch',
    'monitor',
    'self-review',
    'complete',
    'human-gate',
    'finalize',
    'ci-watch',
  ],
  'review-pr': [
    'find-slot',
    'write-task',
    'prepare',
    'dispatch',
    'monitor',
    'human-gate',
    'complete',
  ],
  dev: [
    'find-slot',
    'write-task',
    'prepare',
    'dispatch',
    'monitor',
    'self-review',
    'complete',
    'human-gate',
    'finalize',
    'ci-watch',
  ],
  'pr-complete': [
    'find-slot',
    'write-task',
    'prepare',
    'dispatch',
    'monitor',
    'complete',
    'finalize',
    'ci-watch',
  ],
  'update-branch': [
    'write-task',
    'dispatch',
    'monitor',
    'self-review',
    'complete',
    'finalize',
    'ci-watch',
  ],
};

// Mirrors normalizeFlowType in packages/protocol/src/contracts/runs.ts. Legacy
// session metrics can carry pre-rename flow ids ('merge-main', 'feature'); map
// them to current ids so the FLOW_STEPS lookup finds the right pipeline instead
// of falling back to fix-bug. Hand-update when protocol adds a rename.
function normalizeFlowType(value) {
  switch (value) {
    case 'merge-main':
      return 'update-branch';
    case 'feature':
      return 'dev';
    default:
      return value;
  }
}

async function fileExists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function parseTaskMdHeader(text) {
  const match = text.match(/```\s*\n([\s\S]*?)\n```/);
  if (!match) return {};
  const out = {};
  for (const line of match[1].split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+):\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

function parseTaskDirCreatedAt(taskDirName) {
  // Formats: proj-2965-0419-230402 or proj-2965-0419-2304 (MMDD-HHMM[SS])
  const m = taskDirName.match(/-(\d{4})-(\d{2})(\d{2})(\d{2})?$/);
  if (!m) return null;
  const [, mmdd, hh, mm, ss] = m;
  const year = new Date().getUTCFullYear();
  const month = Number(mmdd.slice(0, 2)) - 1;
  const day = Number(mmdd.slice(2, 4));
  const date = new Date(Date.UTC(year, month, day, Number(hh), Number(mm), Number(ss || '0')));
  return date.toISOString();
}

async function listSessionMetrics() {
  const found = [];
  let projects;
  try {
    projects = await readdir(PROJECTS_DIR);
  } catch {
    return found;
  }
  for (const proj of projects) {
    const tasksRoot = path.join(PROJECTS_DIR, proj, 'tasks');
    let groups;
    try {
      groups = await readdir(tasksRoot);
    } catch {
      continue;
    }
    for (const group of groups) {
      const groupDir = path.join(tasksRoot, group);
      let items;
      try {
        items = await readdir(groupDir);
      } catch {
        continue;
      }
      for (const item of items) {
        const taskDir = path.join(groupDir, item);
        const sm = path.join(taskDir, 'artifacts', 'session-metrics.json');
        if (await fileExists(sm))
          found.push({ project: proj, group, item, taskDir, sessionMetricsPath: sm });
      }
    }
  }
  return found;
}

async function buildRunFromTask(entry) {
  const sm = JSON.parse(await readFile(entry.sessionMetricsPath, 'utf-8'));
  const runId = sm.runId;
  if (!runId) return null;

  const taskMdPath = path.join(entry.taskDir, 'TASK.md');
  let header = {};
  if (await fileExists(taskMdPath)) {
    header = parseTaskMdHeader(await readFile(taskMdPath, 'utf-8'));
  }

  const createdAt = parseTaskDirCreatedAt(entry.item) ?? sm.capturedAt ?? new Date().toISOString();
  const completedAt = sm.capturedAt ?? createdAt;
  const flowType =
    normalizeFlowType(sm.flowType) ||
    (entry.group === 'fix' ? 'fix-bug' : entry.group === 'feat' ? 'dev' : 'fix-bug');

  const prNumberRaw = (header.PR_NUMBER || '').trim();
  const prNumber = prNumberRaw ? Number(prNumberRaw) : undefined;

  const ticket = header.TICKET || entry.item.split('-').slice(0, 2).join('-').toUpperCase();
  const ticketOrPr = ticket;

  const stepNames = FLOW_STEPS[flowType] ?? FLOW_STEPS['fix-bug'];
  const steps = stepNames.map((name) => ({
    name,
    status: 'done',
    startedAt: createdAt,
    completedAt,
  }));

  const createdAtMs = Date.parse(createdAt);
  const safetyTier =
    Number.isFinite(createdAtMs) && createdAtMs < SAFETY_TIER_EPOCH ? 'dangerous' : undefined;

  const run = {
    id: runId,
    familyId: runId,
    parentRunId: null,
    familyRootTicketOrPr: ticketOrPr,
    lane: 'production',
    variant: null,
    flowType,
    status: 'done',
    project: sm.project,
    ticketOrPr,
    slotId: sm.slotId ?? null,
    branch: header.BRANCH || null,
    taskFile: path.relative(ROOT, path.join(entry.taskDir, 'TASK.md')),
    steps,
    decisions: [],
    metrics: {
      nudgeCount: sm.nudgeCount ?? 0,
      model: sm.model ?? null,
      runner: sm.runner ?? null,
      runnerSessionId: null,
      runnerSessionPath: null,
      durationMs: sm.totalDurationMs ?? undefined,
    },
    createdAt,
    updatedAt: completedAt,
    completedAt,
    summary: header.TITLE || undefined,
    prNumber: Number.isFinite(prNumber) ? prNumber : undefined,
    safetyTier,
  };

  // Drop undefined fields so persisted JSON matches normal runs.
  for (const k of Object.keys(run)) if (run[k] === undefined) delete run[k];
  for (const k of Object.keys(run.metrics)) if (run.metrics[k] === undefined) delete run.metrics[k];

  return run;
}

async function main() {
  const entries = await listSessionMetrics();
  await mkdir(RUNS_DIR, { recursive: true });
  const existing = new Set(
    (await readdir(RUNS_DIR)).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)),
  );

  const orphans = [];
  for (const entry of entries) {
    const sm = JSON.parse(await readFile(entry.sessionMetricsPath, 'utf-8'));
    if (sm.runId && !existing.has(sm.runId)) orphans.push(entry);
  }

  console.log(`Scanned ${entries.length} task dirs with session-metrics.json`);
  console.log(`Orphans (no .runs/{id}.json): ${orphans.length}`);
  console.log(`Mode: ${WRITE ? 'WRITE' : 'dry-run (pass --write to persist)'}`);
  console.log('');

  let written = 0;
  for (const entry of orphans) {
    const run = await buildRunFromTask(entry);
    if (!run) {
      console.warn(`skip: no runId in ${entry.sessionMetricsPath}`);
      continue;
    }
    console.log(
      `- ${run.id}  ${run.flowType.padEnd(12)} ${run.status.padEnd(6)} ${run.ticketOrPr}  [${run.branch ?? 'no-branch'}]`,
    );
    if (WRITE) {
      const out = path.join(RUNS_DIR, `${run.id}.json`);
      await writeFile(out, JSON.stringify(run, null, 2), 'utf-8');
      written++;
    }
  }

  console.log('');
  console.log(
    WRITE
      ? `Wrote ${written} run file(s). Restart gateway to reload.`
      : `Dry-run only. Rerun with --write to persist.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
