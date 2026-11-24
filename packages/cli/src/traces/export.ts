// ADR-039 Amendment 10: `farmslot runs traces export`. Offline, on the gateway host: reads the
// gateway's stores read-only and writes only the export directory. Never invents a value.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { resolveReportedFarmPaths } from '@farmslot/protocol/node/farm-paths';
import { readRetainedTaskFileReadOnly, runBundleRetentionSettings } from '@farmslot/run-bundle';

import { grokToSessionTrace, priceCost } from './formats.js';
import { type ScrubInputs, TraceScrubber } from './scrub.js';

type Json = Record<string, unknown>;

export interface TraceExportOptions {
  out: string;
  project?: string;
  flow?: string;
  since?: string;
  until?: string;
  family?: string;
  hasGrade?: boolean;
  update?: boolean;
}

export interface TraceExportStores {
  episodes: string;
  runs: string;
  runArchive: string;
  projects: string;
  pool: string;
  bundleStoreRoot: string;
  home: string;
}

export interface TraceExportResult {
  exported: number;
  skipped: { runId: string; reason: string }[];
  transcripts: { present: number; missing: number };
}

/** The gateway's stores, as `farmslot paths --json` resolves them for the gateway role. */
export function gatewayTraceStores(env: NodeJS.ProcessEnv = process.env): TraceExportStores {
  const paths = resolveReportedFarmPaths({ role: 'gateway', env });
  const stores = {
    episodes: paths.state.episodes,
    runs: paths.state.runs,
    runArchive: paths.data.runArchive,
    projects: paths.projects,
    pool: paths.pool,
    bundleStoreRoot: runBundleRetentionSettings(paths.home).storeRoot ?? paths.data.runBundles,
    home: paths.home,
  };
  if (!existsSync(stores.episodes))
    throw new Error(
      `No gateway episode store at ${stores.episodes}. Run the export on the gateway host, with the gateway's FARMSLOT_* environment.`,
    );
  return stores;
}

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

const missing = (error: unknown) =>
  ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '');

