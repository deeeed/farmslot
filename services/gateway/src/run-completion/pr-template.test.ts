import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertPrBodyMatchesTemplate,
  conformPrBodyToTemplate,
  levelTwoHeadings,
} from './pr-template.js';

const template = {
  path: '.github/pull-request-template.md',
  body: [
    '## **Description**',
    '## **Changelog**',
    '## **Related issues**',
    '## **Manual testing steps**',
    '<!--',
    '## Commented-out legacy section',
    '-->',
    '```markdown',
    '## Example inside a fence',
    '```',
    '## **Screenshots/Recordings**',
    '## **Pre-merge author checklist**',
    '## **Pre-merge reviewer checklist**',
  ].join('\n'),
};

test('levelTwoHeadings ignores headings inside fenced examples and HTML comments', () => {
  assert.deepEqual(levelTwoHeadings(template.body), [
    '## **Description**',
    '## **Changelog**',
    '## **Related issues**',
    '## **Manual testing steps**',
    '## **Screenshots/Recordings**',
    '## **Pre-merge author checklist**',
    '## **Pre-merge reviewer checklist**',
  ]);
});

test('PR template validation accepts canonical sections with extra project sections', () => {
  const body = [
    '## **Description**',
    'Changed the order summary.',
    '## **Changelog**',
    'CHANGELOG entry: Fixed the order summary',
    '## **Related issues**',
    'Fixes: TAT-3898',
    '## **Manual testing steps**',
    'N/A - covered by a deterministic recipe.',
    '## **Screenshots/Recordings**',
    'Evidence.',
    '## **Validation Recipe**',
    'Recipe details.',
    '## **Pre-merge author checklist**',
    '- [x] Complete',
    '## **Pre-merge reviewer checklist**',
    '- [ ] Review',
  ].join('\n');

  assert.doesNotThrow(() => assertPrBodyMatchesTemplate(body, template));
});

test('PR template validation rejects the noncanonical body published for Mobile PR 35660', () => {
  const body = [
    '## Description',
    'Changed the order summary.',
    '## Acceptance criteria',
    'Verified.',
    '## Validation',
    'Recipe passed.',
    '## Out of scope',
    'Accuracy changes.',
    '## **Screenshots/Recordings**',
    'Evidence.',
  ].join('\n');

  assert.throws(
    () => assertPrBodyMatchesTemplate(body, template),
    /missing ## \*\*Description\*\*, ## \*\*Changelog\*\*, ## \*\*Related issues\*\*, ## \*\*Manual testing steps\*\*, ## \*\*Pre-merge author checklist\*\*, ## \*\*Pre-merge reviewer checklist\*\*/,
  );
});

test('PR template validation rejects canonical sections in the wrong order', () => {
  const body = [
    '## **Changelog**',
    '## **Description**',
    '## **Related issues**',
    '## **Manual testing steps**',
    '## **Screenshots/Recordings**',
    '## **Pre-merge author checklist**',
    '## **Pre-merge reviewer checklist**',
  ].join('\n');

  assert.throws(() => assertPrBodyMatchesTemplate(body, template), /out of order/);
});

test('a body missing template sections gets them appended from the template instead of failing', () => {
  const template = {
    path: '.github/pull-request-template.md',
    body: [
      '## **Description**',
      '',
      '<!-- what -->',
      '',
      '## **Pre-merge author checklist**',
      '',
      "- [ ] I've followed the guidelines",
      '',
      '## **Pre-merge reviewer checklist**',
      '',
      "- [ ] I've manually tested",
      '',
    ].join('\n'),
  };
  const body = '## **Description**\n\nAdds it.\n';
  const conformed = conformPrBodyToTemplate(body, template);
  assert.deepEqual(conformed.added, [
    '## **Pre-merge author checklist**',
    '## **Pre-merge reviewer checklist**',
  ]);
  assert.deepEqual(conformed.outOfOrder, []);
  assert.equal(
    conformed.body,
    [
      '## **Description**',
      '',
      'Adds it.',
      '',
      '## **Pre-merge author checklist**',
      '',
      "- [ ] I've followed the guidelines",
      '',
      '## **Pre-merge reviewer checklist**',
      '',
      "- [ ] I've manually tested",
      '',
    ].join('\n'),
  );
  assert.doesNotThrow(() => assertPrBodyMatchesTemplate(conformed.body, template));
  // A conforming body is returned untouched.
  const complete = conformPrBodyToTemplate(conformed.body, template);
  assert.equal(complete.body, conformed.body);
  assert.deepEqual(complete.added, []);
});

test('sections in the wrong order are reported but the body is left as the author wrote it', () => {
  const template = { path: 't.md', body: '## A\n\n## B\n' };
  const body = '## B\n\nb\n\n## A\n\na\n';
  const conformed = conformPrBodyToTemplate(body, template);
  assert.equal(conformed.body, body);
  assert.deepEqual(conformed.outOfOrder, ['## B']);
  assert.deepEqual(conformed.added, []);
});
