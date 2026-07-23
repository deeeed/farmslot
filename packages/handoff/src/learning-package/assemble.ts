import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { type FloorPattern, scanForFloorSecrets } from '../scrub/floor.js';
import { scrubFiles, type ScrubInputFile } from '../scrub/scrubber.js';
import { loadSchema } from '../spec/schemas.js';
import { deriveTaskKey, normalizeTicket } from '../spec/task-key.js';
import type {
  ArtifactKind,
  ArtifactRecord,
  ArtifactsIndex,
  Manifest,
  ManifestFileRecord,
  ManifestTask,
  Provenance,
  ScrubReport,
  SourceDocument,
} from '../spec/types.js';
import {
  REQUIRED_FILES,
  RUN_SLUG_PATTERN,
  SCHEMA_VERSION,
  SCRUB_FLOOR_VERSION,
} from '../spec/version.js';
import { validateAgainstSchema } from '../validate/json-schema.js';

import { assertContained, assertSafePathSegment } from './safe-path.js';
import type {
  AssembleResult,
  HandoffContext,
  HarnessOutputDir,
  LearningPackageInput,
} from './types.js';

const REQUIRED_SET = new Set(REQUIRED_FILES);

function sha256File(absolutePath: string): string {
  return createHash('sha256').update(readFileSync(absolutePath)).digest('hex');
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writePackageFile(root: string, relativePath: string, content: string): void {
  // Package-relative paths are caller-influenced (harness names, media paths):
  // nothing may stage outside the package root.
  const abs = assertContained(root, path.join(root, relativePath), `package file ${relativePath}`);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(abs));
    else if (entry.isFile()) out.push(abs);
  }
  return out;
}

function harnessArtifactKind(fileName: string): ArtifactKind {
  if (fileName === 'summary.json') return 'summary';
  if (fileName === 'trace.json') return 'trace';
  if (fileName === 'artifact-manifest.json') return 'artifact-manifest';
  if (fileName === 'recipe.json') return 'recipe';
  if (fileName === 'quality.json') return 'quality';
  return 'other';
}

function requirePath(absolutePath: string, label: string): void {
  if (!existsSync(absolutePath)) {
    throw new Error(`assembleLearningPackage: ${label} not found at ${absolutePath}`);
  }
}

function harnessTextInputs(harnessDirs: HarnessOutputDir[]): {
  input: ScrubInputFile;
  kind: ArtifactKind;
}[] {
  const out: { input: ScrubInputFile; kind: ArtifactKind }[] = [];
  for (const { name, dir } of harnessDirs) {
    assertSafePathSegment(name, 'harnessOutputDirs[].name');
    if (!existsSync(dir)) continue;
    for (const abs of walkFiles(dir)) {
      const rel = path.relative(dir, abs).split(path.sep).join('/');
      const packagePath = `harness/${name}/${rel}`;
      out.push({
        input: { packagePath, absolutePath: abs },
        kind: harnessArtifactKind(path.basename(abs)),
      });
    }
  }
  return out;
}

function buildSourceDocument(input: LearningPackageInput): SourceDocument {
  const source = input.runRecord.source ?? {};
  // Caller fields first; the authoritative stamps always win over anything the blob carries.
  return { ...source, schemaVersion: SCHEMA_VERSION, sourceKind: input.runRecord.task.sourceKind };
}

/** Derive the cross-attempt family key from the run's task/source fields. */
function taskKeyFor(input: LearningPackageInput): string {
  const source = input.runRecord.source;
  return deriveTaskKey({
    ticket: input.runRecord.task.ticket ?? source?.ticket,
    title: source?.title ?? input.runRecord.task.title,
    description: source?.description,
    acceptanceCriteria: source?.acceptanceCriteria,
  });
}

