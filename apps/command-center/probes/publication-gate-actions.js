// Run against an open gate with review findings and a missing current-version review.
// Opens setup and disclosures only. Never submits a review, judgment or publication.
function all(root, selector) {
  return [
    ...root.querySelectorAll(selector),
    ...[...root.querySelectorAll('*')]
      .filter((element) => element.shadowRoot)
      .flatMap((element) => all(element.shadowRoot, selector)),
  ];
}

const deadline = Date.now() + 15000;
let gate;
do {
  gate = all(document, 'ready-workspace').find((element) =>
    element.querySelector('[data-testid="blocker-request-review"]'),
  );
  if (gate) break;
  await new Promise((resolve) => setTimeout(resolve, 100));
} while (Date.now() < deadline);
if (!gate) throw new Error('No gate has an inline Request review action');

const blockers = gate.querySelector('[data-testid="rdy-blockers"]');
const text = blockers.textContent.replace(/\s+/g, ' ').trim();
if (!text.includes('The current version needs a review')) throw new Error('Missing plain copy');
if (!blockers.querySelector('.rdy-finding-summary')?.textContent.trim())
  throw new Error('Missing finding summary');
const disclosure = blockers.querySelector('[data-testid="blocker-see-findings"]');
if (!disclosure.closest('details').open) disclosure.click();
if (!disclosure.closest('details').open) throw new Error('Finding disclosure did not open');
const accept = blockers.querySelector('[data-testid="blocker-accept-findings"]');
if (accept) {
  accept.click();
  await gate.updateComplete;
  if (!gate.querySelector('[data-testid="accept-findings-reason"]'))
    throw new Error('Accept finding did not open the reason form');
}

const request = blockers.querySelector('[data-testid="blocker-request-review"]');
request.click();
await gate.updateComplete;
const picker = gate.querySelector('review-dispatch-picker');
await picker.updateComplete;
const model = picker.viewModel;
const row = model.rows[0];
if (row.selection.mode !== 'warm' || !row.context || !model.executionLocked(row.id))
  throw new Error('The retained WARM reviewer is not selected and locked');
const retained = model.context.lineageOptions.find(
  (option) => option.context.reviewId === row.context.reviewId,
);
for (const key of ['runner', 'model', 'effort'])
  if (row.selection[key] !== retained[key]) throw new Error(`Retained ${key} differs`);
const payload = model.toRequestPayload();
const modal = gate.querySelector('.rdy-review-modal');
const viewport = { width: innerWidth, height: innerHeight };
const rect = modal.getBoundingClientRect();
if (rect.left < 0 || rect.right > innerWidth + 1) throw new Error('Review dialog overflows');
gate.querySelector('.rdy-review-modal-head .rdy-modal-close').click();
await gate.updateComplete;
const buttons = [...blockers.querySelectorAll('button, summary')];
for (const button of buttons)
  if (button.getBoundingClientRect().height < 44) throw new Error('Blocker action below 44px');
return {
  blockers: text,
  request: request.textContent.trim(),
  payload,
  viewport,
  findingOpened: true,
  acceptReasonOpened: Boolean(accept),
  submitted: false,
};
