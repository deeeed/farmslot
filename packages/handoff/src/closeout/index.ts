import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  assembleLearningPackage,
  type AssembleResult,
  type LearningPackageInput,
  type RunMeta,
  writeLearningPackage,
  type WriteResult,
} from '../learning-package/index.js';
import type { ManifestTask, ResolutionSource, RunOutcome, SourceDocument } from '../spec/types.js';
import { validateLearningPackage } from '../validate/index.js';

const CONFIG_RELATIVE_PATH = path.join('handoff', 'learning.config.json');
const METADATA_RELATIVE_PATH = path.join('inputs', 'handoff.json');
const SIGNAL_RELATIVE_PATH = 'SIGNAL.json';

export interface LearningConfig {
  schemaVersion: 1;
  destination?: string;
}

export interface CloseoutMetadata {
  schemaVersion: 1;
  attemptId: string;
  surface: string;
  project: string;
  repo?: string;
  domain: string;
  flow: string;
  startedAt: string;
  task: ManifestTask;
  source?: Partial<Omit<SourceDocument, 'schemaVersion' | 'sourceKind'>>;
  taskDocument: string;
  report: string;
  learnings: string;
  model?: string;
}

interface TerminalSignal {
  status?: string;
  outcome?: string;
  timestamp?: string;
  evidence?: {
    reportPath?: string;
  };
}

export interface CloseoutOptions {
  taskDir: string;
  configPath?: string;
  destination?: string;
  metadataPath?: string;
  share?: boolean;
}

export type CloseoutResult =
  | {
      status: 'blocked';
      quarantineDir: string;
      scrubReport: AssembleResult['scrubReport'];
    }
  | {
      status: 'staged';
      packageDir: string;
      wouldWritePath: string;
      indexRows: Extract<WriteResult, { status: 'dry-run' }>['indexRows'];
    }
  | {
      status: 'already-shared';
      packageDir: string;
      destinationPath: string;
      wouldWritePath: string;
      pushed: boolean;
      pushError?: string;
    }
  | {
      status: 'written';
      packageDir: string;
      destinationPath: string;
      commitSha: string;
      pushed: boolean;
      pushError?: string;
    };

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function readJson(file: string, label: string): Record<string, unknown> {
  if (!existsSync(file)) throw new Error(`${label} not found at ${file}.`);
  try {
    return requireObject(JSON.parse(readFileSync(file, 'utf8')), label);
  } catch (error) {
    throw new Error(`${label} at ${file} is invalid (${(error as Error).message}).`);
  }
}

function requireString(
  value: unknown,
  label: string,
  options: { allowEmpty?: boolean } = {},
): string {
  if (typeof value !== 'string' || (!options.allowEmpty && value.trim() === '')) {
    throw new Error(`${label} must be ${options.allowEmpty ? 'a string' : 'a non-empty string'}.`);
  }
  return value;
}

function requireSchemaVersion(value: unknown, label: string): asserts value is 1 {
  if (value !== 1) throw new Error(`${label}.schemaVersion must equal 1.`);
}

function portableRepoIdentity(value: string): string | undefined {
  const trimmed = value.trim();
  let pathname: string;
  try {
    const url = new URL(trimmed);
    if (!['http:', 'https:', 'ssh:', 'git:'].includes(url.protocol)) return undefined;
    pathname = url.pathname;
  } catch {
    const scp = trimmed.match(/^(?:[^@/\s]+@)?[^:/\s]+:(.+)$/u);
    if (scp) {
      pathname = scp[1];
    } else if (/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+$/u.test(trimmed)) {
      pathname = trimmed;
    } else {
      return undefined;
    }
  }
  const identity = pathname.replace(/^\/+|\/+$/gu, '').replace(/\.git$/iu, '');
  const segments = identity.split('/');
  return segments.length > 0 &&
    segments.every(
      (segment) =>
        segment !== '.' && segment !== '..' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(segment),
    )
    ? identity
    : undefined;
}

function parseConfig(file: string): LearningConfig {
  if (!existsSync(file)) return { schemaVersion: 1 };
  const value = readJson(file, 'learning config');
  requireSchemaVersion(value.schemaVersion, 'learning config');
  return {
    schemaVersion: 1,
    ...(value.destination === undefined
      ? {}
      : { destination: requireString(value.destination, 'learning config.destination') }),
  };
}

