const assert = require('node:assert/strict');
const {
  resolveWorkerTerminalContract,
  lintWorkerTemplateAgainstContract,
  lintWorkerTemplateProofSelection,
  lintWorkerTemplateStructure,
  expandedArtifactsForCommand,
  templateTerminalCommands,
  templateUsesTerminalMark,
} = require('./worker-terminal-contract.cjs');

const devContract = resolveWorkerTerminalContract(null, 'dev');
assert.equal(devContract.requireSignal, true);
assert.deepEqual(devContract.commands.complete.artifacts, [
  'artifacts/learnings.md',
  'artifacts/pr-description.md',
]);
assert.equal(devContract.commands.complete.report, 'artifacts/pr-description.md');

const qaContract = resolveWorkerTerminalContract(null, 'qa');
assert.equal(qaContract.commands.complete.report, 'artifacts/report.html');
assert.deepEqual(qaContract.commands.complete.artifacts, [
  'artifacts/learnings.md',
  'artifacts/report.html',
]);

const interactivePrComplete = resolveWorkerTerminalContract(null, 'pr-complete', {
  mode: 'interactive',
});
assert.equal(interactivePrComplete.requireSignal, false);

const projectContract = resolveWorkerTerminalContract(
  {
    flows: {
      dev: {
        complete: { report: 'artifacts/report.md', artifacts: ['artifacts/custom.md'] },
      },
    },
  },
  'dev',
);
assert.deepEqual(projectContract.commands.complete.artifacts, [
  'artifacts/report.md',
  'artifacts/custom.md',
]);

const templateOk = [
  '# Worker: Dev',
  '- [ ] Write `artifacts/learnings.md`',
  '- [ ] Write `artifacts/pr-description.md`',
  '- [ ] Run `./mark complete --mark-last`',
].join('\n');
assert.deepEqual(lintWorkerTemplateAgainstContract(templateOk, devContract), []);

const reviewPathBindingContract = resolveWorkerTerminalContract(null, 'review');
assert.deepEqual(
  lintWorkerTemplateAgainstContract(
    '- [ ] Write `{{TASK_DIR}}/{{REVIEW_FEEDBACK}}`\n- [ ] Run `{{TASK_DIR}}/mark complete`',
    reviewPathBindingContract,
  ),
  [],
);
assert.ok(
  lintWorkerTemplateAgainstContract(
    '- [ ] Run `{{TASK_DIR}}/mark complete`',
    reviewPathBindingContract,
  ).some((issue) => issue.includes('artifacts/review-feedback.md')),
);

const checklistOverrideTemplate = [
  '# Worker: CI Fix Pass',
  '- [ ] Write `artifacts/learnings.md`',
  '- [ ] Write `artifacts/report.md`',
  '- [ ] Write `artifacts/no-change-report.md` when no change is needed',
  '- [ ] Run `{{TASK_DIR}}/mark --checklist CI-FIX.md complete --mark-last`',
  '- [ ] Or run `{{TASK_DIR}}/mark --checklist CI-FIX.md no-change --reason "already fixed"`',
].join('\n');
assert.equal(templateUsesTerminalMark(checklistOverrideTemplate), true);
assert.deepEqual(templateTerminalCommands(checklistOverrideTemplate), ['complete', 'no-change']);
assert.deepEqual(
  lintWorkerTemplateAgainstContract(
    checklistOverrideTemplate,
    resolveWorkerTerminalContract(null, 'ci-fix'),
  ),
  [],
);

const templateBad = ['# Worker', '- [ ] Done'].join('\n');
assert.match(
  lintWorkerTemplateAgainstContract(templateBad, devContract)[0],
  /requireSignal is true but template has no terminal/,
);

const expanded = expandedArtifactsForCommand(
  devContract,
  'complete',
  (rel) => rel === 'artifacts/recipe.json',
);
assert.equal(expanded.requireRecipeQuality, true);
assert.ok(expanded.artifacts.includes('artifacts/recipe-coverage.md'));

