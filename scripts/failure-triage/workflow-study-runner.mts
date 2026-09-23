/** Execute a previously sealed study after independent methodology approval.
 * Import this explicitly; the CLI in workflow-study.mts has no live command.
 */
import { open, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  measuredResponsesCall,
  type MeasuredResponseOptions,
  type MeasuredResponse,
} from '../../services/gateway/src/llm/measured-response.js';
import { verifyPlan } from './workflow-study.mts';

function assert(ok: unknown, reason: string): asserts ok {
  if (!ok) throw new Error(reason);
}
export interface StudyApproval {
  planHash: string;
  methodologyHash: string;
  reviewer: string;
  journalPath: string;
  conclusion: 'approved';
}
export interface RunnerOptions {
  baseUrl: string;
  apiKey: string;
  journalPath: string;
  independentApprovalPath: string;
  methodologyPath: string;
}
export interface JournalEvent {
  version: 1;
  planHash: string;
  caseId: string;
  arm: string;
  promptHash: string;
  kind: 'approved' | 'started' | 'finished' | 'closed';
  journalPath?: string;
  stopReason?: string;
  approvalHash?: string;
  methodologyHash?: string;
  response?: MeasuredResponse;
  workerElapsedMs?: number;
}

/** Journal a reservation before each request and a native response after it. Never retry an uncertain request. */
export async function runStudy(
  plan: Awaited<ReturnType<typeof verifyPlan>>,
  options: RunnerOptions,
  call: (opts: MeasuredResponseOptions) => Promise<MeasuredResponse> = measuredResponsesCall,
): Promise<void> {
  await verifyPlan(plan);
  const [approvalBytes, methodBytes] = await Promise.all([
    readFile(options.independentApprovalPath),
    readFile(options.methodologyPath),
  ]);
  assert(approvalBytes.byteLength <= 4096, 'Approval file too large');
  const approval: StudyApproval = JSON.parse(approvalBytes.toString('utf8'));
  assert(
    approval.conclusion === 'approved' &&
      approval.planHash === plan.planHash &&
      approval.journalPath === options.journalPath &&
      /^[\w.-]{2,100}$/.test(approval.reviewer) &&
      approval.methodologyHash === createHash('sha256').update(methodBytes).digest('hex'),
    'Independent methodology approval does not match frozen study',
  );
  assert(
    options.apiKey.length > 0 && options.journalPath && options.journalPath.startsWith('/'),
    'Missing credential or absolute journal path',
  );
  assert(options.baseUrl === plan.options.baseUrl, 'Worker endpoint differs from sealed plan');
  const url = new URL(options.baseUrl.replace(/\/$/, '') + '/responses');
  assert(
    !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))),
    'Invalid provider URL',
  );
  assert(
    plan.rows.length === 42 && plan.maxPlannedRequests === 42 && plan.options.maxAttempts === 42,
    'Request cap changed',
  );
  const journal = await open(options.journalPath, 'wx', 0o600);
  try {
    await journal.writeFile(
      JSON.stringify({
        version: 1,
        kind: 'approved',
        planHash: plan.planHash,
        journalPath: options.journalPath,
        approvalHash: createHash('sha256').update(approvalBytes).digest('hex'),
        methodologyHash: approval.methodologyHash,
      }) + '\n',
    );
    await journal.sync();
    let stopReason = 'completed';
    for (const row of plan.rows) {
      const header = {
        version: 1 as const,
        planHash: plan.planHash,
        caseId: row.caseId,
        arm: row.arm,
        promptHash: row.promptHash,
      };
      // Reserved cost is bounded by the plan's 42 conservative request ceilings.
      await journal.writeFile(JSON.stringify({ ...header, kind: 'started' }) + '\n');
      await journal.sync();
      const started = performance.now();
      let response: MeasuredResponse;
      try {
        response = await call({
          baseUrl: options.baseUrl,
          apiKey: options.apiKey,
          model: plan.options.model,
          instructions: plan.instructions,
          prompt: row.prompt,
          maxOutputTokens: plan.options.maxOutputTokens,
          reasoning: plan.options.reasoning,
          outputSchema: { name: 'failure_triage_worker', schema: plan.schema },
        });
      } catch {
        // Start was journaled; a transport exception might have occurred after dispatch.
        // Charge and response identity stay unknown. Do not retry this row.
        response = {
          status: 'unavailable',
          attempted: true,
          requestedModel: plan.options.model,
          inputTokens: null,
          outputTokens: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          inputAccounting: 'includes-cache',
          durationMs: performance.now() - started,
          responseReceived: false,
          error: 'transport-exception-unknown-charge',
        };
      }
      const workerElapsedMs = performance.now() - started;
      await journal.writeFile(
        JSON.stringify({ ...header, kind: 'finished', response, workerElapsedMs }) + '\n',
      );
      await journal.sync();
      // An unknown charge cannot be reserved reliably; stop before another request.
      if (
        !response.attempted ||
        response.error ||
        response.inputTokens === null ||
        response.outputTokens === null ||
        (response.cacheReadTokens === null && plan.options.cacheReadMultiplier !== 1) ||
        (response.cacheWriteTokens === null && plan.options.cacheWriteMultiplier !== 1) ||
        (response.returnedModel && response.returnedModel !== plan.options.model) ||
        (response.inputTokens !== null && response.inputTokens > plan.options.maxInputTokens) ||
        (response.outputTokens !== null && response.outputTokens > plan.options.maxOutputTokens)
      ) {
        stopReason = 'uncertain-charge-or-response';
        break;
      }
    }
    await journal.writeFile(
      JSON.stringify({ version: 1, kind: 'closed', planHash: plan.planHash, stopReason }) + '\n',
    );
    await journal.sync();
  } finally {
    await journal.close();
  }
}