function parseTask(value: unknown): ManifestTask {
  const task = requireObject(value, 'handoff metadata.task');
  const sourceKind = requireString(task.sourceKind, 'handoff metadata.task.sourceKind');
  if (!['text', 'file', 'github-pr', 'github-issue', 'jira'].includes(sourceKind)) {
    throw new Error(
      'handoff metadata.task.sourceKind must be text, file, github-pr, github-issue, or jira.',
    );
  }
  const sourceRef =
    task.sourceRef === undefined
      ? undefined
      : requireString(task.sourceRef, 'handoff metadata.task.sourceRef');
  return {
    title: requireString(task.title, 'handoff metadata.task.title'),
    sourceKind: sourceKind as ManifestTask['sourceKind'],
    ...(task.ticket === undefined
      ? {}
      : { ticket: requireString(task.ticket, 'handoff metadata.task.ticket') }),
    ...(sourceKind === 'file' || sourceRef === undefined ? {} : { sourceRef }),
  };
}

function parseMetadata(file: string): CloseoutMetadata {
  const value = readJson(file, 'handoff metadata');
  requireSchemaVersion(value.schemaVersion, 'handoff metadata');
  const source =
    value.source === undefined
      ? undefined
      : (requireObject(value.source, 'handoff metadata.source') as CloseoutMetadata['source']);
  if (source !== undefined && value.task !== undefined) {
    const task = requireObject(value.task, 'handoff metadata.task');
    if (task.sourceKind === 'file') delete source.sourceRef;
  }
  const repo =
    value.repo === undefined
      ? undefined
      : portableRepoIdentity(requireString(value.repo, 'handoff metadata.repo'));
  return {
    schemaVersion: 1,
    attemptId: requireString(value.attemptId, 'handoff metadata.attemptId'),
    surface: requireString(value.surface, 'handoff metadata.surface'),
    project: requireString(value.project, 'handoff metadata.project'),
    ...(repo === undefined ? {} : { repo }),
    domain: requireString(value.domain, 'handoff metadata.domain', { allowEmpty: true }),
    flow: requireString(value.flow, 'handoff metadata.flow'),
    startedAt: requireString(value.startedAt, 'handoff metadata.startedAt'),
    task: parseTask(value.task),
    ...(source === undefined ? {} : { source }),
    taskDocument: requireString(value.taskDocument, 'handoff metadata.taskDocument'),
    report: requireString(value.report, 'handoff metadata.report'),
    learnings: requireString(value.learnings, 'handoff metadata.learnings'),
    ...(value.model === undefined
      ? {}
      : { model: requireString(value.model, 'handoff metadata.model') }),
  };
}

function parseSignal(file: string): TerminalSignal {
  const value = readJson(file, 'terminal signal');
  const evidence =
    value.evidence === undefined
      ? undefined
      : requireObject(value.evidence, 'terminal signal.evidence');
  return {
    ...(value.status === undefined ? {} : { status: String(value.status) }),
    ...(value.outcome === undefined ? {} : { outcome: String(value.outcome) }),
    ...(value.timestamp === undefined ? {} : { timestamp: String(value.timestamp) }),
    ...(evidence?.reportPath === undefined
      ? {}
      : {
          evidence: {
            reportPath: requireString(evidence.reportPath, 'terminal signal.evidence.reportPath'),
          },
        }),
  };
}

function terminalOutcome(signal: TerminalSignal): RunOutcome {
  if (signal.status !== 'complete') {
    throw new Error(
      `task is not complete (SIGNAL.json status is ${JSON.stringify(signal.status)}). ` +
        'Next: finish the checklist and run ./mark complete before closeout.',
    );
  }
  if (!['success', 'failed', 'aborted', 'partial'].includes(signal.outcome ?? '')) {
    throw new Error(
      `SIGNAL.json outcome ${JSON.stringify(signal.outcome)} is not a Learning Package outcome.`,
    );
  }
  return signal.outcome as RunOutcome;
}

function resolveInside(root: string, relative: string, label: string): string {
  if (path.isAbsolute(relative)) {
    throw new Error(`${label} must be task-relative, got ${relative}.`);
  }
  const resolved = path.resolve(root, relative);
  const relation = path.relative(root, resolved);
  if (relation === '..' || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    throw new Error(`${label} escapes the task directory: ${relative}.`);
  }
  if (!existsSync(resolved)) throw new Error(`${label} not found at ${resolved}.`);
  if (!lstatSync(resolved).isFile())
    throw new Error(`${label} must be a regular file: ${resolved}.`);
  const real = realpathSync(resolved);
  const realRelation = path.relative(root, real);
  if (
    realRelation === '..' ||
    realRelation.startsWith(`..${path.sep}`) ||
    path.isAbsolute(realRelation)
  ) {
    throw new Error(`${label} resolves outside the task directory: ${relative}.`);
  }
  return real;
}

