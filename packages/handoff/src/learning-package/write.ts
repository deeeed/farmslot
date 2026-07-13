import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
  truncateSync,
  writeSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { normalizeTicket } from '../spec/task-key.js';
import type { GradeSemantic, HumanGrade, IndexRow, Manifest } from '../spec/types.js';
import { SCHEMA_VERSION } from '../spec/version.js';
import { isValidDateTime } from '../validate/json-schema.js';
import { validateLearningPackage } from '../validate/validate-package.js';

import { assertContained, assertSafePathSegment } from './safe-path.js';

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
  | {
      status: 'written';
      destinationPath: string;
      commitSha: string;
      pushed: boolean;
      /** Set iff a push was attempted and failed (commit is local and retriable);
       * absent when pushed or when the destination has no remote. */
      pushError?: string;
    }
  | { status: 'dry-run'; wouldWritePath: string; indexRows: IndexRow[]; pushed: false };

/**
 * The real git dir of a destination: `.git` is a directory in a normal clone
 * but a FILE with a `gitdir:` pointer in a linked worktree - both are valid
 * git repos and valid destinations.
 */
function resolveGitDir(destination: string): string {
  const dotGit = path.join(destination, '.git');
  if (statSync(dotGit).isDirectory()) return dotGit;
  const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, 'utf8'));
  if (!pointer) {
    throw new Error(
      `writeLearningPackage: ${dotGit} is neither a git dir nor a worktree pointer. ` +
        'Next: pass the root of a real git clone or linked worktree as destination.',
    );
  }
  return path.resolve(destination, pointer[1]);
}

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

/**
 * Every entry under `dir` as package-relative POSIX paths, split by dirent
 * type. Anything that is not a plain directory or regular file (symlinks,
 * fifos, sockets, ...) is collected separately: such entries are invisible to
 * hash inventories yet can smuggle or redirect content, so the writer refuses
 * them outright.
 */
function walkEntries(dir: string, base = dir): { files: string[]; irregular: string[] } {
  const files: string[] = [];
  const irregular: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    const rel = path.relative(base, abs).split(path.sep).join('/');
    if (entry.isSymbolicLink()) irregular.push(rel);
    else if (entry.isDirectory()) {
      const nested = walkEntries(abs, base);
      files.push(...nested.files);
      irregular.push(...nested.irregular);
    } else if (entry.isFile()) files.push(rel);
    else irregular.push(rel);
  }
  return { files, irregular };
}

/**
 * Manifest fields the schemas leave as unconstrained strings but that this
 * writer uses as filesystem path segments. Each is validated before ANY path is
 * computed (dry-run included) so a path-shaped value (e.g. `engineer: "../x"`)
 * can never place IO outside the destination repo.
 */
function assertSafeManifestSegments(manifest: Manifest): void {
  assertSafePathSegment(manifest.packageId, 'manifest.packageId');
  assertSafePathSegment(manifest.taskKey, 'manifest.taskKey');
  assertSafePathSegment(manifest.surface, 'manifest.surface');
  assertSafePathSegment(manifest.project, 'manifest.project');
  assertSafePathSegment(manifest.engineer, 'manifest.engineer');
  assertSafePathSegment(manifest.run.flow, 'manifest.run.flow');
  if (manifest.domain !== '') assertSafePathSegment(manifest.domain, 'manifest.domain');
  // The ticket is hyphen-normalized before becoming a filename (matching the
  // run-slug grammar), so only the normalized form needs the segment guard; a
  // ticket that normalizes to nothing simply gets no by-ticket index.
  const ticket = manifest.task.ticket ? normalizeTicket(manifest.task.ticket) : '';
  if (ticket !== '') assertSafePathSegment(ticket, 'manifest.task.ticket');
}

