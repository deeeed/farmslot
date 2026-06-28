#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { WebSocketServer } from 'ws';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../..');
const commandCenterDir = resolve(repoRoot, 'apps/command-center');
const uiDir = resolve(commandCenterDir, 'ui');
const defaultRecipe = resolve(
  repoRoot,
  'docs/examples/recipes/farmslot/docusaurus-human-ready-gate.recipe.json',
);
const docsScreenshot = resolve(
  repoRoot,
  'apps/docs/static/img/demos/command-center-human-ready-gate.png',
);

const forbidden = [/wallet/i, /seed phrase/i, /private key/i];
const fixturePort = Number(process.env.FARMSLOT_DEMO_GATEWAY_PORT || 7787);
const uiPort = Number(process.env.FARMSLOT_DEMO_UI_PORT || 5188);
const cdpPort = Number(process.env.FARMSLOT_DEMO_CDP_PORT || 9325);
const uiUrl = `http://localhost:${uiPort}/`;
const targetHash =
  '#slot/demo-ready-slot?runId=demo-ready-run-1&tab=pr-preview&reviewDrawer=primary';
const targetUrl = `${uiUrl}${targetHash}`;
const copyToDocs = process.argv.includes('--copy-to-docs');
const args = parseArgs(process.argv.slice(2));
const recipePath = resolve(repoRoot, args.recipe || defaultRecipe);
const artifactsDir = resolve(
  repoRoot,
  args.artifactsDir || '.agent/demo-stage/docusaurus-human-ready-gate/output',
);

const trace = [];
const children = [];
let fixture;

main().catch((err) => {
  cleanup();
  console.error(err instanceof Error ? err.stack || err.message : err);
  process.exit(1);
});

async function main() {
  const recipe = JSON.parse(readFileSync(recipePath, 'utf8'));
  mkdirSync(artifactsDir, { recursive: true });
  for (const dir of ['screenshots', 'logs'])
    mkdirSync(resolve(artifactsDir, dir), { recursive: true });
  copyFileSync(recipePath, resolve(artifactsDir, 'recipe.json'));

  step('prepare-fixture', 'started', 'Starting sanitized ready-gate fixture gateway');
  fixture = await startFixtureGateway();
  step('prepare-fixture', 'passed', `Fixture gateway listening on ${fixturePort}`);

  step('open-command-center', 'started', 'Opening real Command Center UI against fixture gateway');
  await ensureUiDevServer();
  await ensureChrome();
  await prepareView();
  step('open-command-center', 'passed', 'Command Center ready gate rendered');

  step('verify-public-safe-gate', 'started', 'Verifying gate controls and public-safe labels');
  const verification = await verifyReadyGate();
  step(
    'verify-public-safe-gate',
    'passed',
    `Visible chars=${verification.length}; human gate actions and evidence are visible`,
  );

  const screenshotPath = resolve(artifactsDir, 'screenshots/command-center-human-ready-gate.png');
  await captureScreenshot(screenshotPath);
  if (copyToDocs) {
    mkdirSync(dirname(docsScreenshot), { recursive: true });
    copyFileSync(screenshotPath, docsScreenshot);
  }

  writeOutputs({ recipe, screenshotPath, verification });
  cleanup();
  console.log(
    JSON.stringify({ ok: true, artifactsDir, screenshotPath, copiedToDocs: copyToDocs }, null, 2),
  );
  process.exit(0);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--artifacts-dir') out.artifactsDir = argv[++i];
    else if (arg === '--recipe') out.recipe = argv[++i];
  }
  return out;
}

function demoNow(offsetMs = 0) {
  return new Date(Date.UTC(2026, 5, 12, 10, 0, 0) + offsetMs).toISOString();
}

const diffText = `diff --git a/apps/docs/docs/products/command-center.md b/apps/docs/docs/products/command-center.md
index 1111111..2222222 100644
--- a/apps/docs/docs/products/command-center.md
+++ b/apps/docs/docs/products/command-center.md
@@ -12,6 +12,10 @@
 - Use Command Center as the cockpit for live runs.
 - Keep external app evidence behind Farmslot gates.
+- Add a reproducible human-ready gate recipe.
+- Show accept / continue-steering decisions from Command Center.
+- Include proof artifacts, recipe trace, and diff snapshot.
+- Exclude private project names from public media.
`;