/** A JSON file, or undefined when it does not exist; unreadable or malformed files throw. */
async function readJson(file: string): Promise<Json | undefined> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
  try {
    return JSON.parse(raw) as Json;
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${(error as Error).message}`);
  }
}

async function jsonFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((name) => name.endsWith('.json')).sort();
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
}

/** The run record, live or archived; read for grades and the retained bundle ref only. */
async function runRecord(stores: TraceExportStores, runId: string): Promise<Json | undefined> {
  return (
    (await readJson(path.join(stores.runs, `${runId}.json`))) ??
    (await readJson(path.join(stores.runs, 'archive', `${runId}.json`)))
  );
}

/** A transcript in place, or through the run archive manifest after retention moved it. */
async function transcriptBytes(
  stores: TraceExportStores,
  runId: string,
  relativeDir: string,
): Promise<Buffer | null> {
  const source = path.join(stores.runs, relativeDir, 'transcript.jsonl');
  try {
    return await readFile(source);
  } catch (error) {
    if (!missing(error)) throw error;
    const manifest = await readJson(path.join(stores.runArchive, runId, 'manifest.json'));
    const entries = (manifest?.entries as Json[] | undefined) ?? [];
    for (const entry of entries) {
      if (typeof entry.source !== 'string' || typeof entry.destination !== 'string') continue;
      if (!entry.completedAt) continue;
      const rel = path.relative(entry.source, source);
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
      try {
        return await readFile(path.join(entry.destination, rel));
      } catch (error) {
        // Archived elsewhere or gone: reported missing below.
        if (!missing(error)) throw error;
      }
    }
    return null;
  }
}

async function gradeLines(stores: TraceExportStores, runId: string): Promise<Json[]> {
  const file = path.join(stores.episodes, 'grades', `${runId}.jsonl`);
  const raw = await optionalText(file);
  // The gateway writes each grade line whole; a malformed one is an error, never skipped.
  return (raw ?? '')
    .split('\n')
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line) as Json;
      } catch {
        throw new Error(`${file}:${index + 1} is not valid JSON`);
      }
    });
}

/** The latest line per (source, grader); every line stays append-only in the store. */
function latestGrades(lines: Json[]): Json[] {
  const latest = new Map<string, Json>();
  for (const line of lines) latest.set(`${line.source}\u0000${line.grader}`, line);
  return [...latest.values()];
}

async function tracesEnabled(stores: TraceExportStores, project: string): Promise<boolean> {
  const config = await readJson(path.join(stores.projects, project, 'project.json'));
  return (config?.traces as Json | undefined)?.enabled !== false;
}

/** A file's text, or undefined when it does not exist; any other read error is raised. */
async function optionalText(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * Secret values, users and machines the scrubber removes, read from the gateway host: the
 * provider environment (`<home>/providers.env`), the node token (`<home>/node.secret`, or the
 * farm automation secrets the dev gateway uses), the LiteLLM key, and secret-named variables in
 * the exporting shell.
 */
export async function traceScrubInputs(
  stores: TraceExportStores,
  userHome = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<ScrubInputs> {
  const secretName = /(?:TOKEN|KEY|SECRET|PASSWORD|DSN)$/;
  const secretValues = Object.entries(env)
    .filter(([name, value]) => secretName.test(name) && value && value.length >= 8)
    .map(([, value]) => value!);
  // Every value in the private provider environment file is treated as a secret.
  const providers = await optionalText(path.join(stores.home, 'providers.env'));
  for (const line of providers?.split('\n') ?? []) {
    const match = /^\s*(?:export\s+)?[A-Za-z0-9_]+\s*=\s*["']?([^"'\n]+?)["']?\s*$/.exec(line);
    if (match && match[1]!.length >= 8) secretValues.push(match[1]!);
  }
  const automationDir = path.join(userHome, '.farmslot-automation');
  const automation = existsSync(automationDir)
    ? (await readdir(automationDir))
        .filter((name) => name.endsWith('.secret'))
        .map((name) => path.join(automationDir, name))
    : [];
  for (const file of [
    path.join(stores.home, 'node.secret'),
    path.join(userHome, '.config', 'litellm', 'api-key'),
    ...automation,
  ]) {
    const value = (await optionalText(file))?.trim();
    if (value && value.length >= 8) secretValues.push(value);
  }
  const usernames = new Set([os.userInfo().username]);
  const machines = new Set<string>();
  for (const name of await jsonFiles(stores.pool)) {
    const pool = await readJson(path.join(stores.pool, name));
    if (typeof pool?.machine === 'string') machines.add(pool.machine);
    for (const value of [pool?.sshTarget, pool?.ssh_target, pool?.host]) {
      if (typeof value === 'string' && value.includes('@')) usernames.add(value.split('@')[0]!);
    }
  }
  return { secretValues, usernames: [...usernames], machines: [...machines] };
}

interface Selected {
  episode: Json;
  runId: string;
}

async function selectEpisodes(
  stores: TraceExportStores,
  options: TraceExportOptions,
  skipped: TraceExportResult['skipped'],
): Promise<Selected[]> {
  const selected: Selected[] = [];
  for (const name of await jsonFiles(stores.episodes)) {
    let episode: Json | undefined;
    try {
      episode = await readJson(path.join(stores.episodes, name));
    } catch (error) {
      skipped.push({ runId: name.replace(/\.json$/, ''), reason: (error as Error).message });
      continue;
    }
    if (!episode || episode.schema !== 'farmslot-episode-v1') continue;
    const runId = String(episode.runId);
    const ended = String(episode.runUpdatedAt ?? episode.capturedAt ?? '');
    const labels = (episode.labels ?? {}) as Json;
    const familyId = ((labels.task ?? {}) as Json).familyId;
    if (options.project && episode.project !== options.project) continue;
    if (options.flow && episode.flowType !== options.flow) continue;
    if (options.since && ended < options.since) continue;
    if (options.until && ended > options.until) continue;
    if (options.family && familyId !== options.family) continue;
    if (options.hasGrade && !(await gradeLines(stores, runId)).length) continue;
    if (!(await tracesEnabled(stores, String(episode.project)))) {
      skipped.push({ runId, reason: 'project opted out (traces.enabled: false)' });
      continue;
    }
    selected.push({ episode, runId });
  }
  return selected;
}

/** Builds (or with `update`, refreshes) a redacted dataset directory from a run filter. */
/** ISO bounds; a date-only `until` covers the whole day. */
export function normalizeTraceRange(options: Pick<TraceExportOptions, 'since' | 'until'>) {
  const bound = (value: string | undefined, name: string, endOfDay: boolean) => {
    if (value === undefined) return undefined;
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
    const parsed = Date.parse(dateOnly && endOfDay ? `${value}T23:59:59.999Z` : value);
    if (Number.isNaN(parsed))
      throw new Error(`--${name} must be an ISO date or timestamp: ${value}`);
    return new Date(parsed).toISOString();
  };
  return {
    since: bound(options.since, 'since', false),
    until: bound(options.until, 'until', true),
  };
}

export async function exportRunTraces(
  options: TraceExportOptions,
  stores: TraceExportStores = gatewayTraceStores(),
): Promise<TraceExportResult> {
  options = { ...options, ...normalizeTraceRange(options) };
  const out = path.resolve(options.out);
  if (existsSync(out) && (await readdir(out)).length && !options.update)
    throw new Error(`${out} is not empty; pass --update to refresh an existing export`);
  await mkdir(path.join(out, 'runs'), { recursive: true });
  const scrubInputs = await traceScrubInputs(stores);
  const skipped: TraceExportResult['skipped'] = [];
  const selected = await selectEpisodes(stores, options, skipped);
  const totals = { present: 0, missing: 0 };
  const runIndex = new Map<string, Json>();
  // `--update` keeps the index rows of runs exported earlier that no longer match the filter.
  if (options.update) {
    const indexFile = path.join(out, 'index.jsonl');
    for (const [index, line] of ((await optionalText(indexFile)) ?? '').split('\n').entries()) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as Json;
        runIndex.set(String(row.runId), row);
      } catch {
        throw new Error(`${indexFile}:${index + 1} is not valid JSON`);
      }
    }
  }

  const allCounts: Record<string, number> = {};

  for (const { episode, runId } of selected) {
    const scrubber = new TraceScrubber(scrubInputs);
    const runDir = path.join(out, 'runs', scrubber.name(runId));
    await mkdir(path.join(runDir, 'transcripts'), { recursive: true });
    const record = await runRecord(stores, runId);
    const labels = structuredClone((episode.labels ?? {}) as Json);
    const roles = (labels.roles as Json[] | undefined) ?? [];
    const modelOf = (contextId: unknown) =>
      (roles.find((role) => role.contextId === contextId)?.model as string | null) ?? null;
    if (Array.isArray(labels.cost))
      labels.cost = (labels.cost as Json[]).map((cost) =>
        priceCost(
          {
            ...cost,
            inputTokens: (cost.inputTokens as number | null) ?? null,
            outputTokens: (cost.outputTokens as number | null) ?? null,
            cacheReadTokens: (cost.cacheReadTokens as number | null) ?? null,
            usd: (cost.usd as number | null) ?? null,
            usdSource: (cost.usdSource as 'recorded' | null) ?? null,
          },
          modelOf(cost.contextId),
        ),
      );

    // Transcripts, one per captured session.
    const transcripts: Json[] = [];
    let unmapped = 0;
    for (const agent of ((episode.trajectory as Json | undefined)?.agents as Json[]) ?? []) {
      const sessions = (agent.sessions as Json[] | undefined) ?? [];
      for (const session of sessions) {
        const key = String(session.sessionKey ?? 'session');
        const label = { contextId: agent.contextId, sessionKey: key, runner: agent.runner };
        if (session.status === 'unsupported') {
          transcripts.push({ ...label, status: 'unsupported' });
          continue;
        }
        const bytes =
          session.status === 'captured' && typeof session.relativeDir === 'string'
            ? await transcriptBytes(stores, runId, session.relativeDir)
            : null;
        if (!bytes) {
          transcripts.push({
            ...label,
            status: 'missing',
            reason:
              session.status === 'captured' ? 'not found in the stores' : String(session.status),
          });
          totals.missing += 1;
          continue;
        }
        if (typeof session.sha256 === 'string' && sha256(bytes) !== session.sha256) {
          transcripts.push({ ...label, status: 'sha256-mismatch' });
          totals.missing += 1;
          continue;
        }
        let lines = bytes.toString('utf8').split('\n');
        if (agent.runner === 'grok') {
          const converted = grokToSessionTrace({
            lines,
            runId,
            sessionId: key,
            runner: String(agent.runner),
          });
          lines = converted.lines;
          unmapped += converted.unmapped;
        }
        const file = scrubber.name(`${agent.contextId}-${key}.jsonl`);
        const target = path.join(runDir, 'transcripts', file);
        // Written every time, --update included: a recaptured transcript replaces its old copy
        // and the redaction counts cover every exported file.
        await writeFile(target, scrubber.text(lines.join('\n')));
        transcripts.push({ ...label, status: 'present', file, bytes: bytes.byteLength });
        totals.present += 1;
      }
    }

    // The graded diff, kept beside the episode.
    const output = labels.output as Json | null | undefined;
    if (output && typeof output.path === 'string') {
      try {
        const diff = await readFile(path.join(stores.episodes, output.path));
        if (sha256(diff) === output.diffSha256)
          await writeFile(path.join(runDir, 'output.diff'), scrubber.text(diff.toString('utf8')));
      } catch {
        // Not retained: labels.output still names its sha256 and size.
      }
    }

    // TASK.md from the retained bundle, read without opening the store.
    const bundle = record?.artifactBundle as Json | undefined;
    let taskError: string | undefined;
    if (bundle && typeof bundle.bundleDigest === 'string' && typeof bundle.taskKey === 'string') {
      const task = await readRetainedTaskFileReadOnly({
        storeRoot: stores.bundleStoreRoot,
        bundleDigest: bundle.bundleDigest,
        taskKey: bundle.taskKey,
        relativePath: 'TASK.md',
      }).catch((error: unknown) => {
        taskError = (error as Error).message;
        return null;
      });
      if (task) await writeFile(path.join(runDir, 'task.md'), scrubber.text(task.toString('utf8')));
    }

    // Interviews.
    const interviewDir = path.join(stores.episodes, 'interviews', runId);
    if (existsSync(interviewDir)) {
      await mkdir(path.join(runDir, 'interviews'), { recursive: true });
      for (const name of (await readdir(interviewDir)).filter((entry) => !entry.startsWith('.')))
        await writeFile(
          path.join(runDir, 'interviews', scrubber.name(name)),
          scrubber.text(await readFile(path.join(interviewDir, name), 'utf8')),
        );
    }

    const grades = latestGrades(await gradeLines(stores, runId));
    await writeFile(
      path.join(runDir, 'labels.json'),
      `${scrubber.text(
        JSON.stringify({
          runId,
          project: episode.project,
          flowType: episode.flowType,
          status: episode.status,
          labels,
          transcripts,
          ...(taskError ? { taskError } : {}),
          externalGrades: grades,
          grade: record?.grade ?? null,
          humanGrade: record?.humanGrade ?? null,
        }),
      )}\n`,
    );
    const counts = { ...scrubber.report(), ...(unmapped ? { unmapped } : {}) };
    for (const [rule, n] of Object.entries(counts)) allCounts[rule] = (allCounts[rule] ?? 0) + n;
    await writeFile(path.join(runDir, 'redaction.json'), `${JSON.stringify(counts, null, 2)}\n`);
    const outcome = (labels as Json).outcome ?? null;
    runIndex.set(runId, {
      runId,
      project: episode.project,
      flow: episode.flowType,
      status: episode.status,
      outcome,
      infraOnly: (labels as Json).infraOnly ?? null,
      grades: grades.map((grade) => ({
        source: grade.source,
        grader: grade.grader,
        verdict: grade.verdict,
      })),
      transcripts: {
        present: transcripts.filter((entry) => entry.status === 'present').length,
        missing: transcripts
          .filter((entry) => entry.status !== 'present' && entry.status !== 'unsupported')
          .map((entry) => ({
            contextId: entry.contextId,
            sessionKey: entry.sessionKey,
            reason: entry.reason ?? entry.status,
          })),
      },
      bytes: transcripts.reduce((sum, entry) => sum + (Number(entry.bytes) || 0), 0),
    });
  }

  // The index and README carry run ids, session keys, reasons and the filter: scrubbed too.
  const indexScrubber = new TraceScrubber(scrubInputs);
  await writeFile(
    path.join(out, 'index.jsonl'),
    indexScrubber.text(
      [...runIndex.values()].map((row) => JSON.stringify(row)).join('\n') +
        (runIndex.size ? '\n' : ''),
    ),
  );
  await writeFile(
    path.join(out, 'README.md'),
    indexScrubber.text(
      [
        '# Farmslot run traces (private)',
        '',
        'Local only. Redaction is a best-effort backstop: review before sharing, even internally.',
        '',
        `Filter: ${JSON.stringify({ project: options.project, flow: options.flow, since: options.since, until: options.until, family: options.family, hasGrade: options.hasGrade ?? false })}`,
        `Runs in index: ${runIndex.size}; exported this time: ${selected.length}`,
        `Transcripts present: ${totals.present}; missing: ${totals.missing}`,
        'Redaction rules: secret-value, publication-pattern, private-key, dsn, email, secret-variable, username, home-path, machine',
        `Redactions this time: ${JSON.stringify(allCounts)}`,
        ...(skipped.length
          ? ['', 'Skipped:', ...skipped.map((entry) => `- ${entry.runId}: ${entry.reason}`)]
          : []),
        '',
      ].join('\n'),
    ),
  );
  return { exported: selected.length, skipped, transcripts: totals };
}
