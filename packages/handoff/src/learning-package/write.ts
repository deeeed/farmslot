import { execFileSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { GradeSemantic, HumanGrade, IndexRow, Manifest } from '../spec/types.js';
import { SCHEMA_VERSION } from '../spec/version.js';
import { validateLearningPackage } from '../validate/validate-package.js';

/**
 * The per-call human approval that authorizes a repo write. MANUAL APPROVAL
 * FOREVER: there is no auto-write mode, no sticky consent, and no file this is
 * ever resolved from - a human grants it at call time, every time.
 */
export interface WriteConsent {
  /** Literal `true` - the type refuses a computed/possibly-false value. */
  humanApproval: true;
  /** Who approved (pseudonymous engineer key is fine). */
  approvedBy: string;
  /** When the approval was granted (ISO date-time). */
  grantedAt: string;
}

export interface WriteLearningPackageOptions {
  /** An assembled package dir from a `status: 'ok'` AssembleResult. A blocked
   * result carries no `packageDir`, so handing one here is a compile-time error. */
  packageDir: string;
  /** Local clone root of the learnings git repo (the only hard requirement: git). */
  destination: string;
  /** Required for a real write; ignored under `dryRun` (no approver = dry-run). */
  consent?: WriteConsent;
  /** Compute the would-write path + index rows with NO git or destination IO. */
  dryRun?: boolean;
}

/**
 * Discriminated write result. `dry-run` performs no git IO; `written` is an
 * append-only package copy + index rows committed to the destination repo,
 * pushed when the repo has a remote.
 */
export type WriteResult =
  | { status: 'written'; destinationPath: string; commitSha: string; pushed: boolean }
  | { status: 'dry-run'; wouldWritePath: string; indexRows: IndexRow[]; pushed: false };

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

/** Repo-relative package path (spec section 1): packages/YYYY/MM/DD/surface/project/run-slug. */
function repoRelativePath(manifest: Manifest): string {
  const started = new Date(manifest.run.startedAt);
  const yyyy = String(started.getUTCFullYear());
  const mm = String(started.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(started.getUTCDate()).padStart(2, '0');
  return ['packages', yyyy, mm, dd, manifest.surface, manifest.project, manifest.packageId].join(
    '/',
  );
}

/** Read grade.json:recipe_semantic from the package when present and well-formed. */
function gradeSemanticFor(packageDir: string): GradeSemantic | undefined {
  const gradePath = path.join(packageDir, 'grade.json');
  if (!existsSync(gradePath)) return undefined;
  try {
    const grade = JSON.parse(readFileSync(gradePath, 'utf8')) as HumanGrade;
    return grade.recipe_semantic === 'good' ||
      grade.recipe_semantic === 'ok' ||
      grade.recipe_semantic === 'bad'
      ? grade.recipe_semantic
      : undefined;
  } catch {
    return undefined;
  }
}

function buildIndexRow(
  manifest: Manifest,
  packagePath: string,
  gradeSemantic: GradeSemantic | undefined,
): IndexRow {
  const storedFiles = Object.keys(manifest.files);
  return {
    schemaVersion: SCHEMA_VERSION,
    packageId: manifest.packageId,
    taskKey: manifest.taskKey,
    packagePath,
    surface: manifest.surface,
    project: manifest.project,
    domain: manifest.domain,
    engineer: manifest.engineer,
    flow: manifest.run.flow,
    ...(manifest.task.ticket ? { ticket: manifest.task.ticket } : {}),
    outcome: manifest.run.outcome,
    startedAt: manifest.run.startedAt,
    ...(manifest.run.finishedAt ? { finishedAt: manifest.run.finishedAt } : {}),
    packageSchemaVersion: manifest.schemaVersion,
    hasPr: storedFiles.some((f) => f.startsWith('pr/')),
    hasHarnessEvidence: storedFiles.some((f) => f.startsWith('harness/')),
    hasGrade: storedFiles.includes('grade.json'),
    ...(gradeSemantic ? { gradeSemantic } : {}),
  };
}

/** The index files (repo-relative) one package appends its row to. */
function indexFilesFor(manifest: Manifest): string[] {
  const files = [
    `indexes/by-engineer/${manifest.engineer}.jsonl`,
    `indexes/by-project/${manifest.project}.jsonl`,
    `indexes/by-flow/${manifest.run.flow}.jsonl`,
    `indexes/by-task/${manifest.taskKey}.jsonl`,
  ];
  if (manifest.domain !== '') files.push(`indexes/by-domain/${manifest.domain}.jsonl`);
  if (manifest.task.ticket) {
    files.push(`indexes/by-ticket/${manifest.task.ticket.toLowerCase()}.jsonl`);
  }
  return files;
}

/**
 * Write one assembled learning package to the learnings repo (spec section 5 of
 * the API design): append-only package copy + one JSONL row per index file,
 * committed to git. Never rewrites an existing package or index line.
 *
 * Fail-closed applies to the SHARE decision only: a package whose scrub status is
 * not `pass`, an invalid package, or a missing human approval refuses the write.
 * Callers treat that refusal per the non-blocking closeout contract (warn + skip);
 * it must never fail the run itself.
 */
export function writeLearningPackage(options: WriteLearningPackageOptions): WriteResult {
  const manifestPath = path.join(options.packageDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(
      `writeLearningPackage: no manifest.json under ${options.packageDir}. ` +
        'Next: pass the packageDir from a status:"ok" AssembleResult.',
    );
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;

  // Pre-write assertion (spec section 5.2): blocked content never reaches a shared
  // destination, even if a caller hand-built the directory.
  if (manifest.scrubbing.status !== 'pass') {
    throw new Error(
      `writeLearningPackage: refusing to write package ${manifest.packageId} with ` +
        `scrubbing.status '${manifest.scrubbing.status}'. Next: a blocked assembly is ` +
        'quarantined locally - review scrub-report.json, fix the producing run, re-assemble.',
    );
  }

  const validation = validateLearningPackage(options.packageDir);
  if (!validation.valid) {
    throw new Error(
      `writeLearningPackage: package ${manifest.packageId} fails spec validation:\n` +
        `${validation.errors.map((e) => `  - ${e}`).join('\n')}\n` +
        'Next: re-assemble with assembleLearningPackage; callers never hand-edit package files.',
    );
  }

  const packagePath = repoRelativePath(manifest);
  const row = buildIndexRow(manifest, packagePath, gradeSemanticFor(options.packageDir));

  if (options.dryRun) {
    return { status: 'dry-run', wouldWritePath: packagePath, indexRows: [row], pushed: false };
  }

  if (options.consent?.humanApproval !== true) {
    throw new Error(
      'writeLearningPackage: a real write requires per-call human approval ' +
        '(consent: { humanApproval: true, approvedBy, grantedAt }). Approval is never ' +
        'sticky and never read from a file. Next: get an explicit approval, or use ' +
        'dryRun: true to preview without writing.',
    );
  }

  if (!existsSync(path.join(options.destination, '.git'))) {
    throw new Error(
      `writeLearningPackage: destination ${options.destination} is not a git repo. ` +
        'Next: clone the learnings repo locally and pass its root as destination.',
    );
  }

  const destPackageDir = path.join(options.destination, packagePath);
  if (existsSync(destPackageDir)) {
    throw new Error(
      `writeLearningPackage: ${packagePath} already exists in the destination - the ` +
        'learnings repo is append-only and packages are never rewritten. Next: a re-run ' +
        'of the same work is a NEW package (new run-slug); re-assemble instead of re-writing.',
    );
  }

  cpSync(options.packageDir, destPackageDir, { recursive: true });

  const line = `${JSON.stringify(row)}\n`;
  const touched = [packagePath];
  for (const indexFile of indexFilesFor(manifest)) {
    const abs = path.join(options.destination, indexFile);
    mkdirSync(path.dirname(abs), { recursive: true });
    appendFileSync(abs, line);
    touched.push(indexFile);
  }

  git(options.destination, ['add', '--', ...touched]);
  git(options.destination, [
    'commit',
    '-m',
    `chore(learnings): add package ${manifest.packageId}`,
    '--no-verify',
  ]);
  const commitSha = git(options.destination, ['rev-parse', 'HEAD']);

  let pushed = false;
  if (git(options.destination, ['remote']) !== '') {
    try {
      git(options.destination, ['push']);
      pushed = true;
    } catch {
      // Push failure is non-fatal: the commit is local and retriable. The share
      // itself succeeded append-only; the caller may sync later.
      pushed = false;
    }
  }

  return { status: 'written', destinationPath: destPackageDir, commitSha, pushed };
}
