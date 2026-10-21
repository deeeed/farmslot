// setup-line-comments supplies immutable source. Drive rows, then inspect the real Monaco viewport.
function all(root, selector) {
  return [
    ...root.querySelectorAll(selector),
    ...[...root.querySelectorAll('*')]
      .filter((element) => element.shadowRoot)
      .flatMap((element) => all(element.shadowRoot, selector)),
  ];
}
async function until(read, description) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(description);
}
const workspace = await until(
  () =>
    all(document, 'review-workspace').find(
      (view) => view.runId === 'gate-review-fixture-request-run',
    ),
  'Fixture review did not load',
);
await until(
  () => workspace.querySelectorAll('.rw-ci').length === 3 && !workspace._isRecovering,
  'Finding rows did not become available',
);
const checks = [];
for (const [index, line, path] of [
  [0, 462, 'mobileInfrastructure.ts'],
  [1, 479, 'mobileInfrastructure.ts'],
  [2, 12, 'other.ts'],
  [0, 462, 'mobileInfrastructure.ts'],
]) {
  const row = workspace.querySelectorAll('.rw-ci')[index];
  row.click();
  const value = await until(() => {
    const viewer = workspace.querySelector('code-viewer');
    const editor = viewer?._editor;
    if (!editor || viewer.filePath !== path || editor.getPosition()?.lineNumber !== line)
      return null;
    const range = editor
      .getVisibleRanges()
      .some((range) => range.startLineNumber <= line && range.endLineNumber >= line);
    const highlight = editor
      .getModel()
      .getAllDecorations()
      .some(
        (decoration) =>
          decoration.range.startLineNumber === line &&
          decoration.options.className === 'cv-selected-line',
      );
    const thread = [...viewer.querySelectorAll('.cv-thread-widget')].find((element) =>
      element.textContent.includes(workspace._comments[index].body),
    );
    const rect = thread?.getBoundingClientRect();
    const box = viewer.getBoundingClientRect();
    const inline = rect && rect.top >= box.top && rect.top < box.bottom && rect.height > 0;
    return range && highlight && inline
      ? {
          index,
          path,
          line,
          position: editor.getPosition(),
          visible: true,
          highlighted: true,
          inlineCommentVisible: true,
        }
      : null;
  }, `Click did not reveal ${path}:${line} with its inline comment`);
  checks.push(value);
}
workspace.querySelector('code-viewer').scrollIntoView({ block: 'center' });
return {
  runId: workspace.runId,
  checks,
  actualRowClicks: true,
  source: 'gateway git.show',
  inputSent: false,
};
