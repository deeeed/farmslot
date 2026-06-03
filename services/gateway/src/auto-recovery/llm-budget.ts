import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { intelligenceAuditDir, intelligenceAuditPathForDate } from './audit-writer.js';

const spentByProjectDay = new Map<string, number>();
const budgetLocks = new Map<string, Promise<void>>();
const seededDays = new Set<string>();
const seedPromises = new Map<string, Promise<void>>();
const MAX_IN_MEMORY_BUDGET_DAYS = 8;

export function budgetDay(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

function key(project: string, date = new Date()): string {
  return `${project}:${budgetDay(date)}`;
}
function budgetLedgerPathForDate(date = new Date()): string {
  return path.join(intelligenceAuditDir(), `${budgetDay(date)}.llm-budget.ndjson`);
}
function normalizeUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function addSpend(project: string, costUsd: number, date = new Date()): number {
  const k = key(project, date);
  const next = normalizeUsd((spentByProjectDay.get(k) ?? 0) + costUsd);
  spentByProjectDay.set(k, next);
  return next;
}

function finiteNonZeroNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value === 0) return null;
  return value;
}

function finitePositiveNumber(value: unknown): number | null {
  const number = finiteNonZeroNumber(value);
  return number !== null && number > 0 ? number : null;
}

function parsedAuditSpend(line: string): { project: string; costUsd: number } | null {
  if (!line.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    // Audit parsing is intentionally best-effort for drift/malformed legacy
    // rows; a bad row must not erase already-readable spend from the day.
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as { project?: unknown; tier?: unknown; costUsd?: unknown };
  if (typeof record.project !== 'string' || record.tier !== 'llm-refined') return null;
  const costUsd = finitePositiveNumber(record.costUsd);
  if (costUsd === null) return null;
  return { project: record.project, costUsd };
}

function parsedLedgerSpend(line: string): { project: string; costUsd: number } | null {
  if (!line.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    // Budget ledger parsing mirrors audit drift tolerance: malformed legacy rows
    // are ignored, but readable rows still enforce the conservative spend cap.
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as { project?: unknown; costUsd?: unknown };
  if (typeof record.project !== 'string') return null;
  const costUsd = finiteNonZeroNumber(record.costUsd);
  if (costUsd === null) return null;
  return { project: record.project, costUsd };
}

function isEnoent(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: unknown }).code === 'ENOENT';
}

