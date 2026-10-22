// Drive recorded finding rows, then inspect immutable source, the Monaco viewport and share links.
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
  () => all(document, 'review-workspace')[0],
  'Recorded review did not load',
);
await until(
  () => workspace.querySelectorAll('.rw-ci').length > 0 && !workspace._isRecovering,
  'Finding rows did not become available',
);
const checks = [];
const indices = [...workspace._comments.map((_, index) => index), 0];
for (const index of indices) {
  const { line, path } = workspace._comments[index];
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
          modelLineCount: editor.getModel().getLineCount(),
          sourceLineCount:
            viewer.content.split(/\r\n?|\n/).length - (viewer.content.endsWith('\n') ? 1 : 0),
          sourceBytes: new TextEncoder().encode(viewer.content).length,
          reviewedHead: workspace._payload.reviewSnapshot.headSha,
          link: location.href,
        }
      : null;
  }, `Click did not reveal ${path}:${line} with its inline comment`);
  const params = new URLSearchParams(location.hash.split('?')[1]);
  if (
    params.get('commentFile') !== path ||
    Number(params.get('commentLine')) !== line ||
    params.get('commentHead') !== workspace._payload.reviewSnapshot.headSha ||
    !params.get('comment')
  )
    throw new Error('Finding click did not record its full URL location');
  checks.push(value);
}
workspace.querySelector('code-viewer').scrollIntoView({ block: 'center' });
return {
  runId: workspace.runId,
  checks,
  actualRowClicks: true,
  source: 'gateway git.show',
  publicationSent: false,
};
