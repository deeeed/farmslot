const RECEIPT_START = '<!-- farmslot-publication-receipt:start -->';
const RECEIPT_END = '<!-- farmslot-publication-receipt:end -->';
const DETAILS_OPEN =
  '<details>\n<summary>Full evidence gallery and publication receipt</summary>\n\n';
const DETAILS_CLOSE = '\n\n</details>';

export function publicationDetails(gallery: string, receipt = ''): string {
  return `${DETAILS_OPEN}${gallery ? gallery + '\n\n' : ''}${RECEIPT_START}\n${receipt}\n${RECEIPT_END}${DETAILS_CLOSE}`;
}

export function withPublicationReceipt(body: string, receipt: string): string {
  if (body.indexOf(RECEIPT_START) !== body.lastIndexOf(RECEIPT_START)) {
    // Publication can add the receipt before it replaces the evidence section.
    // Keep the new gallery's block and remove the earlier receipt-only block.
    body = body.replace(
      new RegExp(
        `${DETAILS_OPEN}${RECEIPT_START}[\\s\\S]*?${RECEIPT_END}${DETAILS_CLOSE}\\n*`,
        'g',
      ),
      '',
    );
  }
  const from = body.indexOf(RECEIPT_START);
  const to = body.indexOf(RECEIPT_END);
  if (from === -1 && to === -1) return `${body.trimEnd()}\n\n${publicationDetails('', receipt)}\n`;
  if (from === -1 || to < from) throw new Error('Publication receipt markers are incomplete.');
  return body.slice(0, from + RECEIPT_START.length) + '\n' + receipt + '\n' + body.slice(to);
}
