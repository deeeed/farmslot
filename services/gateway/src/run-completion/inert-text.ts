/** One line of person-written text inside generated PR markdown or HTML, inert in both. */
export const plain = (value: string) =>
  value
    .replace(/[\r\n]+/gu, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([`*_[\]\\])/gu, '\\$1');
