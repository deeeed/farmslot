import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mock, test } from 'node:test';

await import('../runtime/mock-pty.test-support.js');
const github = await import('../integrations/github-client.js');
const calls: string[][] = [];
const bodies: string[] = [];
mock.module('../integrations/github-client.js', {
  namedExports: {
    ...github,
    ghRequest: async (args: string[]) => {
      calls.push(args);
      if (args.includes('--body-file')) {
        bodies.push(await readFile(args[args.indexOf('--body-file') + 1], 'utf8'));
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  },
});
const llm = await import('../llm/index.js');
let llmCalls = 0;
const phrase = Array<string>(12).fill('abandon').join(' ');
let generatedText = phrase;
mock.module('../llm/index.js', {
  namedExports: {
    ...llm,
    callLLM: async () => {
      llmCalls += 1;
      return { text: generatedText, usage: {} };
    },
  },
});
const templates = await import('../core/prompt-templates.js');
mock.module('../core/prompt-templates.js', {
  namedExports: {
    ...templates,
    loadPromptTemplate: async (...args: Parameters<typeof templates.loadPromptTemplate>) =>
      args[0] === 'metadata-secret'
        ? `Grade: ${args[2]?.GRADE_RATIONALE ?? ''}`
        : args[0] === 'clean-comment-template'
          ? 'Render the clean worker report.'
          : null,
  },
});
const { postPRComment } = await import('./pr-publication.js');
const { postProcessPRBody } = await import('./publication-artifacts.js');
const { publishCompletionPackage } = await import('./orchestrator.js');
const { PublicationSecretError } = await import('./publication-secrets.js');
const { makeRun } = await import('./test-fixtures.js');
const { makeReadyGatePackage, deleteTestRunIfPresent } =
  await import('../run-engine/test-fixtures.js');
const { createRun } = await import('../runs/store.js');

test('incoming prose and manifest values refuse before rewrite or GitHub edits', async () => {
  const before = calls.length;
  for (const options of [
    { baseBody: phrase, evidenceManifest: null },
    { baseBody: 'Clean description.', evidenceManifest: { summary: phrase } },
  ]) {
    await assert.rejects(
      postProcessPRBody(makeRun(), 'fixture/project', 1, new Map(), undefined, options),
      PublicationSecretError,
    );
  }
  assert.equal(llmCalls, 0);
  assert.equal(calls.length, before);
});

test('a secret in rewritten output cannot be swallowed by optional fallbacks', async () => {
  const before = calls.length;
  await assert.rejects(
    postProcessPRBody(
      makeRun(),
      'fixture/project',
      1,
      new Map([['diagnostic.txt', 'https://example.invalid/diagnostic.txt']]),
      undefined,
      { baseBody: 'Clean description.', evidenceManifest: null },
    ),
    PublicationSecretError,
  );
  assert.equal(llmCalls, 1);
  assert.equal(calls.length, before);
});

test('approved secret prose refuses before PR creation and artifact upload', async (t) => {
  const run = createRun({ flowType: 'dev', project: 'fixture', ticketOrPr: 'TEST-1' });
  t.after(() => deleteTestRunIfPresent(run.id));
  const before = calls.length;
  await assert.rejects(
    publishCompletionPackage(run.id, makeReadyGatePackage({ draftBody: phrase })),
    PublicationSecretError,
  );
  assert.equal(calls.length, before);
});

test('clean rendered prose reaches the existing body edit', async () => {
  const before = calls.length;
  const body = `Verified sha256:${'b'.repeat(64)}.`;
  assert.equal(
    await postProcessPRBody(makeRun(), 'fixture/project', 1, new Map(), [], {
      failOnError: true,
      baseBody: body,
      evidenceManifest: null,
    }),
    body,
  );
  assert.equal(calls.length, before + 1);
  assert.equal(bodies.at(-1), body);
});

test('a default optional comment cannot swallow a secret refusal', async () => {
  const before = calls.length;
  await assert.rejects(
    postPRComment(makeRun(), phrase, 'fixture/project', 1),
    PublicationSecretError,
  );
  assert.equal(calls.length, before);
});

test('expanded comment metadata is scanned before model submission', async () => {
  const before = calls.length;
  const beforeModel = llmCalls;
  const run = makeRun({
    project: 'metadata-secret',
    grade: { difficulty: 'low', rationale: phrase, modelRecommendation: 'fixture' },
  });
  await assert.rejects(
    postPRComment(run, 'Clean report.', 'fixture/project', 1),
    PublicationSecretError,
  );
  assert.equal(llmCalls, beforeModel);
  assert.equal(calls.length, before);
});

test('secret model output cannot become a clean comment through length fallback', async () => {
  const before = calls.length;
  generatedText = `${phrase}\n`.repeat(300);
  try {
    await assert.rejects(
      postPRComment(
        makeRun({ project: 'clean-comment-template' }),
        'Clean report.',
        'fixture/project',
        1,
      ),
      PublicationSecretError,
    );
  } finally {
    generatedText = phrase;
  }
  assert.equal(calls.length, before);
});