/** The manifest core shared by pass and quarantine manifests (no files/scrubbing). */
function manifestBase(
  input: LearningPackageInput,
  task: ManifestTask,
): Omit<Manifest, 'files' | 'scrubbing'> {
  return {
    schemaVersion: SCHEMA_VERSION,
    packageId: input.runRecord.packageId,
    taskKey: taskKeyFor(input),
    surface: input.surface,
    project: input.runRecord.project,
    ...(input.runRecord.repo ? { repo: input.runRecord.repo } : {}),
    domain: input.runRecord.domain,
    run: input.runRecord.run,
    task,
    ...(input.runRecord.extensions ? { extensions: input.runRecord.extensions } : {}),
  };
}

/**
 * Replace anything carrying a floor hit with a redaction marker, recursively:
 * string values, object KEYS, and whole arrays whose JOINED string members hit
 * (the realistic accidental form - wallet fixtures store mnemonics as word
 * arrays, so per-element scanning alone would miss the run). Used on the
 * quarantine manifest and scrub report so the block audit trail never
 * reproduces the raw secret that caused the block.
 */
function redactSecretStrings<T>(value: T, extraPatterns?: FloorPattern[]): T {
  const marker = (hits: { kind: string }[]): string =>
    `[REDACTED:${[...new Set(hits.map((h) => h.kind))].join('+')}]`;

  if (typeof value === 'string') {
    const hits = scanForFloorSecrets(value, extraPatterns);
    return hits.length > 0 ? (marker(hits) as unknown as T) : value;
  }
  if (Array.isArray(value)) {
    // A secret split across array elements only shows in the joined view.
    const joined = value.filter((item) => typeof item === 'string').join(' ');
    const joinedHits = scanForFloorSecrets(joined, extraPatterns);
    if (joinedHits.length > 0) return [marker(joinedHits)] as unknown as T;
    return value.map((item) => redactSecretStrings(item, extraPatterns)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => {
        const keyHits = scanForFloorSecrets(key, extraPatterns);
        return [
          keyHits.length > 0 ? marker(keyHits) : key,
          redactSecretStrings(child, extraPatterns),
        ];
      }),
    ) as T;
  }
  return value;
}

/** All string values in a JSON-ish tree, in traversal order (keys excluded). */
function collectStringValues(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStringValues(item, out);
  else if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) collectStringValues(child, out);
  }
  return out;
}

/**
 * Sanitize a blocked scrub report for exposure ANYWHERE outside the gate: its
 * omitted/attestation entries echo caller strings (paths, attestation fields)
 * that may themselves carry the secret. Beyond granular redaction, string
 * values are scanned joined - overall AND per same-field COLUMN (a phrase
 * split across sibling records spreads through the same field, and the
 * interleaved enum fields would otherwise break the joined run). On any hit
 * the free-text carriers are replaced wholesale; kinds/reasons/findings are
 * closed enums and fingerprints/timestamps are non-secret, so what remains
 * cannot compose a word run. The SAME sanitized object is persisted to the
 * quarantine AND returned in the blocked AssembleResult - a caller logging
 * result.scrubReport must never see the raw secret either.
 */
function quarantineSafeReport(
  scrubReport: ScrubReport,
  extraPatterns?: FloorPattern[],
): ScrubReport {
  const safeReport = redactSecretStrings(scrubReport, extraPatterns);
  const reportColumns = [
    collectStringValues(safeReport).join(' '),
    safeReport.blocked.map((record) => record.file).join(' '),
    safeReport.redactions.map((record) => record.file).join(' '),
    safeReport.omitted.map((record) => record.path).join(' '),
    safeReport.visualPassAttestations.map((record) => record.file).join(' '),
    safeReport.visualPassAttestations.map((record) => record.attestedBy).join(' '),
  ];
  if (
    scanForFloorSecrets(stableJson(safeReport), extraPatterns).length === 0 &&
    !reportColumns.some((column) => scanForFloorSecrets(column, extraPatterns).length > 0)
  ) {
    return safeReport;
  }
  return {
    ...safeReport,
    blocked: safeReport.blocked.map((record, i) => ({
      ...record,
      file: `[REDACTED:entry-${i}]`,
    })),
    redactions: safeReport.redactions.map((record, i) => ({
      ...record,
      file: `[REDACTED:entry-${i}]`,
    })),
    omitted: safeReport.omitted.map((record, i) => ({
      reason: record.reason,
      path: `[REDACTED:entry-${i}]`,
    })),
    visualPassAttestations: safeReport.visualPassAttestations.map((record, i) => ({
      ...record,
      file: `[REDACTED:entry-${i}]`,
      attestedBy: '[REDACTED]',
    })),
  };
}