const artifacts = [
  {
    path: 'artifacts/screenshots/audiolab-sample-banner-ios-final.png',
    purpose: 'screenshot',
    label: 'AudioLab iOS sample-load evidence',
    type: 'screenshot',
    mimeType: 'image/png',
    sizeBytes: 94231,
    sha256: '1111111111111111111111111111111111111111111111111111111111111111',
  },
  {
    path: 'artifacts/screenshots/echobridge-live-recording-ios-final.png',
    purpose: 'screenshot',
    label: 'EchoBridge iOS live-recording evidence',
    type: 'screenshot',
    mimeType: 'image/png',
    sizeBytes: 104552,
    sha256: '2222222222222222222222222222222222222222222222222222222222222222',
  },
  {
    path: 'artifacts/videos/ready-gate-steering.mp4',
    purpose: 'video',
    label: 'Human gate steering clip',
    type: 'video',
    mimeType: 'video/mp4',
    sizeBytes: 421992,
    sha256: '3333333333333333333333333333333333333333333333333333333333333333',
  },
  {
    path: 'artifacts/recipe.json',
    purpose: 'recipe',
    label: 'Capture recipe',
    type: 'recipe',
    mimeType: 'application/json',
    sizeBytes: 3840,
    sha256: '4444444444444444444444444444444444444444444444444444444444444444',
  },
  {
    path: 'artifacts/diff.patch',
    purpose: 'diff',
    label: 'Reviewed diff snapshot',
    type: 'text',
    mimeType: 'text/x-diff',
    sizeBytes: 702,
    sha256: '5555555555555555555555555555555555555555555555555555555555555555',
  },
  {
    path: 'artifacts/trace.json',
    purpose: 'trace',
    label: 'Recipe execution trace',
    type: 'json',
    mimeType: 'application/json',
    sizeBytes: 1914,
    sha256: '6666666666666666666666666666666666666666666666666666666666666666',
  },
  {
    path: 'artifacts/pr-package.md',
    purpose: 'pr-package',
    label: 'Publish package preview',
    type: 'markdown',
    mimeType: 'text/markdown',
    sizeBytes: 2488,
    sha256: '7777777777777777777777777777777777777777777777777777777777777777',
  },
];

