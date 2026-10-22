function all(root, selector) {
  return [
    ...root.querySelectorAll(selector),
    ...[...root.querySelectorAll('*')]
      .filter((e) => e.shadowRoot)
      .flatMap((e) => all(e.shadowRoot, selector)),
  ];
}
async function until(read, message) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}
const panel = await until(() => all(document, 'review-history-panel')[0], 'No history');
await until(() => !panel._historyLoading, 'History loading');
const round = [...panel.shadowRoot.querySelectorAll('[data-round]')].find((r) =>
  r.querySelector('.finding-location'),
);
if (!round.open) round.querySelector('summary').click();
const button = round.querySelector('.finding-location');
if (round.querySelector('code-viewer')) {
  button.click();
  await until(() => !round.querySelector('code-viewer'), 'Source did not close');
}
button.click();
const viewer = await until(() => {
  const v = round.querySelector('code-viewer');
  return v && v._editor?.getPosition()?.lineNumber === v.revealLine ? v : null;
}, 'Frozen source did not reveal the finding line');
const editor = viewer._editor;
const line = viewer.revealLine;
if (
  !editor
    .getVisibleRanges()
    .some((range) => line >= range.startLineNumber && line <= range.endLineNumber)
)
  throw new Error('Finding line is outside the viewport');
if (
  !editor
    .getModel()
    .getAllDecorations()
    .some(
      (decoration) =>
        decoration.range.startLineNumber === line &&
        decoration.options.className === 'cv-selected-line',
    )
)
  throw new Error('Finding line is not highlighted');
viewer.scrollIntoView({ block: 'center' });
return {
  runId: panel.run.id,
  round: Number(round.dataset.round),
  head: round.querySelector('code[title]').title,
  path: viewer.filePath,
  line,
  lineCount: editor.getModel().getLineCount(),
  visible: editor.getVisibleRanges(),
  highlighted: true,
  actualControlClick: true,
};