const structureBad = [
  '# Worker',
  '## Task',
  'TASK_DIR: {{TASK_DIR}}',
  '## Checklist',
  '- [ ] **1. One**',
  '- [ ] **1. Duplicate**',
  '- [ ] Write `{TASK_DIR}/artifacts/learnings.md`',
  '- [ ] `{{TASK_DIR}}/mark complete --mark-last`',
].join('\n');
assert.match(
  lintWorkerTemplateStructure(structureBad).join(' '),
  /duplicate checklist step number/,
);
assert.match(lintWorkerTemplateStructure(structureBad).join(' '), /double braces/);
// The task writer generates the ticket block into TASK.md; a flow template that
// still carries it would duplicate the header inside CHECKLIST.md. Role
// checklists (review, ci-fix) render beside an existing task dir and may
// keep theirs.
assert.match(lintWorkerTemplateStructure(structureBad).join(' '), /carries a `## Task` block/);
assert.doesNotMatch(
  lintWorkerTemplateStructure(structureBad, { roleChecklist: true }).join(' '),
  /carries a `## Task` block/,
);
const structureGood = [
  '# Fix-bug checklist',
  '## Checklist',
  '- [ ] **1. One**',
  '- [ ] `{{TASK_DIR}}/mark complete --mark-last`',
].join('\n');
assert.deepEqual(lintWorkerTemplateStructure(structureGood), []);

// A template that runs recipe proof names the selected attempt (audiolab #529: proof attempts
// that nothing selected). The root evidence-manifest.json stays optional.
const proofStep = '- [ ] Run the app recipe and validate its artifact package.';
assert.match(
  lintWorkerTemplateProofSelection(proofStep, 'dev').join(' '),
  /does not name the selected proof attempt/,
);
assert.match(
  lintWorkerTemplateProofSelection('- [ ] Run the same proof after the fix.', 'fix-bug').join(' '),
  /selected proof attempt/,
);
assert.deepEqual(
  lintWorkerTemplateProofSelection(
    `${proofStep} Claim the attempt selected in \`artifacts/latest-valid-recipe-run.json\`.`,
    'dev',
  ),
  [],
);
for (const flow of ['review', 'review-pr', 'qa', 'qa.site-build'])
  assert.deepEqual(lintWorkerTemplateProofSelection(proofStep, flow), [], flow);
assert.deepEqual(lintWorkerTemplateProofSelection('- [ ] Write the report.', 'dev'), []);
// Lines that forbid or only diagnose proof run none; delegated task-bound proof still counts.
for (const line of [
  'Do not run tests, builds, recipes or probes.',
  'Never rerun proof here.',
  'Run the recipe with --unbound for diagnostics.',
])
  assert.deepEqual(lintWorkerTemplateProofSelection(line, 'ci-fix'), [], line);
assert.match(
  lintWorkerTemplateProofSelection(
    'Follow TASK.md for task-bound recipe proof.',
    'pr-complete',
  ).join(' '),
  /selected proof attempt/,
);
assert.deepEqual(lintWorkerTemplateProofSelection(proofStep, 'qa-site-build'), []);
// A negation in another clause of the same line does not hide the run instruction.
assert.match(
  lintWorkerTemplateProofSelection(
    '- [ ] Run the task recipe with a fresh attempt. An unavailable surface is blocked, never a manual-check substitute.',
    'dev',
  ).join(' '),
  /selected proof attempt/,
);
assert.match(
  lintWorkerTemplateProofSelection(`${proofStep} See latest-valid-recipe-run.json.`, 'dev').join(
    ' ',
  ),
  /selected proof attempt/,
  'the full selection path is required',
);
// A designed non-selection layout opts out by name, and only with a reason.
assert.deepEqual(
  lintWorkerTemplateProofSelection(
    `<!-- proof-selection: exempt (baseline/after-fix [PROOF:] layout) -->\n${proofStep}`,
    'dev',
  ),
  [],
);
assert.match(
  lintWorkerTemplateProofSelection(`<!-- proof-selection: exempt () -->\n${proofStep}`, 'dev').join(
    ' ',
  ),
  /selected proof attempt/,
);