/** Verify the runner recorded methodology approval before the first attempted request. */
export async function verifyJournalApproval(
  plan: Awaited<ReturnType<typeof verifyPlan>>,
  text: string,
  approvalPath: string,
  methodologyPath: string,
): Promise<void> {
  await verifyPlan(plan);
  const [approvalBytes, methodBytes] = await Promise.all([
    readFile(approvalPath),
    readFile(methodologyPath),
  ]);
  assert(approvalBytes.byteLength <= 4096, 'Approval file too large');
  const approval: StudyApproval = JSON.parse(approvalBytes.toString('utf8'));
  const first = JSON.parse(text.split('\n')[0]);
  assert(
    approval.conclusion === 'approved' &&
      approval.planHash === plan.planHash &&
      /^[\w.-]{2,100}$/.test(approval.reviewer) &&
      approval.methodologyHash === createHash('sha256').update(methodBytes).digest('hex') &&
      first.kind === 'approved' &&
      first.version === 1 &&
      first.planHash === plan.planHash &&
      first.journalPath === approval.journalPath &&
      /^\/.+/.test(approval.journalPath) &&
      JSON.parse(text.trimEnd().split('\n').at(-1) ?? '{}').kind === 'closed' &&
      first.methodologyHash === approval.methodologyHash &&
      first.approvalHash === createHash('sha256').update(approvalBytes).digest('hex'),
    'Journal does not contain matching prior methodology approval',
  );
}

/** Include every in-flight request as an unknown-charge attempt; no automatic resume. */
export function materializeStudyJournal(
  plan: Awaited<ReturnType<typeof verifyPlan>>,
  text: string,
) {
  const lines = text.split('\n').filter(Boolean);
  assert(
    Buffer.byteLength(text) <= 2 * 1024 * 1024 && lines.length <= 86,
    'Journal exceeds bounds',
  );
  const events: JournalEvent[] = lines.flatMap((line, index) => {
    try {
      return [JSON.parse(line) as JournalEvent];
    } catch (error) {
      // A torn final write after the fsynced 'started' event means the request may have run.
      if (index === lines.length - 1 && !text.endsWith('\n')) return [];
      throw error;
    }
  });
  if (events[0]?.kind === 'approved') events.shift();
  const attempts: Array<{
    planHash: string;
    caseId: string;
    arm: string;
    promptHash: string;
    workerElapsedMs: number | null;
    response: MeasuredResponse;
  }> = [];
  for (const row of plan.rows) {
    if (events.length === 0 || events[0]?.kind === 'closed') break;
    const started = events.shift();
    assert(
      started?.kind === 'started' &&
        started.planHash === plan.planHash &&
        started.caseId === row.caseId &&
        started.arm === row.arm &&
        started.promptHash === row.promptHash,
      'Unexpected or out-of-order journal event',
    );
    const finished = events[0]?.kind === 'finished' ? events.shift() : undefined;
    if (finished)
      assert(
        finished.planHash === plan.planHash &&
          finished.caseId === row.caseId &&
          finished.arm === row.arm &&
          finished.promptHash === row.promptHash &&
          typeof finished.workerElapsedMs === 'number' &&
          Number.isFinite(finished.workerElapsedMs) &&
          finished.workerElapsedMs >= 0 &&
          finished.response,
        'Mismatched native response',
      );
    attempts.push({
      planHash: plan.planHash,
      caseId: row.caseId,
      arm: row.arm,
      promptHash: row.promptHash,
      workerElapsedMs: finished?.workerElapsedMs ?? null,
      response: finished?.response ?? {
        status: 'unavailable',
        attempted: true,
        requestedModel: plan.options.model,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        inputAccounting: 'includes-cache',
        durationMs: 0,
        responseReceived: false,
        error: 'interrupted-unknown-charge',
      },
    });
    if (!finished) {
      assert(events.length === 0, 'Unfinished request cannot have later events');
      break;
    }
  }
  if (events[0]?.kind === 'closed') {
    const closing = events.shift();
    assert(
      closing?.planHash === plan.planHash &&
        ['completed', 'uncertain-charge-or-response'].includes(closing.stopReason ?? '') &&
        (closing.stopReason !== 'completed' || attempts.length === plan.rows.length),
      'Invalid journal closing event',
    );
  }
  assert(events.length === 0, 'Unexpected journal event beyond plan');
  return attempts;
}

/** Explicit CLI: no auto-resume, and STUDY_API_KEY is read only from the process environment. */
async function cli(args: string[]): Promise<void> {
  const [action, planPath, journalPath, approvalPath, methodologyPath] = args;
  assert(
    action === 'run' &&
      args.length === 5 &&
      [planPath, journalPath, approvalPath, methodologyPath].every((file) =>
        Boolean(file && path.isAbsolute(file)),
      ),
    'Usage: workflow-study-runner.mts run <absolute-plan> <absolute-journal> <absolute-approval> <absolute-methodology>',
  );
  const plan = JSON.parse(await readFile(planPath, 'utf8'));
  await runStudy(plan, {
    baseUrl: plan.options.baseUrl,
    apiKey: process.env.STUDY_API_KEY ?? '',
    journalPath,
    independentApprovalPath: approvalPath,
    methodologyPath,
  });
  process.stdout.write(JSON.stringify({ planHash: plan.planHash, journalPath }) + '\n');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  cli(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : 'Study error');
    process.exitCode = 1;
  });
