import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import { ReviewDispatchViewModel } from '@farmslot/review-dispatch';

mock.module('../../gateway-client.js', { namedExports: { gateway: {} } });
Object.defineProperty(globalThis, 'location', {
  configurable: true,
  value: new URL('http://localhost/'),
});
const { ReviewDispatchPicker } = await import('./review-dispatch-picker.js');

function markup(value: unknown): string {
  if (Array.isArray(value)) return value.map(markup).join('');
  if (value && typeof value === 'object' && 'strings' in value && 'values' in value) {
    if (Array.isArray(value.strings) && Array.isArray(value.values))
      return value.strings.join('') + value.values.map(markup).join('');
  }
  return '';
}

test('dispatch and warm review render searchable choices without native selects', () => {
  const picker = new ReviewDispatchPicker();
  picker.viewModel = new ReviewDispatchViewModel({
    context: {
      allowedActions: ['request-review'],
      reviewLineages: [{ repository: 'owner/repo', prNumber: 1, reviewId: 'review-1' }],
    },
    sequence: [{ runner: 'codex', model: null, effort: null, mode: 'warm' }],
  });
  for (const review of [false, true]) {
    picker.review = review;
    const rendered = markup(picker.render());
    assert.doesNotMatch(rendered, /<select\b/i);
    for (const field of ['runner', 'model', 'effort', ...(review ? ['mode', 'lineage'] : [])]) {
      assert.match(
        rendered,
        new RegExp(`<choice-picker\\s+data-testid="review-dispatch-${field}"`),
      );
    }
  }
});

const choiceValue = /\._?(?:runner|model|effort)\b/i;
const choiceHandler =
  /\b_?(?:set|change|select|choose)(?:Runner|Model|Effort)\s*\(|\b(?:runner|model|effort)\s*:/i;

/** Inspect rendered controls, excluding state adapters and read-only model metadata. */
function hasIndependentChoices(source: string, filename: string): boolean {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  let found = false;
  function visit(node: ts.Node) {
    if (ts.isTaggedTemplateExpression(node) && node.tag.getText(file) === 'html') {
      const expressions: string[] = [];
      const template = node.template;
      const text = ts.isNoSubstitutionTemplateLiteral(template)
        ? template.text
        : template.head.text +
          template.templateSpans
            .map((span, index) => {
              expressions.push(span.expression.getText(file));
              return `EXPRESSION_${index}_` + span.literal.text;
            })
            .join('');
      for (const control of text.matchAll(/<(?:select|input|button|choice-picker)\b[^>]*>/g)) {
        for (const binding of control[0].matchAll(/(\.value|@\w+)\s*=\s*["']?EXPRESSION_(\d+)_/g)) {
          const expression = expressions[Number(binding[2])];
          if (
            binding[1] === '.value' ? choiceValue.test(expression) : choiceHandler.test(expression)
          )
            found = true;
        }
      }
    }
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      if (['TextInput', 'Picker', 'Choice', 'Pressable'].includes(node.tagName.getText(file))) {
        for (const attr of node.attributes.properties) {
          if (
            !ts.isJsxAttribute(attr) ||
            !attr.initializer ||
            !ts.isJsxExpression(attr.initializer)
          )
            continue;
          const expression = attr.initializer.expression?.getText(file) ?? '';
          if (
            attr.name.getText(file) === 'value'
              ? choiceValue.test(expression)
              : choiceHandler.test(expression)
          )
            found = true;
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return found;
}

test('choice guard catches native, custom and native-app duplicates but permits metadata', () => {
  for (const control of ['select', 'input', 'choice-picker'])
    assert.equal(
      hasIndependentChoices(
        'html`<' + control + ' .value=${candidate.model}></' + control + '>`',
        'fixture.ts',
      ),
      true,
    );
  assert.equal(
    hasIndependentChoices(
      'html`<button @click=${() => vm.setRunner(1, "codex")}>Codex</button>`',
      'fixture.ts',
    ),
    true,
  );
  assert.equal(
    hasIndependentChoices('<TextInput value={candidate.effort} />', 'fixture.tsx'),
    true,
  );
  assert.equal(
    hasIndependentChoices('html`<select .value=${options.publishReview}></select>`', 'fixture.ts'),
    false,
  );
  assert.equal(
    hasIndependentChoices('<Metric label="Model" value={run.model} />', 'fixture.tsx'),
    false,
  );
});

test('CC and Companion render runner/model/effort controls only in their shared pickers', () => {
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../..');
  const allowed = new Set([
    'apps/command-center/ui/src/components/shared/review-dispatch-picker.ts',
    'apps/companion/src/features/review-dispatch/ReviewDispatchPicker.tsx',
  ]);
  const duplicates: string[] = [];
  function inspect(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) inspect(path);
      else if (/\.tsx?$/.test(entry.name) && !/\.(test|d)\.tsx?$/.test(entry.name)) {
        if (
          !allowed.has(relative(repository, path)) &&
          hasIndependentChoices(readFileSync(path, 'utf8'), path)
        )
          duplicates.push(relative(repository, path));
      }
    }
  }
  inspect(join(repository, 'apps/command-center/ui/src'));
  inspect(join(repository, 'apps/companion/src'));
  assert.deepEqual(
    duplicates,
    [],
    'Use the shared review-dispatch picker instead of independent controls',
  );
});