async function appendBudgetLedgerSpend(
  project: string,
  costUsd: number,
  kind: 'audit-seed' | 'reserve' | 'reconcile',
  date = new Date(),
): Promise<void> {
  // Farmslot gateway is a single-writer process for a given audit directory.
  // The ledger is durable across restarts but intentionally does not implement
  // cross-process file locking; multi-gateway deployments need external
  // coordination before sharing FARMSLOT_INTELLIGENCE_AUDIT_DIR.
  await mkdir(intelligenceAuditDir(), { recursive: true, mode: 0o700 });
  await appendFile(
    budgetLedgerPathForDate(date),
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      day: budgetDay(date),
      project,
      kind,
      costUsd,
    })}\n`,
    'utf8',
  );
}

async function seedDailySpendFromLedger(date = new Date()): Promise<boolean> {
  const path = budgetLedgerPathForDate(date);
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch (err) {
    if (isEnoent(err)) return false;
    throw err;
  }

  for (const line of contents.split('\n')) {
    const spend = parsedLedgerSpend(line);
    if (!spend) continue;
    addSpend(spend.project, spend.costUsd, date);
  }
  return true;
}

async function seedDailySpendFromAudit(date = new Date()): Promise<Map<string, number>> {
  const totals = new Map<string, number>();
  let contents: string;
  try {
    contents = await readFile(intelligenceAuditPathForDate(date), 'utf8');
  } catch (err) {
    if (isEnoent(err)) return totals;
    throw err;
  }

  for (const line of contents.split('\n')) {
    const spend = parsedAuditSpend(line);
    if (!spend) continue;
    totals.set(spend.project, (totals.get(spend.project) ?? 0) + spend.costUsd);
  }
  for (const [project, costUsd] of totals) {
    await appendBudgetLedgerSpend(project, costUsd, 'audit-seed', date);
    addSpend(project, costUsd, date);
  }
  return totals;
}

async function seedDailySpend(date = new Date()): Promise<void> {
  const day = budgetDay(date);
  // Once a day has any budget-ledger rows, the ledger is authoritative. Audit
  // seeding is only a migration/backfill path for pre-ledger same-day LLM rows.
  // If the ledger exists but has no parseable rows, do not re-derive from audit
  // automatically: operators must repair/remove the ledger explicitly so a
  // restart cannot duplicate audit-seeded spend into the budget file.
  if (!(await seedDailySpendFromLedger(date))) {
    await seedDailySpendFromAudit(date);
  }
  seededDays.add(day);
  pruneInMemoryBudgetDays();
}

function pruneInMemoryBudgetDays(): void {
  if (seededDays.size <= MAX_IN_MEMORY_BUDGET_DAYS) return;
  const days = [...seededDays].sort();
  const staleDays = days.slice(0, Math.max(0, days.length - MAX_IN_MEMORY_BUDGET_DAYS));
  for (const day of staleDays) {
    seededDays.delete(day);
    for (const spendKey of spentByProjectDay.keys()) {
      if (spendKey.endsWith(`:${day}`)) spentByProjectDay.delete(spendKey);
    }
  }
}

async function ensureBudgetDaySeeded(date = new Date()): Promise<void> {
  const day = budgetDay(date);
  if (seededDays.has(day)) return;
  const existing = seedPromises.get(day);
  if (existing) {
    await existing;
    return;
  }
  const pending = seedDailySpend(date).finally(() => {
    seedPromises.delete(day);
  });
  seedPromises.set(day, pending);
  await pending;
}

async function withBudgetLock<T>(project: string, date: Date, fn: () => Promise<T>): Promise<T> {
  const lockKey = key(project, date);
  const previous = budgetLocks.get(lockKey) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(
    () => current,
    () => current,
  );
  budgetLocks.set(lockKey, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (budgetLocks.get(lockKey) === tail) budgetLocks.delete(lockKey);
  }
}

export function canSpendLlmBudget(
  project: string,
  capUsd: number,
  costUsd: number,
  date = new Date(),
): boolean {
  return capUsd > 0 && (spentByProjectDay.get(key(project, date)) ?? 0) + costUsd <= capUsd;
}

export function recordLlmSpend(project: string, costUsd: number, date = new Date()): number {
  return addSpend(project, costUsd, date);
}

export async function reserveLlmBudget(
  project: string,
  capUsd: number,
  minimumCostUsd: number,
  date = new Date(),
): Promise<{ reservedCostUsd: number } | null> {
  if (
    !Number.isFinite(capUsd) ||
    capUsd <= 0 ||
    !Number.isFinite(minimumCostUsd) ||
    minimumCostUsd <= 0
  )
    return null;
  return withBudgetLock(project, date, async () => {
    await ensureBudgetDaySeeded(date);
    const spentUsd = spentByProjectDay.get(key(project, date)) ?? 0;
    const remainingUsd = normalizeUsd(Math.max(0, capUsd - spentUsd));
    if (remainingUsd < minimumCostUsd) return null;
    // Reserve the full remaining budget, not just the expected call cost. This
    // pessimistic hold prevents concurrent failed runs from each starting an LLM
    // call and only discovering after the fact that their actual costs together
    // crossed the daily cap. Successful reconciliation refunds unused budget.
    await appendBudgetLedgerSpend(project, remainingUsd, 'reserve', date);
    addSpend(project, remainingUsd, date);
    return { reservedCostUsd: remainingUsd };
  });
}

export async function reconcileLlmBudgetReservation(
  project: string,
  reservedCostUsd: number,
  actualCostUsd: number,
  capUsd: number,
  date = new Date(),
): Promise<{ spentUsd: number; overBudget: boolean }> {
  const normalizedActualCostUsd = finitePositiveNumber(actualCostUsd) ?? reservedCostUsd;
  return withBudgetLock(project, date, async () => {
    await ensureBudgetDaySeeded(date);
    const deltaUsd = normalizedActualCostUsd - reservedCostUsd;
    if (deltaUsd > 0) {
      const spentUsd = spentByProjectDay.get(key(project, date)) ?? 0;
      return { spentUsd, overBudget: true };
    }
    if (deltaUsd < 0) {
      await appendBudgetLedgerSpend(project, deltaUsd, 'reconcile', date);
      const spentUsd = addSpend(project, deltaUsd, date);
      return { spentUsd, overBudget: capUsd > 0 && spentUsd > capUsd };
    }
    const spentUsd = spentByProjectDay.get(key(project, date)) ?? 0;
    return { spentUsd, overBudget: capUsd > 0 && spentUsd > capUsd };
  });
}

export function resetLlmBudgetForTest(): void {
  spentByProjectDay.clear();
  budgetLocks.clear();
  seededDays.clear();
  seedPromises.clear();
}