const readyPayload = {
  kind: 'ready',
  prNumber: null,
  repo: null,
  diffStat: { files: 3, additions: 74, deletions: 12 },
  workerReport:
    '## Worker report\\n\\nImplemented the Docusaurus human-ready gate demo stage from public-safe Farmslot data.\\n\\n- Added a reproducible capture recipe.\\n- Verified Command Center renders the ready gate, evidence, recipe, quality, and diff tabs.\\n- Kept external app screenshots as gate evidence instead of standalone product marketing.',
  branch: 'docs/real-demo-media',
  slotId: 'demo-ready-slot',
  headSha: 'f00dbabe1234567890abcdef1234567890abcdef',
  recipeJson: JSON.stringify(
    {
      id: 'docusaurus-human-ready-gate',
      title: 'Capture Command Center human ready gate',
      nodes: [
        { id: 'prepare-fixture', kind: 'setup', label: 'Start sanitized fixture gateway' },
        {
          id: 'open-command-center',
          kind: 'browser',
          label: 'Render real Command Center ready workspace',
        },
        {
          id: 'verify-public-safe-gate',
          kind: 'assert',
          label: 'Assert human actions and evidence are visible',
        },
        { id: 'capture-screenshot', kind: 'screenshot', label: 'Capture gate screenshot' },
      ],
    },
    null,
    2,
  ),
  recipeQualityArtifact: {
    version: 1,
    verdict: 'pass',
    compact: {
      verdict: 'PASS',
      reasons: [
        'Recipe drives the real Command Center UI through a gateway-compatible fixture.',
        'Proof includes visible actions, diff, evidence, trace, and recipe artifacts.',
        'Forbidden private project patterns are asserted absent before export.',
      ],
      better_version_guidance: [
        'Record a manual steering video after the screenshot composition is approved.',
      ],
    },
    dimensions: {},
    structural_findings: [],
    contextual_findings: [],
    suggested_recipe_delta: [],
    training_fields: {
      farm: 'farmslot-farm',
      project: 'farmslot-farm',
      flow_type: 'dev',
      proof_mode: 'mixed',
      good_patterns: ['public-safe fixture gateway', 'real UI capture', 'human-gate evidence'],
    },
    meta: {
      producer: 'gateway',
      fallback_used: false,
      legacy_task: false,
      artifact_required: true,
      source_signals: ['screenshot', 'recipe-json', 'trace', 'diff'],
    },
  },
  qualityReport: {
    overallScore: 96,
    overrides: [],
    acVerdicts: [
      {
        ac: 'Show the human gate where an operator can accept or continue steering.',
        verdict: 'RELEVANT_HIGH',
        reasoning: 'The top bar exposes Mark Ready, Extra Review, and package controls.',
        evidenceRef: 'artifacts/screenshots/audiolab-sample-banner-ios-final.png',
      },
      {
        ac: 'Show proof-first evidence behind the gate.',
        verdict: 'RELEVANT_HIGH',
        reasoning: 'The package includes screenshots, video, recipe, diff, and trace artifacts.',
        evidenceRef: 'artifacts/trace.json',
      },
    ],
  },
  artifactManifest: artifacts.map(({ path, purpose, sizeBytes, sha256 }) => ({
    path,
    purpose,
    sizeBytes,
    sha256,
  })),
  selfReviewVerdict: 'pass',
  selfReviewSummary:
    'Self-review found no private project names and confirmed the gate remains reviewable without opening external apps.',
  workerLearnings:
    'Keep public demo media staged through Farmslot gates. External app captures are useful evidence, but the marketing surface should show the operating loop: dispatch, observe, validate, and decide.',
  ciChecks: [
    { name: 'docs:build', status: 'completed', conclusion: 'success' },
    { name: 'command-center:typecheck', status: 'completed', conclusion: 'success' },
  ],
  acceptanceCriteria: [
    'Ready gate is rendered from Command Center, not a generated mock card.',
    'Operator can see approve / extra review / continue-steering decision points.',
    'Evidence artifacts include screenshots, video, recipe JSON, trace, and diff snapshot.',
    'Public output excludes private project and machine labels.',
  ],
  inputSnapshot: {
    ticketData: {
      source: 'github',
      githubIssue: 'deeeed/farmslot#demo',
      title: 'DO-NOT-MERGE: build public Docusaurus ready-gate demo media',
      issueType: 'Demo fixture',
      affectedArea: 'Docusaurus / Command Center',
      labels: ['docs', 'demo', 'do-not-merge'],
      description:
        'Create a public-safe Farmslot demo that shows a completed run waiting for the human to accept, request extra review, or continue steering.',
      acceptanceCriteria: [
        'Use real Command Center UI.',
        'Show proof artifacts and recipe trace.',
        'Do not include private project names.',
      ],
    },
    taskPrompt:
      'Create the first approved human-ready gate screenshot for the Docusaurus landing page, using a reproducible capture recipe and sanitized Farmslot fixture data.',
    initialContext:
      'This is a public documentation demo for Farmslot as an agentic engineering framework.',
    checklist: [
      'Render ready workspace with package preview.',
      'Verify evidence and decision actions are visible.',
      'Capture screenshot only after public-safety assertions pass.',
    ],
  },
  prPackage: {
    id: 'pkg-demo-ready-gate-001',
    packageHash: 'pkg_farmslot_demo_ready_gate_20260612',
    packageInputHash: 'input_farmslot_demo_ready_gate',
    reviewSubjectHash: 'subject_farmslot_demo_ready_gate',
    artifactPath: 'artifacts/pr-package.md',
    branch: 'docs/real-demo-media',
    remoteBranchRef: null,
    headSha: 'f00dbabe1234567890abcdef1234567890abcdef',
    diffStat: { files: 3, additions: 74, deletions: 12 },
    draftTitle: 'docs: add real Command Center human-ready gate demo',
    draftBody:
      '## Summary\n\nAdds public-safe Docusaurus demo media for the Farmslot human-ready gate.\n\n## Evidence\n\n- ![AudioLab evidence](artifacts/screenshots/audiolab-sample-banner-ios-final.png)\n- ![EchoBridge evidence](artifacts/screenshots/echobridge-live-recording-ios-final.png)\n- Video: artifacts/videos/ready-gate-steering.mp4\n- Recipe: artifacts/recipe.json\n\n## Operator decision\n\nThe gate is ready for human review: approve the package, request extra review, or send feedback to continue steering.',
    evidenceManifest: artifacts.map(({ path, purpose, sizeBytes, sha256 }) => ({
      path,
      purpose,
      sizeBytes,
      sha256,
    })),
    selectedEvidenceKeys: [
      'artifacts/screenshots/audiolab-sample-banner-ios-final.png',
      'artifacts/screenshots/echobridge-live-recording-ios-final.png',
      'artifacts/videos/ready-gate-steering.mp4',
      'artifacts/recipe.json',
    ],
    validationSummaryPath: 'artifacts/validation-summary.md',
    validationSummaryHash: 'validation_demo_ready_gate',
    reviewArtifactIds: ['review-codex-static', 'review-cross-runner-live'],
    dispatchMode: 'interactive',
    gatePolicy: {
      owner: 'human',
      dispatchMode: 'interactive',
      publishAuthority: 'human',
      reason: 'Public documentation media requires human approval before publishing.',
    },
    reviewDepth: {
      minimumIndependentReviews: 1,
      requireCrossRunner: false,
      extraLoopsRequested: 0,
      requestedBy: 'human-gate',
    },
    publicationTarget: 'ready',
    publicationStatus: 'not_published',
    createdAt: demoNow(-120_000),
  },
  reviewDepth: {
    minimumIndependentReviews: 1,
    requireCrossRunner: false,
    extraLoopsRequested: 0,
    requestedBy: 'human-gate',
  },
  independentReviews: [
    {
      id: 'review-codex-static',
      source: 'human-gate',
      runner: 'codex',
      model: 'standard',
      crossRunner: true,
      loopNumber: 1,
      verdict: 'pass',
      unresolvedCount: 0,
      validationDepth: 'full-live',
      artifactPaths: ['artifacts/trace.json', 'artifacts/diff.patch'],
      reviewedHeadSha: 'f00dbabe1234567890abcdef1234567890abcdef',
      reviewedPackageInputHash: 'input_farmslot_demo_ready_gate',
      reviewedReviewSubjectHash: 'subject_farmslot_demo_ready_gate',
      startedAt: demoNow(-90_000),
      completedAt: demoNow(-60_000),
    },
  ],
  gatePolicy: {
    owner: 'human',
    dispatchMode: 'interactive',
    publishAuthority: 'human',
    reason: 'Human operator approves publication after reviewing artifacts.',
  },
  validationSummary:
    'Command Center ready workspace, recipe evidence, and package preview are visible and public-safe.',
  publicationTarget: 'ready',
  publicationStatus: 'not_published',
};

