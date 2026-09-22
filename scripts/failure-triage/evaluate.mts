import { createHash } from 'node:crypto';
import { writeAtomicJSON } from '../../services/gateway/src/core/atomic-json.js';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  evaluateTriage,
  type TriageOptions,
} from '../../services/gateway/src/assessment/failure-triage/evaluate.js';
import { assertNoCredentials } from '../../services/gateway/src/assessment/record-validation.js';

function parse(args: string[]): TriageOptions {
  const options: TriageOptions = { out: '' };
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--live') {
      options.live = true;
      continue;
    }
    if (key === '--help') {
      console.log(
        'Usage: yarn triage:evaluate --out <new-directory> [--live --provider typesafe --model jev-1.13.0] [--split development|held-out] [--max-calls 1..60] [--max-usd <=0.10] [--timeout-ms <=10000] [--max-bytes <=24000] [--case <opaque-id>]\nDefault: offline baselines and hold. Test-only transport: --fixture valid|invalid-label|fabricated-evidence|timeout|rate-limit|credential-echo|control-action; cannot combine with --live.',
      );
      process.exit(0);
    }
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error('Missing option value');
    switch (key) {
      case '--out':
        options.out = path.resolve(value);
        break;
      case '--provider':
        if (!/^[\w.-]{1,100}$/.test(value)) throw new Error('Invalid provider');
        options.provider = value;
        break;
      case '--model':
        if (!/^[\w.-]{1,100}$/.test(value)) throw new Error('Invalid model');
        options.model = value;
        break;
      case '--max-calls':
        options.maxCalls = Number(value);
        break;
      case '--max-usd':
        options.maxUsd = Number(value);
        break;
      case '--timeout-ms':
        options.timeoutMs = Number(value);
        break;
      case '--max-bytes':
        options.maxBytes = Number(value);
        break;
      case '--case':
        options.caseId = value;
        break;
      case '--split':
        if (value !== 'development' && value !== 'held-out') throw new Error('Invalid split');
        options.split = value;
        break;
      case '--fixture':
        if (
          ![
            'valid',
            'invalid-label',
            'fabricated-evidence',
            'timeout',
            'rate-limit',
            'credential-echo',
            'control-action',
          ].includes(value)
        )
          throw new Error('Invalid fixture');
        options.fixture = value as TriageOptions['fixture'];
        break;
      default:
        throw new Error('Unknown evaluation option');
    }
  }
  if (!options.out) throw new Error('--out is required and must be a new directory');
  return options;
}
try {
  const options = parse(process.argv.slice(2));
  assertNoCredentials(JSON.stringify(options));
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const dirty =
    execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0;
  const sourceFiles = [
    ...[
      'types',
      'packet',
      'baselines',
      'corpus',
      'corpus-lock',
      'metrics',
      'evaluate',
      'transport',
    ].map((n) => `services/gateway/src/assessment/failure-triage/${n}.ts`),
    'scripts/failure-triage/evaluate.mts',
    'scripts/failure-triage/generate-corpus.mts',
    'services/gateway/src/assessment/typesafe.ts',
    'services/gateway/src/assessment/provider.ts',
    'services/gateway/src/assessment/default-providers.ts',
    'services/gateway/src/assessment/input.ts',
    'services/gateway/src/assessment/record-validation.ts',
    'services/gateway/src/core/failure-patterns.ts',
    'services/gateway/src/observability/log-registry.ts',
  ];
  const sourceManifest = Object.fromEntries(
    await Promise.all(
      sourceFiles.map(async (file) => [
        file,
        createHash('sha256')
          .update(await readFile(file))
          .digest('hex'),
      ]),
    ),
  );
  const sourceSnapshotHash = createHash('sha256')
    .update(JSON.stringify(sourceManifest))
    .digest('hex');
  const report = await evaluateTriage(options);
  await writeAtomicJSON(path.join(options.out, 'source-manifest.json'), {
    revision,
    dirty,
    sourceSnapshotHash,
    files: sourceManifest,
  });
  const reportText = `# Failure-triage evaluation\n\nRevision: ${revision}; checkout dirty: ${dirty}. Source snapshot: ${sourceSnapshotHash}.\nCorpus: ${report.corpusHash}.\nRubric: ${report.rubricVersion}; baselines: ${report.baselineVersion}.\n\nDecision: **${report.decision}**. Live status: ${report.liveStatus}. Efficiency: ${report.efficiencyClaim}.\n\n| Measure | Existing baseline | Diagnostic cues | Candidate |\n| --- | --- | --- | --- |\n| Correct / cases | ${report.baselines.deterministic.correct}/${report.selectedCases} | ${report.baselines.diagnosticCueSheet.correct}/${report.selectedCases} | ${report.metrics.correct}/${report.selectedCases} |\n| Macro-F1 | ${report.baselines.deterministic.macroF1} | ${report.baselines.diagnosticCueSheet.macroF1} | ${report.metrics.macroF1} |\n\nAttempts: ${report.usage.attempts}; reserved USD: ${report.usage.reservedUsd}; known estimated USD: ${report.usage.knownEstimatedUsd}; unknown charges: ${report.usage.unknownCharges}.\nBatch time: ${report.latency.batchMs}ms.\n\n${report.pilotGate.checks.map((c) => `- ${c.passed ? 'PASS' : 'HOLD'}: ${c.id}`).join('\n')}\n\n${report.limitations.map((l) => `- ${l}`).join('\n')}\n`;
  assertNoCredentials(reportText);
  await writeFile(path.join(options.out, 'report.md'), reportText, { flag: 'wx', mode: 0o600 });
  const details = JSON.parse(await readFile(path.join(options.out, 'evaluation.json'), 'utf8'));
  await writeAtomicJSON(path.join(options.out, 'evaluation.json'), {
    ...details,
    revision,
    dirty,
    sourceSnapshotHash,
  });
  console.log(
    JSON.stringify({
      out: options.out,
      liveStatus: report.liveStatus,
      decision: report.decision,
      cases: report.selectedCases,
      attempts: report.usage.attempts,
      knownEstimatedUsd: report.usage.knownEstimatedUsd,
      reservedUsd: report.usage.reservedUsd,
      macroF1: {
        baseline: report.baselines.deterministic.macroF1,
        cueSheet: report.baselines.diagnosticCueSheet.macroF1,
        candidate: report.metrics.macroF1,
      },
      efficiencyClaim: report.efficiencyClaim,
    }),
  );
} catch (error) {
  // Local path/SDK errors can contain sensitive values. Emit a bounded controlled failure.
  const allowed = [
    'Missing option value',
    'Invalid provider',
    'Invalid model',
    'Invalid split',
    'Invalid fixture',
    'Unknown evaluation option',
    '--out is required and must be a new directory',
    'Invalid evaluation limits',
    'Transport fixtures cannot be live evidence',
    'No selected corpus case',
  ];
  console.error(
    error instanceof Error && allowed.includes(error.message)
      ? error.message
      : 'Evaluation failed; preserve the output directory and inspect its durable attempt records.',
  );
  process.exitCode = 1;
}
