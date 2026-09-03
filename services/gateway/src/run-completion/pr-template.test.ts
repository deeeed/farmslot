import assert from 'node:assert/strict';
import test from 'node:test';

import { assertPrBodyMatchesTemplate, levelTwoHeadings } from './pr-template.js';

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