const decision = {
  id: 'decision-demo-ready-gate',
  type: 'ready',
  title: 'Ready for human gate: Docusaurus demo media',
  description:
    'Review the package, evidence, recipe, and diff before publishing the Docusaurus demo media.',
  createdAt: demoNow(-30_000),
  actions: [
    { id: 'approve-publish', label: 'Approve Publish', style: 'primary' },
    { id: 'request-extra-review', label: 'Extra Review', style: 'secondary' },
    { id: 'send-feedback', label: 'Send Feedback', style: 'secondary' },
  ],
  context: { runId: 'demo-ready-run-1', slotId: 'demo-ready-slot' },
  payload: readyPayload,
};

const run = {
  id: 'demo-ready-run-1',
  familyId: 'demo-ready-family-1',
  familyRootTicketOrPr: 'deeeed/farmslot#demo',
  lane: 'production',
  flowType: 'dev',
  mode: 'interactive',
  status: 'human-gating',
  project: 'farmslot-farm',
  ticketOrPr: 'DO-NOT-MERGE demo: Docusaurus human ready gate',
  slotId: 'demo-ready-slot',
  branch: 'docs/real-demo-media',
  taskFile: 'tasks/docusaurus-human-ready-gate.md',
  activeTaskFile: 'TASK.md',
  steps: [
    { name: 'dispatch', status: 'done', detail: 'Task dispatched to demo-ready-slot' },
    { name: 'work', status: 'done', detail: 'Capture script and recipe prepared' },
    { name: 'recipe', status: 'done', detail: 'Evidence recipe passed' },
    { name: 'human-gate', status: 'running', detail: 'Waiting for operator decision' },
  ],
  decisions: [decision],
  metrics: {
    runner: 'codex',
    model: 'standard',
    durationMs: 412000,
    costUsd: 0.18,
    tokensIn: 18422,
    tokensOut: 4196,
  },
  createdAt: demoNow(-420_000),
  updatedAt: demoNow(-20_000),
  summary: 'Ready gate waits for approval with AudioLab, EchoBridge, recipe, and diff evidence.',
  safetyTier: 'dangerous',
  allowedSlots: ['demo-ready-slot'],
  liveRecipeContext: {
    source: 'decision',
    recipeRunId: 'recipe-run-demo-ready-gate',
    artifactRoot: 'artifacts',
    artifactManifest: artifacts,
    usedTypedArtifactManifest: true,
    recipeJson: readyPayload.recipeJson,
    recipeQualityArtifact: readyPayload.recipeQualityArtifact,
    qualityReport: readyPayload.qualityReport,
    workerLearnings: readyPayload.workerLearnings,
    isStale: false,
    selectionReason: 'decision-derived',
  },
};

const slot = {
  slot: 'demo-ready-slot',
  machine: 'demo-farm',
  platform: 'darwin',
  project: 'farmslot-farm',
  health: { ssh: 'LOCAL', device: 'sim:OK', devserver: 'OK', cdp: 'OK', fixtures: 'OK' },
  branch: 'docs/real-demo-media',
  agent: 'codex',
  enabled: true,
  dispatchable: false,
  lifecycle: 'busy',
  phase: 'review-gate',
  warm: true,
  taskId: 'docusaurus-human-ready-gate',
  taskFile: 'tasks/docusaurus-human-ready-gate.md',
  activeTaskFile: 'TASK.md',
  currentRunId: run.id,
  currentFlowType: run.flowType,
  currentTicketOrPr: run.ticketOrPr,
  currentMode: run.mode,
  currentFamilyId: run.familyId,
  currentLane: run.lane,
  dispatchedAt: run.createdAt,
  completedAt: demoNow(-35_000),
  runner: 'codex',
  model: 'standard',
  resources: { devserver: { port: 5188 }, cdp: { port: cdpPort } },
  deviceName: 'Demo iOS Simulator',
  taskPhase: 'Human gate',
  taskStepProgress: 1,
  hostLoad: { cpuPercent: 18, memoryPercent: 54, diskPercent: 61, headroom: 'green' },
  agentContexts: [{ id: 'primary', label: 'worker', role: 'worker', active: true }],
};

