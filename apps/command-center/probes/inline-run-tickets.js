// Rendering and navigation assertions only; never edit run metadata.
const list = document.querySelector('run-list');
if (!list?.shadowRoot) throw new Error('Open the runs list first');
const deadline = Date.now() + 10000;
while (
  Date.now() < deadline &&
  !list.shadowRoot.querySelector('[data-testid="runs-row-inline-tickets-6"]')
)
  await new Promise((resolve) => setTimeout(resolve, 25));
const entries = [...list.shadowRoot.querySelectorAll('run-tag-editor[kind="tickets"]')]
  .filter((editor) => editor.run.id.startsWith('inline-tickets-'))
  .map((editor) => {
    const line = editor.shadowRoot.querySelector('.ticket-line');
    if (!line) throw new Error('Run source must use the compact inline component');
    if (editor.shadowRoot.querySelector('.tag-pill, .tag-label'))
      throw new Error('Compact references must not have pills or a label row');
    const links = [...line.querySelectorAll('a')];
    const text = line.textContent.trim();
    if (text !== links.map((link) => link.textContent.trim()).join(', '))
      throw new Error('Linked references must be comma separated on one line');
    const sourceCount = links.filter(
      (link) => link.textContent.trim() === editor.run.ticketOrPr,
    ).length;
    if (sourceCount !== 1) throw new Error('The source ticket must appear exactly once');
    const row = editor.closest('[role="row"]');
    const duplicate = [...row.querySelectorAll('[data-testid="runs-ref"]')];
    if (duplicate.length !== 1 || duplicate[0] !== editor)
      throw new Error('The old separate source display must be removed');
    const fontSize = getComputedStyle(line).fontSize;
    if (fontSize !== getComputedStyle(row).fontSize)
      throw new Error('Ticket text must match the metadata font size');
    if (
      links.some(
        (link) =>
          Math.abs(link.getBoundingClientRect().top - links[0].getBoundingClientRect().top) > 1,
      )
    )
      throw new Error('Ticket links must stay on one line');
    if (links.some((link) => !link.href.startsWith('https://tracker.example/browse/')))
      throw new Error('Fixture Jira destinations changed');
    const timing = row.querySelector('[data-testid="runs-timing"]');
    if (!timing || !timing.classList.contains('pipeline-label'))
      throw new Error('Run time must reuse the existing metadata line');
    if (!/\d+m total/.test(timing.textContent)) throw new Error('Total run time is missing');
    const record = {
      runId: editor.run.id,
      count: links.length,
      text,
      height: line.getBoundingClientRect().height,
      rowHeight: row.getBoundingClientRect().height,
      fontSize,
      timing: row.querySelector('[data-testid="runs-timing"]')?.textContent.trim(),
      scrollWidth: line.scrollWidth,
      clientWidth: line.clientWidth,
    };
    if (line.scrollWidth > line.clientWidth) {
      line.scrollTo({ left: line.scrollWidth });
      if (line.scrollLeft === 0)
        throw new Error('Additional tickets must remain reachable by scrolling');
    }
    return record;
  });
if (!entries.some((entry) => entry.count === 1) || !entries.some((entry) => entry.count === 6))
  throw new Error('Open #dev/runs?demo=inline-tickets for one- and six-ticket cases');
let liveClock;
if (new URLSearchParams(location.hash.split('?')[1]).get('demo') === 'inline-tickets-clock') {
  const read = (id) =>
    list.shadowRoot
      .querySelector(`[data-testid="runs-row-${id}"] [data-testid="runs-timing"]`)
      ?.textContent.trim();
  const before = { active: read('inline-tickets-1'), completed: read('inline-tickets-6') };
  const deadline = Date.now() + 65000;
  while (Date.now() < deadline && read('inline-tickets-1') === before.active)
    await new Promise((resolve) => setTimeout(resolve, 250));
  const after = { active: read('inline-tickets-1'), completed: read('inline-tickets-6') };
  if (!after.active || after.active === before.active)
    throw new Error('Active metadata clock did not tick');
  if (after.completed !== before.completed)
    throw new Error('Completed metadata clock must stay frozen');
  liveClock = { before, after };
}
return { entries, liveClock, viewportWidth: innerWidth };