/** Repo-relative package path (spec section 1): packages/YYYY/MM/DD/surface/project/run-slug. */
function repoRelativePath(manifest: Manifest): string {
  const started = new Date(manifest.run.startedAt);
  // Validation enforces calendar-valid timestamps; this guard makes sure a
  // path like packages/NaN/NaN/... can never be derived regardless.
  if (Number.isNaN(started.getTime())) {
    throw new Error(
      `writeLearningPackage: run.startedAt '${manifest.run.startedAt}' is not a valid ` +
        'date-time, so no destination path can be derived. Next: stamp a real ISO ' +
        'timestamp in the run record and re-assemble.',
    );
  }
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
  const ticket = manifest.task.ticket ? normalizeTicket(manifest.task.ticket) : '';
  if (ticket !== '') files.push(`indexes/by-ticket/${ticket}.jsonl`);
  return files;
}

/**
 * Serialize destination writes: concurrent approved writers would race the
 * clean-tree check, the index appends, and the commit - and one writer's
 * rollback could truncate another's freshly appended rows. The lock file is
 * exclusive-create in the destination's .git dir and held across
 * check -> copy -> append -> commit (and any rollback).
 */
function acquireWriteLock(lockPath: string, destination: string): number {
  try {
    const fd = openSync(lockPath, 'wx');
    writeSync(fd, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
    return fd;
  } catch {
    let holder = '';
    try {
      holder = readFileSync(lockPath, 'utf8').trim();
    } catch {
      holder = '';
    }
    throw new Error(
      `writeLearningPackage: another write to ${destination} is in progress` +
        (holder !== '' ? ` (lock holder: ${holder})` : '') +
        `. Next: wait for it to finish and retry; if that process is gone (stale lock), ` +
        `remove ${lockPath} and retry.`,
    );
  }
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

  // Irregular entries are refused FIRST, before any file in the package
  // (including manifest.json itself) is read or validated: a symlink must
  // never be followed - not even by the validation pass.
  const entries = walkEntries(options.packageDir);
  if (entries.irregular.length > 0) {
    throw new Error(
      `writeLearningPackage: package at ${options.packageDir} contains non-regular-file ` +
        `entries: ${entries.irregular.join(', ')}. Symlinks and special files cannot be ` +
        'inventory-verified and are never shared. Next: re-assemble with ' +
        'assembleLearningPackage; never add entries to a staged package.',
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

  // Inventory completeness (share gate, stricter than the consumer validator):
  // validation already proved every inventoried file matches its post-scrub
  // hash; additionally refuse any on-disk file the assembler did not inventory,
  // so nothing that skipped the scrub gate reaches the repo.
  const unlisted = entries.files.filter(
    (rel) => rel !== 'manifest.json' && !(rel in manifest.files),
  );
  if (unlisted.length > 0) {
    throw new Error(
      `writeLearningPackage: package ${manifest.packageId} contains files not in the ` +
        `manifest inventory: ${unlisted.join(', ')}. These were never scrubbed. ` +
        'Next: re-assemble with assembleLearningPackage; never add files to a staged package.',
    );
  }

  assertSafeManifestSegments(manifest);
  const packagePath = repoRelativePath(manifest);
  const row = buildIndexRow(manifest, packagePath, gradeSemanticFor(options.packageDir));

  if (options.dryRun) {
    return { status: 'dry-run', wouldWritePath: packagePath, indexRows: [row], pushed: false };
  }

  // All three consent fields are runtime-required: untyped callers can omit
  // what the type system would demand, and an approval without WHO and WHEN is
  // not an audit-grade approval.
  if (options.consent?.humanApproval !== true) {
    throw new Error(
      'writeLearningPackage: a real write requires per-call human approval ' +
        '(consent: { humanApproval: true, approvedBy, grantedAt }). Approval is never ' +
        'sticky and never read from a file. Next: get an explicit approval, or use ' +
        'dryRun: true to preview without writing.',
    );
  }
  if (typeof options.consent.approvedBy !== 'string' || options.consent.approvedBy.trim() === '') {
    throw new Error(
      'writeLearningPackage: consent.approvedBy is missing or empty - the approval must ' +
        'name who granted it (a pseudonymous engineer key is fine). Next: pass the ' +
        "approver's identifier with the consent.",
    );
  }
  if (
    typeof options.consent.grantedAt !== 'string' ||
    !isValidDateTime(options.consent.grantedAt)
  ) {
    throw new Error(
      `writeLearningPackage: consent.grantedAt '${String(options.consent.grantedAt)}' is ` +
        'missing or not a valid ISO date-time - the approval must record when it was ' +
        'granted. Next: stamp the grant time (e.g. new Date().toISOString()).',
    );
  }

  if (!existsSync(path.join(options.destination, '.git'))) {
    throw new Error(
      `writeLearningPackage: destination ${options.destination} is not a git repo. ` +
        'Next: clone the learnings repo locally and pass its root as destination.',
    );
  }

  // Exclusive destination lock for the whole check->copy->append->commit span.
  // The lock lives in the RESOLVED git dir: in a linked worktree, .git is a
  // FILE carrying a `gitdir:` pointer, and worktrees are valid destinations.
  const lockPath = path.join(resolveGitDir(options.destination), 'farmslot-handoff.lock');
  const lockFd = acquireWriteLock(lockPath, options.destination);
  let stagingDir: string | undefined;
  try {
    // A clean tree means a failed write can be rolled back precisely and the
    // resulting commit contains exactly this package.
    if (git(options.destination, ['status', '--porcelain']) !== '') {
      throw new Error(
        `writeLearningPackage: destination ${options.destination} has uncommitted changes. ` +
          'Next: commit or stash them first - the writer needs a clean tree so a failed ' +
          'write can be rolled back without touching unrelated work.',
      );
    }

    const destPackageDir = assertContained(
      options.destination,
      path.join(options.destination, packagePath),
      'package destination',
    );
    if (existsSync(destPackageDir)) {
      throw new Error(
        `writeLearningPackage: ${packagePath} already exists in the destination - the ` +
          'learnings repo is append-only and packages are never rewritten. Next: a re-run ' +
          'of the same work is a NEW package (new run-slug); re-assemble instead of re-writing.',
      );
    }

    // Record index-file sizes so a mid-write failure can truncate the appends
    // back out (best-effort rollback; the clean-tree precondition makes it exact).
    const indexFiles = indexFilesFor(manifest).map((indexFile) => {
      const abs = assertContained(
        options.destination,
        path.join(options.destination, indexFile),
        `index file ${indexFile}`,
      );
      return { indexFile, abs, priorBytes: existsSync(abs) ? statSync(abs).size : -1 };
    });

    // TOCTOU-safe snapshot: copy the inventoried files into a PRIVATE staging
    // dir, validate THAT exact snapshot, and publish only from it. The source
    // package dir is never read again after this copy, so a concurrent mutation
    // of the source between validation and publish cannot commit unverified
    // bytes - the destination only ever receives validated-staging bytes.
    stagingDir = mkdtempSync(path.join(os.tmpdir(), 'handoff-write-snapshot-'));
    for (const rel of ['manifest.json', ...Object.keys(manifest.files)]) {
      const src = path.join(options.packageDir, rel);
      const dest = assertContained(stagingDir, path.join(stagingDir, rel), `snapshot ${rel}`);
      mkdirSync(path.dirname(dest), { recursive: true });
      copyFileSync(src, dest);
    }
    const snapshotValidation = validateLearningPackage(stagingDir);
    if (!snapshotValidation.valid) {
      throw new Error(
        `writeLearningPackage: the package snapshot failed validation - the source at ` +
          `${options.packageDir} changed between validation and copy (TOCTOU):\n` +
          `${snapshotValidation.errors.map((e) => `  - ${e}`).join('\n')}\n` +
          'Next: re-assemble with assembleLearningPackage and do not mutate the package ' +
          'dir while a write is in progress.',
      );
    }
    const snapshotDir = stagingDir;

    // Remove now-empty ancestor dirs the failed write created, up to the repo root.
    const removeEmptyParents = (from: string): void => {
      const stop = path.resolve(options.destination);
      let current = path.dirname(path.resolve(from));
      while (current !== stop) {
        try {
          rmdirSync(current); // throws when non-empty or missing - both mean stop
        } catch {
          break;
        }
        current = path.dirname(current);
      }
    };

    const rollback = (): void => {
      rmSync(destPackageDir, { recursive: true, force: true });
      removeEmptyParents(destPackageDir);
      for (const { abs, priorBytes } of indexFiles) {
        if (priorBytes === -1) {
          // An index file that never came to exist (e.g. its mkdir failed) needs
          // no removal - existsSync also shields rm from unreachable paths.
          if (existsSync(abs)) rmSync(abs, { force: true });
          removeEmptyParents(abs);
        } else if (existsSync(abs)) {
          truncateSync(abs, priorBytes);
        }
      }
    };

    let commitSha: string;
    try {
      // Publish from the validated SNAPSHOT, never the source - the bytes
      // committed are exactly the bytes that just passed validation.
      for (const rel of ['manifest.json', ...Object.keys(manifest.files)]) {
        const src = path.join(snapshotDir, rel);
        const dest = assertContained(destPackageDir, path.join(destPackageDir, rel), `copy ${rel}`);
        mkdirSync(path.dirname(dest), { recursive: true });
        copyFileSync(src, dest);
      }

      const line = `${JSON.stringify(row)}\n`;
      const touched = [packagePath];
      for (const { indexFile, abs } of indexFiles) {
        mkdirSync(path.dirname(abs), { recursive: true });
        appendFileSync(abs, line);
        touched.push(indexFile);
      }

      git(options.destination, ['add', '--', ...touched]);
      // Destination-repo hooks run and may reject the commit; that surfaces as a
      // rolled-back failure below rather than being bypassed.
      git(options.destination, [
        'commit',
        '-m',
        `chore(learnings): add package ${manifest.packageId}`,
      ]);
      commitSha = git(options.destination, ['rev-parse', 'HEAD']);
    } catch (error) {
      try {
        rollback();
        git(options.destination, ['reset', '-q']);
      } catch (rollbackError) {
        // Never claim a clean rollback that did not happen: restoration stopped
        // midway, so the destination may hold partial state.
        throw new Error(
          `writeLearningPackage: write to ${options.destination} failed ` +
            `(${(error as Error).message}) AND rollback could not fully restore it ` +
            `(${(rollbackError as Error).message}). Partial state may remain under ` +
            `${packagePath} and indexes/. Next: run \`git -C ${options.destination} status\`, ` +
            'remove the leftover package dir, restore index files with ' +
            '`git checkout -- indexes`, then retry.',
        );
      }
      throw new Error(
        `writeLearningPackage: write to ${options.destination} failed and was rolled back ` +
          `(${(error as Error).message}). Next: check destination permissions/hooks and git ` +
          'state, then retry - the local package dir is untouched and re-writable.',
      );
    }

    let pushed = false;
    let pushError: string | undefined;
    if (git(options.destination, ['remote']) !== '') {
      try {
        git(options.destination, ['push']);
        pushed = true;
      } catch (error) {
        // Push failure is non-fatal: the commit is local and retriable. The share
        // itself succeeded append-only; the caller may sync later. The reason is
        // surfaced so callers never mistake a failed push for a missing remote.
        pushError = (error as Error).message;
      }
    }

    return {
      status: 'written',
      destinationPath: destPackageDir,
      commitSha,
      pushed,
      ...(pushError !== undefined ? { pushError } : {}),
    };
  } finally {
    if (stagingDir !== undefined) rmSync(stagingDir, { recursive: true, force: true });
    closeSync(lockFd);
    rmSync(lockPath, { force: true });
  }
}