const fleet = {
  checkedAt: demoNow(),
  slots: [
    slot,
    {
      ...slot,
      slot: 'demo-watch-slot',
      currentRunId: 'demo-monitor-run-2',
      lifecycle: 'busy',
      phase: 'working',
      taskId: 'parallel-monitoring-demo',
      taskFile: 'tasks/parallel-monitoring.md',
      currentTicketOrPr: 'Demo: parallel terminal monitoring',
      taskPhase: 'Recipe validation',
      taskStepProgress: 0.6,
      runner: 'claude',
      model: 'haiku',
    },
  ],
  summary: {
    total: 2,
    ready: 0,
    busy: 2,
    held: 0,
    manual: 0,
    disabled: 0,
    blocked: 0,
    warmCount: 2,
  },
  machines: [
    {
      machine: 'demo-farm',
      status: 'ok',
      slots: 2,
      checkedAt: demoNow(),
      load: { cpuPercent: 18, memoryPercent: 54, diskPercent: 61, headroom: 'green' },
    },
  ],
};

const recipeRun = {
  id: 'recipe-run-demo-ready-gate',
  label: 'Current ready-gate recipe run',
  groupKind: 'current-artifacts',
  promoted: true,
  status: 'pass',
  source: 'decision',
  recipeRunId: 'recipe-run-demo-ready-gate',
  artifactRoot: 'artifacts',
  artifactManifest: artifacts,
  usedTypedArtifactManifest: true,
  recipeJson: readyPayload.recipeJson,
  recipeQualityArtifact: readyPayload.recipeQualityArtifact,
  qualityReport: readyPayload.qualityReport,
  workerLearnings: readyPayload.workerLearnings,
  isStale: false,
  selectionReason: 'decision-derived',
};

async function startFixtureGateway() {
  const httpServer = createServer((req, res) => {
    const requestUrl = new URL(req.url || '/', `http://localhost:${fixturePort}`);
    if (requestUrl.pathname === '/api/run-artifact') {
      return serveArtifact(requestUrl, res);
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  const wss = new WebSocketServer({ noServer: true });
  httpServer.on('upgrade', (req, socket, head) => {
    const requestUrl = new URL(req.url || '/', `http://localhost:${fixturePort}`);
    if (requestUrl.pathname !== '/ws' && requestUrl.pathname !== '/') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.type !== 'req') return;
      const payload = rpcPayload(frame.method, frame.params || {});
      ws.send(JSON.stringify({ type: 'res', id: frame.id, ok: true, payload }));
    });
    setTimeout(() => emit(ws, 'fleet.updated', { fleet }), 250);
    setTimeout(() => emit(ws, 'run.updated', { run }), 350);
    setTimeout(
      () => emit(ws, 'run.decision.new', { decision, slotId: slot.slot, runId: run.id }),
      450,
    );
  });
  await new Promise((resolvePromise, rejectPromise) => {
    httpServer.once('error', rejectPromise);
    httpServer.listen(fixturePort, '127.0.0.1', resolvePromise);
  });
  return {
    close: () =>
      new Promise((resolvePromise) => {
        wss.close(() => httpServer.close(() => resolvePromise()));
      }),
  };
}

function emit(ws, event, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'event', event, payload }));
}