function ensureTaskStagingRoot(taskDir: string, stagingRoot: string, create: boolean): string {
  if (!existsSync(stagingRoot)) {
    if (!create) return stagingRoot;
    mkdirSync(stagingRoot);
  }
  if (!lstatSync(stagingRoot).isDirectory()) {
    throw new Error(
      `task staging root must be a real directory inside the task: ${stagingRoot}. ` +
        'Next: remove the non-directory or symlink at .handoff, then stage again.',
    );
  }
  const real = realpathSync(stagingRoot);
  const relation = path.relative(taskDir, real);
  if (relation === '..' || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    throw new Error(
      `task staging root resolves outside the task directory: ${stagingRoot}. ` +
        'Next: remove the redirected .handoff path, then stage again.',
    );
  }
  return real;
}

function utcSegment(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`handoff metadata.startedAt is not a valid date-time: ${value}.`);
  }
  return date
    .toISOString()
    .replace(/[-:]/gu, '')
    .replace(/\.\d{3}Z$/u, 'Z');
}

function slugSegment(value: string, label: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]/gu, '');
  if (!/^[a-z][a-z0-9]*$/u.test(normalized)) {
    throw new Error(`${label} cannot form a run-slug segment: ${value}.`);
  }
  return normalized;
}

function ticketSegment(ticket: string | undefined): string {
  if (!ticket) return '';
  const normalized = ticket
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-|-$/gu, '');
  return normalized === '' ? '' : `${normalized}-`;
}

export function deriveCloseoutPackageId(metadata: CloseoutMetadata): string {
  const disambiguator = createHash('sha256')
    .update(
      JSON.stringify({
        attemptId: metadata.attemptId,
        startedAt: metadata.startedAt,
        surface: metadata.surface,
        project: metadata.project,
        repo: metadata.repo,
        flow: metadata.flow,
        task: metadata.task,
      }),
    )
    .digest('hex')
    .slice(0, 8);
  return `${utcSegment(metadata.startedAt)}-${slugSegment(
    metadata.surface,
    'handoff metadata.surface',
  )}-${slugSegment(metadata.flow, 'handoff metadata.flow')}-${ticketSegment(
    metadata.task.ticket,
  )}${disambiguator}`;
}

function expandHome(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith(`~${path.sep}`)) return path.join(os.homedir(), value.slice(2));
  return value;
}

function defaultConfigPath(): string {
  const home = process.env.FARMSLOT_HOME || path.join(os.homedir(), '.farmslot');
  return path.join(home, CONFIG_RELATIVE_PATH);
}

function resolveConfigPath(configPath: string, value: string): string {
  const expanded = expandHome(value);
  return path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(path.dirname(configPath), expanded);
}

function resolutionFor(file: string, kind: string): ResolutionSource {
  return { kind, resolvedPath: file, tier: 'personal', shadows: [] };
}

