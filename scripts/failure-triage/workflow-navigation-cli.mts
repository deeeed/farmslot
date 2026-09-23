/** Explicit study commands. Only `advice` and `worker` can call a model. */
import { createHash } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createLlmAssessmentProvider } from '../../services/gateway/src/assessment/llm.js';
import { createTypeSafeProvider } from '../../services/gateway/src/assessment/typesafe.js';
import {
  adviceReservation,
  generateNavigationAdvice,
  sealAdvicePlan,
  type AdviceConfig,
  type NavigationAdviceResult,
} from './workflow-navigation-advice.mts';
import {
  runNavigationStudy,
  reservation,
  type RunnerConfig,
} from './workflow-navigation-runner.mts';
import {
  advance,
  blindReviewRows,
  nextPrompt,
  startSession,
  blindReviewPacketHash,
  compareSessions,
  navigationReferenceHash,
  sealPlan,
  verifyPlan,
  type NavigationAdvice,
  type NavigationCase,
  type NavigationPlan,
  type NavigationReference,
  type BlindJudgment,
  type Session,
} from './workflow-navigation.mts';

const load = async <T,>(file: string): Promise<T> => JSON.parse(await readFile(file, 'utf8'));
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function save(file: string, value: unknown) {
  const target = await open(file, 'wx', 0o600);
  try {
    await target.writeFile(JSON.stringify(value, null, 2) + '\n');
    await target.sync();
  } finally {
    await target.close();
  }
}
function fail(message: string): never {
  throw new Error(message);
}