function rpcPayload(method, params) {
  switch (method) {
    case 'auth.connect':
      return {
        ok: true,
        clientKind: 'ui',
        authMode: 'none',
        authenticatedAt: Date.now(),
        capabilities: { httpBearerAuth: false, voiceInstructionFormatting: true },
      };
    case 'fleet.status':
      return { fleet };
    case 'decision.list':
      return {
        decisions: [
          {
            id: decision.id,
            type: decision.type,
            slotId: slot.slot,
            title: decision.title,
            description: decision.description,
            context: decision.context,
            actions: decision.actions,
            createdAt: decision.createdAt,
            payload: decision.payload,
            runMeta: {
              runId: run.id,
              familyId: run.familyId,
              flowType: run.flowType,
              ticketOrPr: run.ticketOrPr,
              branch: run.branch,
              runner: run.metrics.runner,
              model: run.metrics.model,
              summary: run.summary,
            },
          },
        ],
      };
    case 'run.list':
      return {
        runs: [run],
        totalCount: 1,
        familySummaries: [],
        projectAnalytics: [],
        summaryMeta: { totalCount: 1, filteredCount: 1 },
      };
    case 'run.get':
      return { run: params.runId === run.id ? run : null };
    case 'run.forSlot':
      return { run: params.slotId === slot.slot ? run : null };
    case 'run.slotHistory':
      return {
        slotId: params.slotId,
        slotExists: params.slotId === slot.slot,
        runs: [],
        totalCount: 0,
      };
    case 'run.recipeRunsForRun':
    case 'run.recipeRunsForSlot':
      return { recipeRuns: [recipeRun], selectedRecipeRunId: recipeRun.id };
    case 'git.status':
      return {
        slotId: params.slotId,
        branch: 'docs/real-demo-media',
        ahead: 1,
        behind: 0,
        changes: [
          { path: 'apps/docs/src/pages/index.js', status: 'M' },
          { path: 'apps/docs/docs/products/command-center.md', status: 'M' },
          {
            path: 'docs/examples/recipes/farmslot/docusaurus-human-ready-gate.recipe.json',
            status: 'A',
          },
        ],
      };
    case 'git.branchDiff':
      return {
        files: [
          { path: 'apps/docs/src/pages/index.js', status: 'M', additions: 38, deletions: 6 },
          {
            path: 'apps/docs/docs/products/command-center.md',
            status: 'M',
            additions: 18,
            deletions: 4,
          },
          {
            path: 'docs/examples/recipes/farmslot/docusaurus-human-ready-gate.recipe.json',
            status: 'A',
            additions: 18,
            deletions: 0,
          },
        ],
        base: 'main',
        head: 'docs/real-demo-media',
        totalAdditions: 74,
        totalDeletions: 12,
      };
    case 'git.diff':
      return { diff: diffText };
    case 'fs.list':
      return {
        entries: [
          { name: 'apps', path: 'apps', type: 'directory' },
          { name: 'docs', path: 'docs', type: 'directory' },
          { name: 'packages', path: 'packages', type: 'directory' },
          { name: 'TASK.md', path: 'TASK.md', type: 'file', size: 2048 },
        ],
      };
    case 'fs.read':
      return { path: params.path, content: artifactText(params.path), mimeType: 'text/plain' };
    case 'git.files':
      return {
        files: [
          'apps/docs/src/pages/index.js',
          'apps/docs/docs/products/command-center.md',
          'TASK.md',
        ],
      };
    case 'config.pool':
      return { pool: { machine: 'demo-farm', slots: [{ id: slot.slot, repo: '/demo/farmslot' }] } };
    case 'resource.list':
      return {
        resources: [
          {
            id: 'command-center',
            definition: {
              type: 'browser',
              label: 'Command Center',
              streamable: true,
              controllable: true,
            },
            status: 'running',
            stream: { state: 'ready', detail: 'Fixture stream ready', updatedAt: demoNow() },
          },
        ],
      };
    case 'slot.action.list':
      return { actions: [] };
    case 'terminal.snapshot':
      return {
        slotId: params.slotId,
        timestamp: Date.now(),
        lines: [
          '- [x] Render ready workspace with package preview',
          '- [x] Verify evidence and decision actions are visible',
          '- [x] Capture screenshot only after public-safety assertions pass',
          '',
          '$ yarn docs:build',
          '✓ Docusaurus static build succeeded',
          '$ yarn --cwd apps/command-center typecheck',
          '✓ TypeScript checks passed',
        ],
      };
    case 'task.progress':
      return {
        structured: {
          title: 'Command Center human-ready gate demo',
          completedSteps: 3,
          totalSteps: 3,
          currentPhase: 'Human review',
          steps: [
            { label: 'Capture recipe', status: 'done' },
            { label: 'Evidence artifacts', status: 'done' },
            { label: 'Human gate', status: 'running' },
          ],
        },
      };
    case 'dispatch.queue.list':
      return { items: [] };
    case 'backlog.list':
      return { items: [] };
    case 'config.projects':
      return { projects: [{ name: 'farmslot-farm', defaultBranch: 'main', status: 'active' }] };
    case 'pr.list':
      return { prs: [] };
    case 'pr.forSlot':
      return { pr: null };
    case 'pr.reviewComments':
      return { threads: [], currentUser: 'demo-operator' };
    case 'run.refreshMirror':
    case 'run.refreshPublishPackage':
    case 'run.resolveDecision':
      return {
        ok: true,
        run,
        decision: { ...decision, resolvedAt: demoNow(), resolvedAction: 'approved' },
      };
    default:
      return { ok: true };
  }
}

function serveArtifact(requestUrl, res) {
  const path = requestUrl.searchParams.get('path') || '';
  if (path.endsWith('.png')) {
    const png = demoPng(path);
    res.writeHead(200, {
      'content-type': 'image/png',
      'content-length': png.length,
      'access-control-allow-origin': '*',
    });
    res.end(png);
    return;
  }
  res.writeHead(200, { 'content-type': contentType(path), 'access-control-allow-origin': '*' });
  res.end(artifactText(path));
}

function artifactText(path) {
  if (path.endsWith('.patch')) return diffText;
  if (path.endsWith('recipe.json')) return readyPayload.recipeJson;
  if (path.endsWith('trace.json'))
    return JSON.stringify({ recipeId: 'docusaurus-human-ready-gate', steps: trace }, null, 2);
  if (path.endsWith('.md')) return readyPayload.prPackage.draftBody;
  return 'Public-safe demo artifact generated from the Farmslot ready-gate fixture.';
}

function contentType(path) {
  if (path.endsWith('.json')) return 'application/json';
  if (path.endsWith('.patch')) return 'text/x-diff';
  if (path.endsWith('.md')) return 'text/markdown';
  return 'text/plain';
}

function demoPng(path) {
  const mapped = path.includes('audiolab')
    ? resolve(
        repoRoot,
        '.agent/demo-stage/docusaurus-audiolab-sample-banner/output/screenshots/audiolab-sample-banner-ios-final.png',
      )
    : path.includes('echobridge')
      ? resolve(
          repoRoot,
          '.agent/demo-stage/docusaurus-echobridge-live-recording/output/screenshots/echobridge-live-recording-ios-final.png',
        )
      : resolve(repoRoot, 'apps/docs/static/img/demos/command-center-gateway-intelligence.png');
  if (existsSync(mapped)) return readFileSync(mapped);
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  );
}

