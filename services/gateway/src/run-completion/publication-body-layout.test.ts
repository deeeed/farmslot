import assert from 'node:assert/strict';
import test from 'node:test';

import type { EvidenceManifest, RunDecision } from '@farmslot/protocol';

await import('../runtime/mock-pty.test-support.js');
const { makeReadyGatePackage } = await import('../run-engine/test-fixtures.js');
const { withPublicationProvenance } = await import('./evidence-attestation.js');
const { buildEvidenceSection } = await import('./evidence-manifest.js');
const { replaceMarkdownSection } = await import('./publication-artifacts.js');
const { makeRun } = await import('./test-fixtures.js');

function publicationFixture() {
  const standalone = Array.from({ length: 140 }, (_, index) => ({
    label: `Criterion ${(index % 3) + 1}, capture ${index + 1}`,
    covers: [`AC-${(index % 3) + 1}`],
    file: `stills/capture-${index + 1}.webp`,
    note: 'The recorded application state.',
  }));
  const manifest: EvidenceManifest = {
    summary: 'AC-1: awaiting-review; AC-2: awaiting-review; AC-3: awaiting-review',
    standalone,
    videos: { after: 'recording.mp4' },
  };
  const urls = new Map([
    ...standalone.map((shot) => [shot.file, `https://example.invalid/${shot.file}`] as const),
    ['recording.mp4', 'https://example.invalid/recording.mp4'],
  ]);
  const prepared = makeReadyGatePackage({ packageHash: 'frozen-publication-hash' });
  const decision: RunDecision = {
    id: 'publication',
    type: 'engine_human_gate',
    title: 'Publish',
    description: '',
    actions: [],
    createdAt: '2026-10-20T00:00:00Z',
    resolvedAt: '2026-10-20T00:01:00Z',
    resolvedAction: 'approve-publish',
    payload: {
      kind: 'ready',
      branch: prepared.branch,
      prNumber: null,
      repo: null,
      workerReport: '',
      diffStat: prepared.diffStat,
      prPackage: prepared,
    },
    publicationApproval: {
      principalId: 'reviewer',
      displayName: 'Reviewer',
      subjectKind: 'person',
      packageHash: prepared.packageHash,
      visualJudgmentReceiptIds: [],
      claimOverrideReceiptIds: [],
      approvedAt: '2026-10-20T00:01:00Z',
    },
  };
  const run = makeRun({ decisions: [decision] });
  const evidence = buildEvidenceSection(manifest, urls);
  assert.ok(evidence);
  const body = withPublicationProvenance(
    run,
    [
      '## Summary\n\nFix the application.',
      '## Validation\n\nThe login recipe passed.',
      '## **Screenshots/Recordings**\n\n' + evidence,
      '## Visual judgments\n\n| Criterion | Verdict | Reviewed by |\n| --- | --- | --- |\n| AC-1 | proven | Reviewer |',
    ].join('\n\n'),
  );
  return { body, run, evidence, manifest, urls };
}

test('140 stills keep one representative per AC visible and the gallery with its receipt collapsed', () => {
  const { body, urls } = publicationFixture();
  const details = body.match(/<details>[\s\S]*?<\/details>/g) ?? [];
  assert.equal(details.length, 1);
  assert.doesNotMatch(details[0], /<details\s+open/);
  const visible = body.replace(details[0], '');
  assert.equal((visible.match(/<img\b/g) ?? []).length, 3);
  assert.equal((details[0].match(/<img\b/g) ?? []).length, 140);
  for (const heading of ['## Summary', '## Validation', '## Visual judgments']) {
    assert.ok(visible.includes(heading));
  }
  assert.match(visible, /\| AC-1 \| proven \| Reviewer \|/);
  assert.doesNotMatch(body, /awaiting-review/);
  assert.doesNotMatch(visible, /frozen-publication-hash|Publication approval/);
  assert.match(details[0], /Publication approval[\s\S]*frozen-publication-hash/);
  for (const url of urls.values()) assert.ok(body.includes(url), url);
  assert.doesNotMatch(body, /<img[^>]*recording\.mp4|!\[[^\]]*\]\([^)]*recording\.mp4/);
  assert.match(body, /\[recording\.mp4\]\(https:\/\/example\.invalid\/recording\.mp4\)/);
});

test('refresh replaces generated evidence and receipt without nesting details or moving authored prose', () => {
  const { body, run, evidence } = publicationFixture();
  assert.equal(withPublicationProvenance(run, body), body);
  const refreshed = withPublicationProvenance(
    run,
    replaceMarkdownSection(body, '## **Screenshots/Recordings**', evidence),
  );
  assert.equal(refreshed, body);
});

test('paired evidence uses an available still for its criterion and keeps recordings as links', () => {
  const section = buildEvidenceSection(
    {
      before_after_pairs: [
        {
          label: 'Account state',
          covers: ['AC-1'],
          before: 'before.png',
          after: 'after.mp4',
        },
      ],
    },
    new Map([
      ['before.png', 'https://example.invalid/before.png'],
      ['after.mp4', 'https://example.invalid/after.mp4'],
    ]),
  );
  assert.ok(section);
  const visible = section.slice(0, section.indexOf('<details>'));
  assert.equal((visible.match(/<img\b/g) ?? []).length, 1);
  assert.match(visible, /before\.png/);
  assert.match(section, /<a href="https:\/\/example\.invalid\/after\.mp4">after<\/a>/);
  assert.doesNotMatch(section, /<img[^>]*after\.mp4/);
});

test('an older expanded publication receipt moves into the gallery without changing other sections', () => {
  const { run, evidence } = publicationFixture();
  const body = withPublicationProvenance(
    run,
    [
      '## Summary\n\nKeep this description.',
      '## Publication approval\n\nOld generated receipt.',
      '## **Screenshots/Recordings**\n\n' + evidence,
      '## Validation\n\nKeep this validation.',
    ].join('\n\n'),
  );
  assert.doesNotMatch(body, /Old generated receipt/);
  assert.equal((body.match(/Publication approval/g) ?? []).length, 1);
  assert.equal((body.match(/<details>/g) ?? []).length, 1);
  assert.match(body, /## Summary\n\nKeep this description\./);
  assert.match(body, /## Validation\n\nKeep this validation\./);
});

test('a video preference retains the complete selected still gallery', () => {
  const { manifest, urls } = publicationFixture();
  const section = buildEvidenceSection({ ...manifest, preferred_mode: 'video' }, urls);
  assert.ok(section);
  const gallery = section.slice(section.indexOf('<details>'));
  assert.equal((gallery.match(/<img\b/g) ?? []).length, 140);
  assert.match(gallery, /\[recording\.mp4\]/);
});

test('publication combines a receipt added before the gallery rewrite into the same details', () => {
  const { run, evidence } = publicationFixture();
  const draft = withPublicationProvenance(
    run,
    '## Summary\n\nDescription.\n\n## **Screenshots/Recordings**\n\nPrevious evidence.\n\n## Visual judgments\n\nReviewed.',
  );
  const rewritten = replaceMarkdownSection(draft, '## **Screenshots/Recordings**', evidence);
  const published = withPublicationProvenance(run, rewritten);
  assert.equal((published.match(/<details>/g) ?? []).length, 1);
  assert.equal(withPublicationProvenance(run, published), published);
});