function writeQuarantine(
  ctx: HandoffContext,
  input: LearningPackageInput,
  base: Omit<Manifest, 'files' | 'scrubbing'>,
  safeReport: ScrubReport,
): string {
  // The dir NAME is filesystem metadata: a slug carrying secret material
  // (e.g. a token-shaped ticket segment) must not land there either - fall
  // back to a generic, deterministic, non-secret name on any floor hit.
  const packageId = input.runRecord.packageId;
  const dirName =
    scanForFloorSecrets(packageId, input.scrub?.extraDenyPatterns).length > 0
      ? `redacted-${createHash('sha256').update(packageId).digest('hex').slice(0, 8)}`
      : packageId;
  const quarantineDir = assertContained(
    ctx.stagingRoot,
    path.join(ctx.stagingRoot, 'quarantine', dirName),
    'quarantine dir',
  );
  // Fresh quarantine dir: it holds ONLY the block audit trail, so nothing from
  // an earlier attempt at the same id (least of all raw files) may survive here.
  rmSync(quarantineDir, { recursive: true, force: true });
  mkdirSync(quarantineDir, { recursive: true });

  // The block may have been caused by the metadata itself - the audit copy
  // must never carry the raw secret. Beyond the serialized scan, all string
  // VALUES are joined (punctuation-insensitive, keys excluded) so a mnemonic
  // split across separate fields cannot survive into the audit either.
  let safeBase = redactSecretStrings(base, input.scrub?.extraDenyPatterns);
  const joinedValues = collectStringValues(safeBase).join(' ');
  if (
    scanForFloorSecrets(stableJson(safeBase), input.scrub?.extraDenyPatterns).length > 0 ||
    scanForFloorSecrets(joinedValues, input.scrub?.extraDenyPatterns).length > 0
  ) {
    // Cross-value composition backstop: a secret split across several string
    // values only shows in the serialized view - drop the free-text carriers
    // wholesale. What remains are single validated segments and timestamps,
    // which cannot compose a 12-word run on their own.
    safeBase = {
      schemaVersion: safeBase.schemaVersion,
      packageId: safeBase.packageId,
      taskKey: safeBase.taskKey,
      surface: safeBase.surface,
      project: safeBase.project,
      domain: safeBase.domain,
      run: {
        startedAt: safeBase.run.startedAt,
        flow: safeBase.run.flow,
        outcome: safeBase.run.outcome,
      },
      task: { title: '[REDACTED:residual-secret]', sourceKind: safeBase.task.sourceKind },
    };
    // The preserved fixed fields are rescanned too: schema-valid segments can
    // still compose a phrase across values (hyphenated wordlist segments in
    // surface/project/domain/flow/taskKey). On a residual hit the
    // audit manifest goes fully generic - only timestamps and closed enums
    // remain, which cannot compose a word run.
    const fallbackJoined = collectStringValues(safeBase).join(' ');
    if (
      scanForFloorSecrets(stableJson(safeBase), input.scrub?.extraDenyPatterns).length > 0 ||
      scanForFloorSecrets(fallbackJoined, input.scrub?.extraDenyPatterns).length > 0
    ) {
      // Placeholders are SCHEMA-VALID so the quarantine manifest stays a
      // conformant audit record: packageId keeps the run-slug shape, identity
      // fields and taskKey keep the safe-segment/taskKey shapes, timestamps and
      // closed enums are preserved. `redacted` matches every identity pattern.
      const redactedSlug = `00000000T000000Z-redacted-redacted-${createHash('sha256')
        .update(base.packageId)
        .digest('hex')
        .slice(0, 8)}`;
      safeBase = {
        schemaVersion: safeBase.schemaVersion,
        packageId: redactedSlug,
        taskKey: 'redacted',
        surface: 'redacted',
        project: 'redacted',
        domain: 'redacted',
        run: {
          startedAt: safeBase.run.startedAt,
          flow: 'redacted',
          outcome: safeBase.run.outcome,
        },
        task: { title: 'redacted', sourceKind: safeBase.task.sourceKind },
      };
    }
  }

  // Final schema-valid coercion: any patterned identity field that redaction
  // turned into a non-conforming marker is replaced with a conforming
  // placeholder, so the quarantine manifest always validates.
  const safeSeg = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
  const taskKeyForm = /^(?:[a-z0-9]+(?:-[a-z0-9]+)*|task-[a-f0-9]{16})$/;
  safeBase = {
    ...safeBase,
    packageId: RUN_SLUG_PATTERN.test(safeBase.packageId)
      ? safeBase.packageId
      : `00000000T000000Z-redacted-redacted-${createHash('sha256')
          .update(base.packageId)
          .digest('hex')
          .slice(0, 8)}`,
    taskKey: taskKeyForm.test(safeBase.taskKey) ? safeBase.taskKey : 'redacted',
    surface: safeSeg.test(safeBase.surface) ? safeBase.surface : 'redacted',
    project: safeSeg.test(safeBase.project) ? safeBase.project : 'redacted',
    domain: safeBase.domain === '' || safeSeg.test(safeBase.domain) ? safeBase.domain : 'redacted',
    run: {
      ...safeBase.run,
      flow: safeSeg.test(safeBase.run.flow) ? safeBase.run.flow : 'redacted',
    },
  };

  const manifest: Manifest = {
    ...safeBase,
    files: {},
    scrubbing: {
      status: 'blocked',
      scrubReport: 'scrub-report.json',
      floorVersion: SCRUB_FLOOR_VERSION,
    },
  };
  // Quarantine keeps only the block audit trail - never raw artifacts. The
  // report arrives pre-sanitized (quarantineSafeReport) - the SAME object the
  // blocked AssembleResult returns to the caller.
  writeFileSync(path.join(quarantineDir, 'manifest.json'), stableJson(manifest));
  writeFileSync(path.join(quarantineDir, 'scrub-report.json'), stableJson(safeReport));
  return quarantineDir;
}