async function ensureUiDevServer() {
  if (await httpOk(uiUrl)) return;
  const log = resolve(artifactsDir, 'logs/command-center-ui-dev.log');
  const child = spawn('yarn', ['dev', '--host', '127.0.0.1', '--port', String(uiPort)], {
    cwd: uiDir,
    env: {
      ...process.env,
      VITE_FARMSLOT_GATEWAY_URL: `ws://localhost:${fixturePort}/ws`,
      VITE_FARMSLOT_GATEWAY_AUTH_MODE: 'none',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  child.stdout.on('data', (buf) => appendLog(log, buf));
  child.stderr.on('data', (buf) => appendLog(log, buf));
  await waitFor(() => httpOk(uiUrl), 45_000, 'Command Center UI dev server');
}

async function ensureChrome() {
  if (!(await cdpHttpOk())) {
    spawnSync('bash', ['scripts/debug-chrome.sh'], {
      cwd: commandCenterDir,
      env: {
        ...process.env,
        FARMSLOT_CDP_PORT: String(cdpPort),
        FARMSLOT_CDP_PROFILE:
          process.env.FARMSLOT_DEMO_CDP_PROFILE ||
          resolve(repoRoot, '.agent/demo-stage/docusaurus-human-ready-gate/chrome-profile'),
        FARMSLOT_UI_URL: targetUrl,
      },
      stdio: 'inherit',
    });
  }
  await waitFor(() => cdpHttpOk(), 10_000, 'Chrome CDP');
  await reuseOrOpenCdpPage(targetUrl);
}

async function prepareView() {
  await evalInPage(`
    localStorage.setItem('farmslot:slot-view-prefs:v2', JSON.stringify({
      sidebarWidth: 250,
      terminalHeight: 160,
      terminalOpen: false,
      sidebarOpen: true,
      sections: { source: true, info: true, actions: true, run: true, task: true },
      activity: 'source',
      streamWidth: 260,
      reviewPanelWidth: 760
    }));
    document.title = 'Farmslot Human Ready Gate Capture';
    history.replaceState(null, '', ${JSON.stringify(targetHash)});
    location.reload();
    return true;
  `);
  await waitFor(
    async () => {
      const text = await visibleText();
      return text.includes('Approve Publish') && text.includes('Pre-publication cockpit');
    },
    30_000,
    'ready gate visible text',
  );
}

async function verifyReadyGate() {
  const text = await visibleText();
  writeFileSync(resolve(artifactsDir, 'logs/visible-text.txt'), text);
  for (const pattern of forbidden) {
    if (pattern.test(text)) throw new Error(`Forbidden public-demo text visible: ${pattern}`);
  }
  const required = [
    'Pre-publication cockpit',
    'Approve Publish',
    'Extra Review',
    'PR Preview',
    'Evidence',
    'Quality',
    'Recipe',
    'Command Center human-ready gate demo',
    'docs/real-demo-media',
  ];
  for (const label of required) {
    if (!text.includes(label)) throw new Error(`Expected ready-gate label missing: ${label}`);
  }
  return { length: text.length, textSample: text.slice(0, 4000) };
}

async function visibleText() {
  return evalInPage(`
    function collectVisibleText(root) {
      const parts = [];
      const visit = (node) => {
        if (!node) return;
        if (node.nodeType === Node.TEXT_NODE) {
          const value = node.textContent?.trim();
          if (value) parts.push(value);
          return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE && node !== document && !(node instanceof ShadowRoot)) return;
        const element = node instanceof Element ? node : null;
        if (element) {
          const style = getComputedStyle(element);
          if (style.display === 'none' || style.visibility === 'hidden') return;
        }
        if (element?.shadowRoot) visit(element.shadowRoot);
        for (const child of node.childNodes || []) visit(child);
      };
      visit(root);
      return parts.join(' ');
    }
    return collectVisibleText(document.body);
  `);
}

async function captureScreenshot(path) {
  const result = await withCdpPage(async (call) => {
    await call('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 960,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await call('Page.bringToFront');
    const shot = await call('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    });
    return shot.data;
  });
  writeFileSync(path, Buffer.from(result, 'base64'));
  assertNonEmpty(path, 'ready-gate screenshot');
}

function writeOutputs({ recipe, screenshotPath, verification }) {
  const manifest = [
    {
      path: rel(screenshotPath),
      type: 'screenshot',
      mimeType: 'image/png',
      purpose: 'proof',
      nodeId: 'verify-public-safe-gate',
      label: 'Command Center human ready gate screenshot',
    },
    {
      path: 'recipe.json',
      type: 'recipe',
      mimeType: 'application/json',
      purpose: 'debug',
      label: 'Resolved capture recipe',
    },
  ];
  writeFileSync(
    resolve(artifactsDir, 'trace.json'),
    JSON.stringify({ version: 1, recipeId: recipe.id, steps: trace }, null, 2),
  );
  writeFileSync(
    resolve(artifactsDir, 'artifact-manifest.json'),
    JSON.stringify({ version: 1, runStatus: 'pass', artifacts: manifest }, null, 2),
  );
  writeFileSync(
    resolve(artifactsDir, 'summary.json'),
    JSON.stringify(
      {
        status: 'pass',
        recipeId: recipe.id,
        title: recipe.title,
        regeneratedBy: `yarn --cwd apps/docs capture:human-ready-gate --artifacts-dir ${relative(repoRoot, artifactsDir)} --copy-to-docs`,
        copiedToDocs: copyToDocs ? { screenshot: relative(repoRoot, docsScreenshot) } : null,
        publicSafety: {
          forbiddenPatternsChecked: forbidden.map(String),
          visibleChars: verification.length,
        },
      },
      null,
      2,
    ),
  );
}

async function reuseOrOpenCdpPage(url) {
  const tabs = await listCdpTabs();
  const existing = tabs.find((tab) => tab.type === 'page' && tab.url?.startsWith(uiUrl));
  if (existing) {
    await withCdpTarget(existing.webSocketDebuggerUrl, async (call) => {
      await call('Page.navigate', { url });
    });
    await sleep(1000);
    return;
  }
  const response = await fetch(`http://localhost:${cdpPort}/json/new?${encodeURIComponent(url)}`, {
    method: 'PUT',
  });
  if (!response.ok) throw new Error(`Failed to open CDP tab: ${response.status}`);
}

async function evalInPage(expression) {
  return withCdpPage(async (call) => {
    const result = await call('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(JSON.stringify(result.exceptionDetails));
    }
    return result.result?.value;
  });
}

async function withCdpPage(fn) {
  const tabs = await listCdpTabs();
  const page =
    tabs.find((tab) => tab.type === 'page' && tab.url?.startsWith(uiUrl)) ||
    tabs.find((tab) => tab.type === 'page');
  if (!page?.webSocketDebuggerUrl) throw new Error('No Chrome page available for CDP capture');
  return withCdpTarget(page.webSocketDebuggerUrl, fn);
}

async function withCdpTarget(webSocketDebuggerUrl, fn) {
  const ws = new WebSocket(webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const opened = new Promise((resolvePromise, rejectPromise) => {
    ws.addEventListener('open', resolvePromise, { once: true });
    ws.addEventListener('error', () => rejectPromise(new Error('CDP websocket failed')), {
      once: true,
    });
  });
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id || !pending.has(message.id)) return;
    const { resolvePromise, rejectPromise } = pending.get(message.id);
    pending.delete(message.id);
    message.error
      ? rejectPromise(new Error(message.error.message || 'CDP command failed'))
      : resolvePromise(message.result);
  });
  await opened;
  const call = (method, params = {}) =>
    new Promise((resolvePromise, rejectPromise) => {
      const commandId = ++id;
      pending.set(commandId, { resolvePromise, rejectPromise });
      ws.send(JSON.stringify({ id: commandId, method, params }));
    });
  try {
    return await fn(call);
  } finally {
    ws.close();
  }
}

async function listCdpTabs() {
  const response = await fetch(`http://localhost:${cdpPort}/json`);
  if (!response.ok) throw new Error(`CDP tab list failed: ${response.status}`);
  return response.json();
}

async function cdpHttpOk() {
  const response = await fetch(`http://localhost:${cdpPort}/json/version`).catch((err) => {
    if (err?.code === 'ECONNREFUSED' || err?.cause?.code === 'ECONNREFUSED') return null;
    throw err;
  });
  return Boolean(response?.ok);
}

async function httpOk(url) {
  const response = await fetch(url, { method: 'HEAD' }).catch((err) => {
    if (err?.code === 'ECONNREFUSED' || err?.cause?.code === 'ECONNREFUSED') return null;
    throw err;
  });
  return Boolean(response?.ok);
}

async function waitFor(predicate, timeoutMs, label) {
  const start = Date.now();
  let lastError;
  while (Date.now() - start < timeoutMs) {
    try {
      if (await predicate()) return;
    } catch (err) {
      lastError = err;
    }
    await sleep(500);
  }
  const suffix = lastError instanceof Error ? `: ${lastError.message}` : '';
  throw new Error(`Timed out waiting for ${label}${suffix}`);
}

function step(nodeId, status, message, extra = {}) {
  trace.push({ nodeId, status, message, at: new Date().toISOString(), ...extra });
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function assertNonEmpty(path, label) {
  if (!existsSync(path) || statSync(path).size === 0)
    throw new Error(`${label} missing or empty: ${path}`);
}

function appendLog(path, buf) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buf, { flag: 'a' });
}

function rel(path) {
  return relative(artifactsDir, path).replaceAll('\\\\', '/');
}

function cleanup() {
  if (fixture) {
    fixture.close().catch((err) => {
      console.error(`fixture close failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    fixture = null;
  }
  for (const child of children) child.kill('SIGTERM');
}
