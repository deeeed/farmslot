import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { scrubFiles, type ScrubInputFile } from '../scrub/scrubber.js';
import { deriveTaskKey } from '../spec/task-key.js';
import type {
  ArtifactKind,
  ArtifactRecord,
  ArtifactsIndex,
  Manifest,
  ManifestFileRecord,
  Provenance,
  ScrubReport,
  SourceDocument,
} from '../spec/types.js';
import { REQUIRED_FILES, SCHEMA_VERSION, SCRUB_FLOOR_VERSION } from '../spec/version.js';

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
  const abs = path.join(root, relativePath);
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
  return { schemaVersion: SCHEMA_VERSION, sourceKind: input.runRecord.task.sourceKind, ...source };
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

function writeQuarantine(
  ctx: HandoffContext,
  input: LearningPackageInput,
  scrubReport: ScrubReport,
): string {
  const quarantineDir = path.join(ctx.stagingRoot, 'quarantine', input.runRecord.packageId);
  mkdirSync(quarantineDir, { recursive: true });
  const manifest: Manifest = {
    schemaVersion: SCHEMA_VERSION,
    packageId: input.runRecord.packageId,
    taskKey: taskKeyFor(input),
    surface: input.surface,
    project: input.runRecord.project,
    ...(input.runRecord.repo ? { repo: input.runRecord.repo } : {}),
    domain: input.runRecord.domain,
    engineer: input.runRecord.engineer,
    run: input.runRecord.run,
    task: input.runRecord.task,
    files: {},
    scrubbing: {
      status: 'blocked',
      scrubReport: 'scrub-report.json',
      floorVersion: SCRUB_FLOOR_VERSION,
    },
    ...(input.runRecord.extensions ? { extensions: input.runRecord.extensions } : {}),
  };
  // Quarantine keeps only the block audit trail - never raw artifacts.
  writeFileSync(path.join(quarantineDir, 'manifest.json'), stableJson(manifest));
  writeFileSync(path.join(quarantineDir, 'scrub-report.json'), stableJson(scrubReport));
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
  requirePath(input.taskDoc.taskMd, 'taskDoc.taskMd');
  const reportMd = path.join(input.artifacts.artifactsDir, 'report.md');
  const learningsMd = path.join(input.artifacts.artifactsDir, 'learnings.md');
  requirePath(reportMd, 'artifacts/report.md');
  requirePath(learningsMd, 'artifacts/learnings.md');

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
    { packagePath: 'task.md', absolutePath: input.taskDoc.taskMd },
    { packagePath: 'report.md', absolutePath: reportMd },
    { packagePath: 'learnings.md', absolutePath: learningsMd },
    { packagePath: 'source.json', content: stableJson(sourceDocument) },
    { packagePath: 'provenance.json', content: stableJson(provenance) },
    ...harness.map((h) => h.input),
  ];

  // Optional human grade: copied verbatim (post-scrub) as grade.json. An
  // absent or missing-on-disk grade is skipped - the package stays valid.
  const gradeJson = input.artifacts.gradeJson;
  if (gradeJson && existsSync(gradeJson)) {
    textInputs.push({ packagePath: 'grade.json', absolutePath: gradeJson });
  }

  const mediaInputs: ScrubInputFile[] = (input.media ?? []).map((m) => ({
    packagePath: m.packagePath,
    absolutePath: m.absolutePath,
    isMedia: true,
    evidenceManifestSelected: m.evidenceManifestSelected,
    visualPass: m.visualPass,
  }));

  const outcome = scrubFiles([...textInputs, ...mediaInputs], tokens);

  if (outcome.status === 'blocked') {
    const quarantineDir = writeQuarantine(ctx, input, outcome.report);
    return { status: 'blocked', quarantineDir, scrubReport: outcome.report };
  }

  const packageDir = path.join(ctx.stagingRoot, input.runRecord.packageId);
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
    const dest = path.join(packageDir, packagePath);
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
  writePackageFile(packageDir, 'scrub-report.json', stableJson(outcome.report));

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
    schemaVersion: SCHEMA_VERSION,
    packageId: input.runRecord.packageId,
    taskKey: taskKeyFor(input),
    surface: input.surface,
    project: input.runRecord.project,
    ...(input.runRecord.repo ? { repo: input.runRecord.repo } : {}),
    domain: input.runRecord.domain,
    engineer: input.runRecord.engineer,
    run: input.runRecord.run,
    task: input.runRecord.task,
    files,
    scrubbing: {
      status: 'pass',
      scrubReport: 'scrub-report.json',
      floorVersion: SCRUB_FLOOR_VERSION,
    },
    ...(input.runRecord.extensions ? { extensions: input.runRecord.extensions } : {}),
  };
  writePackageFile(packageDir, 'manifest.json', stableJson(manifest));

  return { status: 'ok', packageDir, manifest, scrubReport: outcome.report };
}
