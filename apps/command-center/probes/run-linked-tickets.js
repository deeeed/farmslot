// Read-only assertions on the real runs page after entering a linked key in Search.
const list = document.querySelector('run-list');
if (!list?.shadowRoot) throw new Error('Open the runs list first');
const query = list.searchQuery;
if (!query || !/^[A-Z][A-Z0-9]*-\d+$/i.test(query))
  throw new Error('Enter one covered ticket key in Search');
const entries = [...list.shadowRoot.querySelectorAll('run-tag-editor[kind="tickets"]')].map(
  (editor) => {
    const links = [...editor.shadowRoot.querySelectorAll('a')].map((link) => ({
      text: link.textContent.trim(),
      href: link.href,
      height: link.getBoundingClientRect().height,
    }));
    const refs = links.filter((link) => /^[A-Z][A-Z0-9]*-\d+$/.test(link.text));
    const text = editor.shadowRoot.textContent;
    if (!text.includes(query.toUpperCase()))
      throw new Error('Matched run does not show the searched ticket');
    if (links.some((link) => link.height < 44))
      throw new Error('Ticket links are too small to tap');
    return {
      runId: editor.run.id,
      canonicalRef: editor.run.ticketOrPr,
      refs,
      pr: links.find((link) => link.text === 'PR ↗') ?? null,
    };
  },
);
if (!entries.length) throw new Error('Searching the secondary ticket did not find a run');
if (!entries.some((entry) => entry.canonicalRef !== query.toUpperCase() && entry.pr))
  throw new Error('The secondary ticket must reveal its run and recorded PR');
return { query, scope: list.tab, entries };