export async function main([command, ...args]: string[]): Promise<void> {
  if (command === 'seal-advice' && args.length === 2) {
    const [casesPath, output] = args;
    return save(output, sealAdvicePlan(await load<NavigationCase[]>(casesPath)));
  }
  if (command === 'seal-worker' && args.length === 6) {
    const [casesPath, advicePlanPath, advicePath, journalPath, referencePath, output] = args;
    const cases = await load<NavigationCase[]>(casesPath);
    const advicePlan = await load<ReturnType<typeof sealAdvicePlan>>(advicePlanPath);
    const result = await load<NavigationAdviceResult>(advicePath);
    const journalBytes = await readFile(journalPath);
    const events = journalBytes
      .toString('utf8')
      .trim()
      .split('\n')
      .map((row) => JSON.parse(row));
    const first = events[0];
    const closed = events.at(-1);
    if (
      result.stopReason !== 'completed' ||
      result.advicePlanHash !== advicePlan.hash ||
      JSON.stringify(sealAdvicePlan(cases)) !== JSON.stringify(advicePlan) ||
      result.journalSha256 !== sha(journalBytes) ||
      first?.kind !== 'approved' ||
      first.planHash !== advicePlan.hash ||
      first.configHash !== result.configHash ||
      first.config?.provider !== result.provider ||
      first.config?.model !== result.model ||
      !/^[a-f0-9]{64}$/.test(first.methodologyHash) ||
      closed?.kind !== 'closed' ||
      closed.planHash !== advicePlan.hash ||
      closed.stopReason !== 'completed' ||
      closed.attempts !== cases.length
    )
      fail('Advice provenance does not match approved, completed journal');
    const starts = events.filter((row) => row.kind === 'started');
    const finished = events.filter((row) => row.kind === 'finished');
    if (
      events.length !== 2 + cases.length * 2 ||
      starts.length !== cases.length ||
      finished.length !== cases.length ||
      result.advice.length !== cases.length ||
      cases.some(
        (item, index) =>
          starts[index].caseId !== item.id ||
          finished[index].caseId !== item.id ||
          result.advice[index].caseId !== item.id ||
          JSON.stringify(finished[index].receipt) !==
            JSON.stringify(result.advice[index].receipt) ||
          finished[index].text !== result.advice[index].text,
      )
    )
      fail('Advice result differs from journal receipts');
    const reference = await load<NavigationReference>(referencePath);
    return save(
      output,
      sealPlan(
        cases,
        result.advice,
        { maxTurns: 3, maxReads: 2 },
        {
          referenceHash: navigationReferenceHash(reference),
          adviceProvenance: {
            advicePlanHash: result.advicePlanHash,
            configHash: result.configHash,
            provider: result.provider,
            model: result.model,
            journalSha256: result.journalSha256,
            methodologyHash: first.methodologyHash,
          },
        },
      ),
    );
  }
  if (command === 'quote-advice' && args.length === 2) {
    const [planPath, configPath] = args;
    const plan = await load<ReturnType<typeof sealAdvicePlan>>(planPath);
    const quote = adviceReservation(plan, await load<AdviceConfig>(configPath));
    console.log(JSON.stringify({ planHash: plan.hash, ...quote }, null, 2));
    return;
  }
  if (command === 'quote-worker' && args.length === 2) {
    const [planPath, configPath] = args;
    const plan = await load<NavigationPlan>(planPath);
    const quote = reservation(plan, await load<RunnerConfig>(configPath));
    console.log(JSON.stringify({ planHash: plan.hash, ...quote }, null, 2));
    return;
  }
  if (command === 'advice' && args.length === 6) {
    const [planPath, configPath, method, approval, journal, output] = args;
    const config = await load<AdviceConfig>(configPath);
    const plan = await load<ReturnType<typeof sealAdvicePlan>>(planPath);
    adviceReservation(plan, config);
    const provider =
      config.provider === 'typesafe'
        ? createTypeSafeProvider()
        : config.provider === 'llm-response' && config.baseUrl
          ? createLlmAssessmentProvider({
              id: 'llm-response',
              credentialEnv: 'STUDY_API_KEY',
              defaultModel: config.model,
              baseUrl: config.baseUrl,
            })
          : fail('Configured advice provider is unavailable');
    const key =
      process.env[provider.credentialEnv] ??
      process.env.STUDY_API_KEY ??
      fail(`${provider.credentialEnv} or STUDY_API_KEY is required for advice calls`);
    const result = await generateNavigationAdvice(
      plan,
      config,
      { methodologyPath: method, approvalPath: approval, journalPath: journal, apiKey: key },
      provider,
    );
    await save(output, result);
    return;
  }
  if (command === 'worker' && args.length === 6) {
    const [planPath, configPath, method, approval, journal, output] = args;
    const plan = await load<NavigationPlan>(planPath);
    const config = await load<RunnerConfig>(configPath);
    reservation(plan, config);
    const key = process.env.STUDY_API_KEY ?? fail('STUDY_API_KEY is required for live calls');
    const result = await runNavigationStudy(plan, config, {
      methodologyPath: method,
      approvalPath: approval,
      journalPath: journal,
      apiKey: key,
    });
    await save(output, result);
    return;
  }
  if (command === 'blind' && args.length === 3) {
    const [planPath, sessionsPath, output] = args;
    const plan = await load<NavigationPlan>(planPath);
    verifyPlan(plan);
    const result = await load<{ sessions: Session[] }>(sessionsPath);
    return save(output, {
      version: 1,
      planHash: plan.hash,
      hash: blindReviewPacketHash(plan, result.sessions),
      rows: blindReviewRows(plan, result.sessions),
    });
  }
  if (command === 'score' && args.length === 8) {
    const [
      planPath,
      sessionsPath,
      referencePath,
      blindPath,
      judgmentPath,
      methodPath,
      workerJournalPath,
      output,
    ] = args;
    const plan = await load<NavigationPlan>(planPath);
    const result = await load<{
      sessions: Session[];
      stopReason: string;
      planHash: string;
      configHash: string;
      provider: string;
      model: string;
      methodologyHash: string;
      journalSha256: string;
    }>(sessionsPath);
    const referenceBytes = await readFile(referencePath);
    const reference: NavigationReference = JSON.parse(referenceBytes.toString('utf8'));
    const blind = await load<{ version: number; planHash: string; hash: string; rows: unknown[] }>(
      blindPath,
    );
    const judgment = await load<BlindJudgment>(judgmentPath);
    const methodHash = sha(await readFile(methodPath));
    const journalBytes = await readFile(workerJournalPath);
    const journal = journalBytes
      .toString('utf8')
      .trim()
      .split('\n')
      .map((row) => JSON.parse(row));
    // Consume the log in write order. A failed attempt has no turn in the session,
    // so counting only finished turns would silently discard its charge and cause.
    let cursor = 1;
    let attempts = 0;
    let failed = false;
    let journalMatchesSessions = true;
    for (const [index, session] of result.sessions.entries()) {
      const item = plan.cases[Math.floor(index / 2)];
      const expectedArm =
        Math.floor(index / 2) % 2
          ? index % 2
            ? 'baseline'
            : 'assisted'
          : index % 2
            ? 'assisted'
            : 'baseline';
      if (!item || session.caseId !== item.id || session.arm !== expectedArm || failed) {
        journalMatchesSessions = false;
        break;
      }
      let replay = startSession(plan, session.caseId, session.arm);
      for (const turn of session.turns) {
        const started = journal[cursor++];
        const finished = journal[cursor++];
        attempts++;
        if (
          started?.kind !== 'started' ||
          started.caseId !== session.caseId ||
          started.arm !== session.arm ||
          started.turn !== turn.number ||
          started.promptHash !== sha(nextPrompt(plan, replay)) ||
          finished?.kind !== 'finished' ||
          finished.caseId !== session.caseId ||
          finished.arm !== session.arm ||
          finished.turn !== turn.number ||
          finished.promptHash !== started.promptHash ||
          JSON.stringify(finished.action) !== JSON.stringify(turn.action) ||
          JSON.stringify(finished.receipt) !== JSON.stringify(turn.receipt)
        ) {
          journalMatchesSessions = false;
          break;
        }
        const advanced = advance(plan, replay, turn.action, turn.receipt);
        replay = advanced.session;
        if (finished.status !== replay.status || finished.evidenceId !== advanced.evidence?.id) {
          journalMatchesSessions = false;
          break;
        }
      }
      if (!journalMatchesSessions) break;
      const pending = journal[cursor];
      if (pending?.kind === 'started') {
        attempts++;
        cursor++;
        const failure = journal[cursor++];
        const recordedCharge = failure?.costUsd;
        const knownCharge =
          typeof recordedCharge === 'number' &&
          Number.isFinite(recordedCharge) &&
          recordedCharge >= 0;
        const transport = failure?.reason === 'transport-unknown-charge';
        if (
          index !== result.sessions.length - 1 ||
          replay.status !== 'active' ||
          pending.caseId !== session.caseId ||
          pending.arm !== session.arm ||
          pending.turn !== replay.turns.length + 1 ||
          pending.promptHash !== sha(nextPrompt(plan, replay)) ||
          failure?.kind !== 'failed' ||
          failure.caseId !== session.caseId ||
          failure.arm !== session.arm ||
          failure.turn !== pending.turn ||
          typeof failure.reason !== 'string' ||
          !failure.reason ||
          (transport
            ? result.stopReason !== 'unknown-charge' ||
              Object.keys(failure).sort().join(',') !== 'arm,caseId,kind,reason,turn'
            : typeof failure.responseReceived !== 'boolean' ||
              !Number.isFinite(failure.durationMs) ||
              failure.durationMs < 0 ||
              ![
                failure.inputTokens,
                failure.outputTokens,
                failure.cacheReadTokens,
                failure.cacheWriteTokens,
              ].every((value) => value === null || (Number.isSafeInteger(value) && value >= 0)) ||
              (failure.httpStatus !== undefined && !Number.isInteger(failure.httpStatus)) ||
              (failure.responseId !== undefined && typeof failure.responseId !== 'string') ||
              (failure.receiptHash !== undefined && typeof failure.receiptHash !== 'string') ||
              (recordedCharge !== null && !knownCharge) ||
              result.stopReason !==
                (knownCharge
                  ? failure.reason === 'invalid-action'
                    ? 'invalid-action'
                    : 'unverified-response'
                  : 'unknown-charge'))
        ) {
          journalMatchesSessions = false;
          break;
        }
        failed = true;
      }
      const closed = journal[cursor++];
      if (
        closed?.kind !== 'session-closed' ||
        closed.caseId !== session.caseId ||
        closed.arm !== session.arm ||
        closed.status !== session.status ||
        closed.turnCount !== session.turns.length ||
        closed.wallElapsedMs !== session.wallElapsedMs
      ) {
        journalMatchesSessions = false;
        break;
      }
    }
    journalMatchesSessions &&=
      cursor === journal.length - 1 &&
      journal.at(-1)?.attempts === attempts &&
      (result.stopReason === 'completed'
        ? !failed && result.sessions.length === plan.cases.length * 2
        : failed);
    // Validation ran before the call. Recompute its stable hash here; a price
    // quote expiring after seven days must not invalidate a historical score.
    if (
      !journalMatchesSessions ||
      result.planHash !== plan.hash ||
      result.methodologyHash !== methodHash ||
      result.journalSha256 !== sha(journalBytes) ||
      journal[0]?.configHash !== result.configHash ||
      journal[0]?.config?.provider !== result.provider ||
      journal[0]?.config?.model !== result.model ||
      sha(JSON.stringify(journal[0].config)) !== result.configHash ||
      blind.version !== 1 ||
      blind.planHash !== plan.hash ||
      blind.hash !== blindReviewPacketHash(plan, result.sessions) ||
      JSON.stringify(blind.rows) !== JSON.stringify(blindReviewRows(plan, result.sessions)) ||
      judgment.packetHash !== blind.hash ||
      judgment.methodologyHash !== methodHash ||
      journal[0]?.kind !== 'approved' ||
      journal[0]?.planHash !== plan.hash ||
      journal[0]?.methodologyHash !== methodHash ||
      journal.at(-1)?.kind !== 'closed' ||
      journal.at(-1)?.planHash !== plan.hash ||
      journal.at(-1)?.stopReason !== result.stopReason
    )
      fail('Review packet, method, or worker journal does not match sealed study');
    const comparison = compareSessions(plan, result.sessions, reference, judgment);
    const decision =
      result.stopReason !== 'completed'
        ? 'inconclusive'
        : comparison.regressions > 0
          ? 'hold'
          : comparison.completeMetricsPairs === comparison.denominator
            ? 'exploratory-complete'
            : 'inconclusive';
    return save(output, {
      kind: 'exploratory-synthetic-navigation',
      decision,
      stopReason: result.stopReason,
      referenceFileSha256: sha(referenceBytes),
      workerProvider: result.provider,
      workerModel: result.model,
      workerConfigHash: result.configHash,
      workerMethodologyHash: result.methodologyHash,
      workerJournalSha256: result.journalSha256,
      ...comparison,
    });
  }
  fail(
    'Usage: seal-advice cases out | quote-advice plan config | advice plan config method approval journal out | seal-worker cases advice-plan advice-result advice-journal reference out | quote-worker plan config | worker plan config method approval journal out | blind plan sessions out | score plan sessions reference blind judgment method worker-journal out',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main(process.argv.slice(2));