export function closeoutLearningPackage(options: CloseoutOptions): CloseoutResult {
  const taskDir = realpathSync(options.taskDir);
  const configPath = path.resolve(expandHome(options.configPath ?? defaultConfigPath()));
  const metadataPath = path.resolve(
    options.metadataPath ?? path.join(taskDir, METADATA_RELATIVE_PATH),
  );
  const signalPath = path.join(taskDir, SIGNAL_RELATIVE_PATH);
  const config = parseConfig(configPath);
  const metadata = parseMetadata(metadataPath);
  const signal = parseSignal(signalPath);
  const outcome = terminalOutcome(signal);
  const finishedAt = requireString(signal.timestamp, 'terminal signal.timestamp');
  const startedAtMs = new Date(metadata.startedAt).getTime();
  const finishedAtMs = new Date(finishedAt).getTime();
  if (Number.isNaN(startedAtMs) || Number.isNaN(finishedAtMs) || finishedAtMs < startedAtMs) {
    throw new Error(
      `terminal signal timestamp ${JSON.stringify(finishedAt)} predates or is invalid for ` +
        `task start ${JSON.stringify(metadata.startedAt)}. Next: do not reuse a task directory; ` +
        'create a fresh task and terminal signal.',
    );
  }
  const packageId = deriveCloseoutPackageId(metadata);
  const stagingRoot = ensureTaskStagingRoot(
    taskDir,
    path.join(taskDir, '.handoff'),
    !options.share,
  );
  const stagedPackage = path.join(stagingRoot, packageId);
  const destination =
    options.destination === undefined
      ? config.destination
        ? resolveConfigPath(configPath, config.destination)
        : ''
      : path.resolve(expandHome(options.destination));
  if (options.share) {
    if (!destination) {
      throw new Error(
        'no learning destination was provided. ' +
          'Next: pass --destination <local-git-clone> or configure a destination before sharing.',
      );
    }
    if (!existsSync(stagedPackage) || !validateLearningPackage(stagedPackage).valid) {
      throw new Error(
        `no valid staged package exists at ${stagedPackage}. ` +
          'Next: run handoff closeout without --share, inspect that package, then ask for approval.',
      );
    }
    const stagedManifest = JSON.parse(
      readFileSync(path.join(stagedPackage, 'manifest.json'), 'utf8'),
    ) as { packageId?: string };
    if (stagedManifest.packageId !== packageId) {
      throw new Error(
        `staged package id ${JSON.stringify(stagedManifest.packageId)} does not match ${packageId}. ` +
          'Next: stage this task again and inspect the new package before approval.',
      );
    }
    const preview = writeLearningPackage({
      packageDir: stagedPackage,
      destination,
      dryRun: true,
    });
    if (preview.status !== 'dry-run') {
      throw new Error('handoff closeout internal error: write preview did not return dry-run.');
    }
    const written = writeLearningPackage({
      packageDir: stagedPackage,
      destination,
      ifExists: 'return-identical',
      consent: {
        humanApproval: true,
      },
    });
    if (written.status === 'already-written') {
      return {
        status: 'already-shared',
        packageDir: stagedPackage,
        destinationPath: written.destinationPath,
        wouldWritePath: preview.wouldWritePath,
        pushed: written.pushed,
        ...(written.pushError === undefined ? {} : { pushError: written.pushError }),
      };
    }
    if (written.status !== 'written') {
      throw new Error('handoff closeout internal error: approved write did not write.');
    }
    return {
      status: 'written',
      packageDir: stagedPackage,
      destinationPath: written.destinationPath,
      commitSha: written.commitSha,
      pushed: written.pushed,
      ...(written.pushError === undefined ? {} : { pushError: written.pushError }),
    };
  }

  const taskDocument = resolveInside(taskDir, metadata.taskDocument, 'task document');
  const report = resolveInside(
    taskDir,
    signal.evidence?.reportPath ?? metadata.report,
    'run report',
  );
  const learnings = resolveInside(taskDir, metadata.learnings, 'run learnings');
  const normalizedArtifacts = mkdtempSync(path.join(os.tmpdir(), 'handoff-closeout-inputs-'));
  try {
    copyFileSync(report, path.join(normalizedArtifacts, 'report.md'));
    copyFileSync(learnings, path.join(normalizedArtifacts, 'learnings.md'));
    const runRecord: RunMeta = {
      packageId,
      project: metadata.project,
      ...(metadata.repo === undefined ? {} : { repo: metadata.repo }),
      domain: metadata.domain,
      run: {
        startedAt: metadata.startedAt,
        finishedAt,
        flow: metadata.flow,
        outcome,
        ...(metadata.model === undefined ? {} : { model: metadata.model }),
      },
      task: metadata.task,
      ...(metadata.source === undefined ? {} : { source: metadata.source }),
    };
    const input: LearningPackageInput = {
      surface: metadata.surface,
      runRecord,
      templateProvenance: [
        resolutionFor(metadataPath, 'handoff.metadata'),
        ...(existsSync(configPath) ? [resolutionFor(configPath, 'learning.config')] : []),
      ],
      taskDoc: { taskMd: taskDocument },
      artifacts: { artifactsDir: normalizedArtifacts },
    };
    const assembled = assembleLearningPackage(input, {
      stagingRoot,
      farmslotHome: process.env.FARMSLOT_HOME,
      workspace: taskDir,
    });
    if (assembled.status === 'blocked') {
      return {
        status: 'blocked',
        quarantineDir: assembled.quarantineDir,
        scrubReport: assembled.scrubReport,
      };
    }
    const preview = writeLearningPackage({
      packageDir: assembled.packageDir,
      destination,
      dryRun: true,
    });
    if (preview.status !== 'dry-run') {
      throw new Error('handoff closeout internal error: write preview did not return dry-run.');
    }
    return {
      status: 'staged',
      packageDir: assembled.packageDir,
      wouldWritePath: preview.wouldWritePath,
      indexRows: preview.indexRows,
    };
  } finally {
    rmSync(normalizedArtifacts, { recursive: true, force: true });
  }
}