/**
 * Assemble one learning package from a completed fleet run (spec section 2).
 * Always local and side-effect-free with respect to any repo or network - it
 * only stages files under `ctx.stagingRoot`.
 *
 * The fail-closed scrub gate runs before anything is staged. On a floor hit the
 * result is `blocked`: only a local quarantine dir (manifest + scrub-report, no
 * raw artifacts) is written, `packageDir` is absent, and the result can never be
 * handed to a repo write.
 */
export function assembleLearningPackage(
  input: LearningPackageInput,
  ctx: HandoffContext,
): AssembleResult {
  // The run-slug keys both the staging dir and the quarantine dir - a
  // path-shaped id must never place either outside ctx.stagingRoot. The other
  // key fields become repo path segments at write time; failing fast here hands
  // the producer the teaching error at assembly instead of at the share step.
  assertSafePathSegment(input.runRecord.packageId, 'runRecord.packageId');
  assertSafePathSegment(input.surface, 'surface');
  assertSafePathSegment(input.runRecord.project, 'runRecord.project');
  assertSafePathSegment(input.runRecord.run.flow, 'runRecord.run.flow');
  if (input.runRecord.domain !== '') {
    assertSafePathSegment(input.runRecord.domain, 'runRecord.domain');
  }

  // Ticket handling: tickets are hyphen-normalized wherever they become path
  // segments (matching the run-slug grammar), and a ticket that normalizes to
  // nothing (punctuation-only) is DROPPED - the ticket is optional and the
  // taskKey derivation falls back to the content hash on its own.
  const rawTicket = input.runRecord.task.ticket;
  const normalizedTicket = rawTicket ? normalizeTicket(rawTicket) : '';
  const task: ManifestTask = { ...input.runRecord.task };
  if (rawTicket !== undefined && normalizedTicket === '') delete task.ticket;
  if (normalizedTicket !== '') {
    assertSafePathSegment(normalizedTicket, 'runRecord.task.ticket');
  }

  requirePath(input.taskDoc.taskMd, 'taskDoc.taskMd');
  const reportMd = path.join(input.artifacts.artifactsDir, 'report.md');
  const learningsMd = path.join(input.artifacts.artifactsDir, 'learnings.md');
  requirePath(reportMd, 'artifacts/report.md');
  requirePath(learningsMd, 'artifacts/learnings.md');

  // The three required documents are read eagerly: a read failure here is a
  // HARD assembly failure (a MUST file silently omitted as unscannable would
  // otherwise produce a pass-status package missing its terminal contract).
  const readRequired = (absolutePath: string, label: string): string => {
    try {
      return readFileSync(absolutePath, 'utf8');
    } catch (error) {
      throw new Error(
        `assembleLearningPackage: required ${label} at ${absolutePath} could not be read ` +
          `(${(error as Error).message}). Next: fix the file permissions/encoding - the ` +
          'terminal contract requires this document.',
      );
    }
  };
  const taskMdContent = readRequired(input.taskDoc.taskMd, 'task.md');
  const reportMdContent = readRequired(reportMd, 'report.md');
  const learningsMdContent = readRequired(learningsMd, 'learnings.md');

  const tokens = {
    workspace: ctx.workspace,
    farmslotHome: ctx.farmslotHome,
    home: os.homedir(),
  };

  const sourceDocument = buildSourceDocument(input);
  const provenance: Provenance = {
    schemaVersion: SCHEMA_VERSION,
    resolutions: input.templateProvenance,
  };

  const harness = harnessTextInputs(input.artifacts.harnessOutputDirs ?? []);
  const harnessKinds = new Map(harness.map((h) => [h.input.packagePath, h.kind]));

  const textInputs: ScrubInputFile[] = [
    { packagePath: 'task.md', content: taskMdContent },
    { packagePath: 'report.md', content: reportMdContent },
    { packagePath: 'learnings.md', content: learningsMdContent },
    { packagePath: 'source.json', content: stableJson(sourceDocument) },
    { packagePath: 'provenance.json', content: stableJson(provenance) },
    ...harness.map((h) => h.input),
  ];

  // Optional human grade: copied verbatim (post-scrub) as grade.json. An
  // absent or missing-on-disk grade is skipped - the package stays valid. A
  // PRESENT but malformed grade is a hard refusal (same strictness as the
  // required documents): optional content must be valid or absent.
  const gradeJson = input.artifacts.gradeJson;
  if (gradeJson && existsSync(gradeJson)) {
    let gradeRaw: string;
    try {
      gradeRaw = readFileSync(gradeJson, 'utf8');
    } catch (error) {
      throw new Error(
        `assembleLearningPackage: grade.json at ${gradeJson} could not be read ` +
          `(${(error as Error).message}). Next: fix the file or drop artifacts.gradeJson.`,
      );
    }
    let parsedGrade: unknown;
    try {
      parsedGrade = JSON.parse(gradeRaw);
    } catch (error) {
      throw new Error(
        `assembleLearningPackage: grade.json at ${gradeJson} is not valid JSON ` +
          `(${(error as Error).message}). Next: fix the producer's grade output or drop ` +
          'artifacts.gradeJson - optional content must be valid or absent.',
      );
    }
    const gradeErrors = validateAgainstSchema(parsedGrade, loadSchema('grade'));
    if (gradeErrors.length > 0) {
      throw new Error(
        `assembleLearningPackage: grade.json at ${gradeJson} fails the grade schema:\n` +
          `${gradeErrors.map((e) => `  - ${e.path}: ${e.message}`).join('\n')}\n` +
          "Next: fix the producer's grade output or drop artifacts.gradeJson - optional " +
          'content must be valid or absent.',
      );
    }
    textInputs.push({ packagePath: 'grade.json', content: gradeRaw });
  }

  const mediaInputs: ScrubInputFile[] = (input.media ?? []).map((m) => {
    // An attestation must attest THIS file: a mismatched visualPass.file would
    // assemble ok but record the attestation under a different path, producing
    // a package the validator rejects. Fail fast at the source instead.
    if (m.visualPass && m.visualPass.file !== m.packagePath) {
      throw new Error(
        `assembleLearningPackage: visualPass.file '${m.visualPass.file}' does not match its ` +
          `media packagePath '${m.packagePath}'. Next: attach the attestation produced for ` +
          'this exact file - attestations are per-file, never shared.',
      );
    }
    return {
      packagePath: m.packagePath,
      absolutePath: m.absolutePath,
      isMedia: true,
      evidenceManifestSelected: m.evidenceManifestSelected,
      visualPass: m.visualPass,
    };
  });

  // One input per package-relative path: a duplicate would let a second,
  // unapproved input replace already-approved bytes at staging time.
  const allInputs = [...textInputs, ...mediaInputs];
  const seenPaths = new Set<string>();
  for (const { packagePath } of allInputs) {
    if (seenPaths.has(packagePath)) {
      throw new Error(
        `assembleLearningPackage: duplicate package path '${packagePath}' across inputs. ` +
          'Next: give each artifact a unique package-relative path (check media entries ' +
          'and harness output dirs for collisions).',
      );
    }
    seenPaths.add(packagePath);
  }

  const base = manifestBase(input, task);
  // The manifest metadata (title, description, run fields, extensions) is
  // caller-composed content: it passes the same floor gate as every file,
  // BEFORE anything is staged - a secret in task.title blocks like any other.
  const metadataHits = scanForFloorSecrets(stableJson(base), input.scrub?.extraDenyPatterns);

  // Caller-provided strings that land in WRITTEN files without being file
  // content themselves: package-relative paths (scrub report entries,
  // artifacts/index.json, manifest.files keys) and visual-pass attestation
  // fields. A secret in a filename or attestation blocks like any other.
  const callerStrings = [
    ...allInputs.map((file) => file.packagePath),
    ...(input.media ?? []).flatMap((m) =>
      m.visualPass
        ? [m.visualPass.file, m.visualPass.attestedBy, m.visualPass.passedAt, m.visualPass.finding]
        : [],
    ),
  ];
  const inputStringHits = scanForFloorSecrets(
    callerStrings.join('\n'),
    input.scrub?.extraDenyPatterns,
  );

  const outcome = scrubFiles(allInputs, tokens, input.scrub ?? {});
  const blockedRecords = [
    ...outcome.report.blocked,
    ...inputStringHits.map((hit) => ({
      file: 'input-metadata',
      kind: hit.kind,
      fingerprint: hit.fingerprint,
    })),
    ...metadataHits.map((hit) => ({
      file: 'manifest.json',
      kind: hit.kind,
      fingerprint: hit.fingerprint,
    })),
  ];
  const report: ScrubReport = {
    ...outcome.report,
    // A package is a deterministic snapshot of one run. Restaging unchanged
    // run inputs must not change bytes merely because the scrub happened later.
    scannedAt: input.runRecord.run.finishedAt ?? input.runRecord.run.startedAt,
    status: blockedRecords.length > 0 ? 'blocked' : 'pass',
    blocked: blockedRecords,
  };

  if (report.status === 'blocked') {
    // The blocked barrier covers the staging area too: a pass-status package
    // from an EARLIER attempt at the same id must not survive beside the
    // quarantine, or its stale artifacts would remain publishable.
    const staleDir = assertContained(
      ctx.stagingRoot,
      path.join(ctx.stagingRoot, input.runRecord.packageId),
      'staging dir',
    );
    rmSync(staleDir, { recursive: true, force: true });
    // Sanitize ONCE: the persisted quarantine copy and the returned result
    // carry the same object, so a caller logging result.scrubReport can never
    // see the raw secret either.
    const safeReport = quarantineSafeReport(report, input.scrub?.extraDenyPatterns);
    const quarantineDir = writeQuarantine(ctx, input, base, safeReport);
    return { status: 'blocked', quarantineDir, scrubReport: safeReport };
  }

  // Fresh staging dir per assemble: a reused dir could carry stale, unscanned
  // files from an earlier attempt into a pass-status package. Containment is
  // asserted BEFORE the destructive rm so a symlinked ancestor cannot redirect
  // either the removal or the staging writes outside the staging root.
  const packageDir = assertContained(
    ctx.stagingRoot,
    path.join(ctx.stagingRoot, input.runRecord.packageId),
    'staging dir',
  );
  rmSync(packageDir, { recursive: true, force: true });
  mkdirSync(packageDir, { recursive: true });

  // Stage retained text files (task/report/learnings/source/provenance/harness json).
  for (const file of outcome.retainedText) {
    writePackageFile(packageDir, file.packagePath, file.content);
  }

  // Copy retained media by original path (already visual-pass-cleared).
  const mediaByPackagePath = new Map((input.media ?? []).map((m) => [m.packagePath, m]));
  for (const packagePath of outcome.retainedMedia) {
    const media = mediaByPackagePath.get(packagePath);
    if (!media) continue;
    const dest = assertContained(
      packageDir,
      path.join(packageDir, packagePath),
      `media file ${packagePath}`,
    );
    mkdirSync(path.dirname(dest), { recursive: true });
    copyFileSync(media.absolutePath, dest);
  }

  // Build artifacts/index.json from the retained harness json + media.
  const artifacts: ArtifactRecord[] = [];
  for (const file of outcome.retainedText) {
    if (!file.packagePath.startsWith('harness/')) continue;
    const abs = path.join(packageDir, file.packagePath);
    artifacts.push({
      path: file.packagePath,
      sha256: sha256File(abs),
      bytes: statSync(abs).size,
      kind: harnessKinds.get(file.packagePath) ?? 'other',
      origin: 'harness',
    });
  }
  for (const packagePath of outcome.retainedMedia) {
    const media = mediaByPackagePath.get(packagePath);
    if (!media) continue;
    const abs = path.join(packageDir, packagePath);
    artifacts.push({
      path: packagePath,
      sha256: sha256File(abs),
      bytes: statSync(abs).size,
      kind: media.kind,
      origin: 'enrichment',
      evidenceManifestSelected: true,
      visualPassCleared: true,
    });
  }
  const artifactsIndex: ArtifactsIndex = { schemaVersion: SCHEMA_VERSION, artifacts };
  writePackageFile(packageDir, 'artifacts/index.json', stableJson(artifactsIndex));
  writePackageFile(packageDir, 'scrub-report.json', stableJson(report));

  // Hash every stored file except manifest.json (which carries the hashes).
  const files: Record<string, ManifestFileRecord> = {};
  for (const abs of walkFiles(packageDir)) {
    const rel = path.relative(packageDir, abs).split(path.sep).join('/');
    if (rel === 'manifest.json') continue;
    files[rel] = {
      sha256: sha256File(abs),
      bytes: statSync(abs).size,
      role: REQUIRED_SET.has(rel) ? 'required' : 'optional',
    };
  }

  const manifest: Manifest = {
    ...base,
    files,
    scrubbing: {
      status: 'pass',
      scrubReport: 'scrub-report.json',
      floorVersion: SCRUB_FLOOR_VERSION,
    },
  };
  writePackageFile(packageDir, 'manifest.json', stableJson(manifest));

  // Conformance: an ok result means all eight MUST files were staged. A
  // required document the gate classified unscannable (e.g. binary content)
  // is a hard assembly failure, never a silent 7-file "pass".
  const missingRequired = REQUIRED_FILES.filter(
    (required) => !existsSync(path.join(packageDir, required)),
  );
  if (missingRequired.length > 0) {
    const reasons = new Map(report.omitted.map((o) => [o.path, o.reason]));
    const detail = missingRequired
      .map((file) => `${file}${reasons.has(file) ? ` (${reasons.get(file)})` : ''}`)
      .join(', ');
    throw new Error(
      `assembleLearningPackage: required file(s) missing from the staged package: ${detail}. ` +
        'Next: required documents must be readable UTF-8 text - fix the source files and ' +
        're-assemble; a package without its MUST files is never valid.',
    );
  }

  return { status: 'ok', packageDir, manifest, scrubReport: report };
}