// The checker applies the rule to execution-template checklists named by project.json.
{
  const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
  const { tmpdir } = require('node:os');
  const path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const project = mkdtempSync(path.join(tmpdir(), 'proof-selection-pack-'));
  try {
    writeFileSync(
      path.join(project, 'project.json'),
      JSON.stringify({
        execution_templates: {
          sources: [
            { id: 'project:x', kind: 'workspace', root: { projectPath: 'checklists' } },
            {
              id: 'pack:y',
              kind: 'package',
              root: { projectPath: 'templates' },
              subpath: 'catalog',
            },
          ],
        },
      }),
    );
    mkdirSync(path.join(project, 'checklists', 'dev'), { recursive: true });
    mkdirSync(path.join(project, 'checklists', 'qa'), { recursive: true });
    writeFileSync(path.join(project, 'checklists', 'dev', 'default.md'), `# Dev\n\n${proofStep}\n`);
    writeFileSync(path.join(project, 'checklists', 'qa', 'default.md'), `# QA\n\n${proofStep}\n`);
    mkdirSync(path.join(project, 'templates', 'catalog', 'fix-bug'), { recursive: true });
    writeFileSync(
      path.join(project, 'templates', 'catalog', 'fix-bug', 'default.md'),
      `# Fix\n\n${proofStep}\n`,
    );
    const check = () =>
      spawnSync(
        process.execPath,
        [path.join(__dirname, 'check-worker-template-contract.mjs'), project],
        {
          encoding: 'utf8',
        },
      );
    let result = check();
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /checklists\/dev\/default\.md: runs recipe proof/);
    assert.doesNotMatch(result.stderr, /checklists\/qa/);
    assert.match(result.stderr, /templates\/catalog\/fix-bug\/default\.md: runs recipe proof/);
    rmSync(path.join(project, 'templates'), { recursive: true });
    // Frontmatter decides the flow; body text that looks like frontmatter does not.
    writeFileSync(
      path.join(project, 'checklists', 'qa', 'default.md'),
      `---\r\nflow: "dev"\r\n---\r\n# QA dir, dev flow\n\n${proofStep}\n`,
    );
    mkdirSync(path.join(project, 'checklists', 'dev2'), { recursive: true });
    writeFileSync(
      path.join(project, 'checklists', 'dev2', 'body.md'),
      `# Dev\n\nflow: qa\n\n${proofStep}\n`,
    );
    result = check();
    assert.match(result.stderr, /checklists\/qa\/default\.md: runs recipe proof/);
    assert.match(result.stderr, /checklists\/dev2\/body\.md: runs recipe proof/);
    rmSync(path.join(project, 'checklists', 'dev2'), { recursive: true });
    writeFileSync(path.join(project, 'checklists', 'qa', 'default.md'), `# QA\n\n${proofStep}\n`);
    writeFileSync(
      path.join(project, 'checklists', 'dev', 'default.md'),
      `# Dev\n\n${proofStep} Claim the attempt in \`artifacts/latest-valid-recipe-run.json\`.\n`,
    );
    result = check();
    assert.equal(result.status, 0, result.stderr);
    const config = JSON.parse(readFileSync(path.join(project, 'project.json'), 'utf8'));
    config.execution_templates.sources.push({
      id: 'escape',
      kind: 'workspace',
      root: { projectPath: '..' },
    });
    writeFileSync(path.join(project, 'project.json'), JSON.stringify(config));
    result = check();
    assert.match(result.stderr, /execution template source escape resolves outside the pack/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

// Reviewer flows require the artifacts their templates actually produce, not learnings.
const reviewContract = resolveWorkerTerminalContract(null, 'review');
assert.deepEqual(reviewContract.commands.complete.artifacts, ['artifacts/review-feedback.md']);
const reviewFixContract = resolveWorkerTerminalContract(null, 'review-fix');
assert.deepEqual(reviewFixContract.commands.complete.artifacts, ['artifacts/report.md']);
assert.deepEqual(reviewFixContract.commands['no-change'].artifacts, [
  'artifacts/no-change-report.md',
]);

// A template that omits `./mark` entirely must fail lint when the contract
// requires a terminal signal, and pass when it does not (pr-complete interactive).
const marklessTemplate = ['# Worker: Dev — DEV-123', '- [ ] Do the work'].join('\n');
assert.deepEqual(lintWorkerTemplateAgainstContract(marklessTemplate, devContract), [
  'requireSignal is true but template has no terminal `./mark` or mark-checklist-step command',
]);
const interactivePrCompleteContract = resolveWorkerTerminalContract(null, 'pr-complete', {
  mode: 'interactive',
});
assert.equal(interactivePrCompleteContract.requireSignal, false);
assert.deepEqual(
  lintWorkerTemplateAgainstContract(marklessTemplate, interactivePrCompleteContract),
  [],
);

console.log('worker-terminal-contract: ok');
