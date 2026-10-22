// Inspect a finding, or verify a fresh shared link without another comment click.
function all(root, selector) {
  return [
    ...root.querySelectorAll(selector),
    ...[...root.querySelectorAll('*')]
      .filter((element) => element.shadowRoot)
      .flatMap((element) => all(element.shadowRoot, selector)),
  ];
}
let params = new URLSearchParams(location.hash.split('?')[1]);
let commentClicks = 0;
if (!params.get('comment')) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const workspace = all(document, 'review-workspace')[0];
    const row = workspace?.querySelector('.rw-ci');
    if (row && !workspace._isRecovering) {
      row.click();
      commentClicks++;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  params = new URLSearchParams(location.hash.split('?')[1]);
}
const file = params.get('commentFile');
const line = Number(params.get('commentLine'));
const head = params.get('commentHead');
if (!file || !line || !head || !params.get('comment'))
  throw new Error('No finding location in URL');
const deadline = Date.now() + 20000;
while (Date.now() < deadline) {
  const workspace = all(document, 'review-workspace')[0];
  const viewer = workspace?.querySelector('code-viewer');
  const editor = viewer?._editor;
  const selected = workspace?._comments[workspace._selectedCommentIdx];
  if (
    selected?.path === file &&
    selected.line === line &&
    !workspace._commentFileLoading &&
    workspace._commentFileError
  ) {
    return {
      link: location.href,
      file,
      line,
      reviewedHead: head,
      selectedCommentIndex: workspace._selectedCommentIdx,
      available: false,
      error: workspace._commentFileError,
      sourceBytes: new TextEncoder().encode(workspace._commentFileContent).length,
      modelLineCount: editor?.getModel()?.getLineCount(),
      inlineCommentPresent: Boolean(viewer?.querySelector('.cv-thread-widget')),
      commentClicks,
    };
  }
  if (
    editor &&
    selected?.path === file &&
    selected.line === line &&
    workspace._payload.reviewSnapshot.headSha === head &&
    editor.getPosition()?.lineNumber === line &&
    editor
      .getVisibleRanges()
      .some((range) => range.startLineNumber <= line && range.endLineNumber >= line)
  ) {
    const highlighted = editor
      .getModel()
      .getAllDecorations()
      .some(
        (decoration) =>
          decoration.range.startLineNumber === line &&
          decoration.options.className === 'cv-selected-line',
      );
    if (highlighted && viewer.querySelector('.cv-thread-widget')) {
      viewer.scrollIntoView({ block: 'center' });
      return {
        link: location.href,
        file,
        line,
        reviewedHead: head,
        selectedCommentIndex: workspace._selectedCommentIdx,
        modelLineCount: editor.getModel().getLineCount(),
        sourceLineCount:
          viewer.content.split(/\r\n?|\n/).length - (viewer.content.endsWith('\n') ? 1 : 0),
        visible: true,
        available: true,
        highlighted: true,
        inlineCommentPresent: true,
        commentClicks,
      };
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
}
throw new Error('Shared finding link did not restore its exact source line and selected comment');
