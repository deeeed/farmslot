import assert from 'node:assert/strict';
import test from 'node:test';

import { workerReportText } from './report-text.js';

test('model report input retains proof content without HTML payloads or duplicate navigation', () => {
  const source =
    '<head><style>large css</style></head><nav>repeated contents</nav><h1>Smoke &amp; gaps</h1>' +
    '<details><summary>Unproved interaction</summary><p>Needs follow-up</p></details>' +
    `<img src="data:image/png;base64,${'A'.repeat(100_000)}" alt="Final wallet view">` +
    '<table><tr><td>AC1</td><td>PASS</td></tr></table><script>untrusted()</script><div hidden>hidden</div><p>Final conclusion</p>';
  const text = workerReportText('report.html', source);
  assert.match(text, /Smoke & gaps/);
  assert.match(text, /Unproved interaction\s+Needs follow-up/);
  assert.match(text, /Image: Final wallet view/);
  assert.match(text, /AC1 \| PASS/);
  assert.match(text, /Final conclusion/);
  assert.doesNotMatch(text, /base64|AAAA|untrusted|large css|repeated contents|hidden|<p>/);
  assert.ok(text.length < 250);
});

test('plain reports retain their exact content', () => {
  const markdown = '# Report\n\n`<actual>` evidence';
  assert.equal(workerReportText('report.md', markdown), markdown);
});
