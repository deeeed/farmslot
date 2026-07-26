import assert from 'node:assert/strict';
import test from 'node:test';

import {
  executionTemplateStepLabel,
  parseExecutionTemplateOutline,
} from './execution-template-preview-model.js';

test('template preview outline groups checkbox steps under level-two phases', () => {
  assert.deepEqual(
    parseExecutionTemplateOutline(`# Template

- [ ] Before headings

## Prepare

- [x] Resolve context
- [ ] Prepare slot

### Detail

- [ ] Keep this step in Prepare

## Validate

- [ ] Run proof
`),
    {
      phases: [
        { title: 'Steps', steps: [{ checked: false, text: 'Before headings' }] },
        {
          title: 'Prepare',
          steps: [
            { checked: true, text: 'Resolve context' },
            { checked: false, text: 'Prepare slot' },
            { checked: false, text: 'Keep this step in Prepare' },
          ],
        },
        { title: 'Validate', steps: [{ checked: false, text: 'Run proof' }] },
      ],
      totalSteps: 5,
      checkedSteps: 1,
    },
  );
});

test('template preview step labels remove inline Markdown chrome', () => {
  assert.equal(
    executionTemplateStepLabel('**Sandbox ready** — run `mm-harness verify`; see [guide](./x.md).'),
    'Sandbox ready — run mm-harness verify; see guide.',
  );
});

test('template preview outline omits headings without checklist steps', () => {
  assert.deepEqual(parseExecutionTemplateOutline('# Template\n\n## Context\n\nRead this first.'), {
    phases: [],
    totalSteps: 0,
    checkedSteps: 0,
  });
});
