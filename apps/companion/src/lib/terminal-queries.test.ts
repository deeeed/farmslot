import assert from 'node:assert/strict';
import test from 'node:test';

import { SILENCE_TERMINAL_QUERIES_JS } from './terminal-queries';

type Handler = (data?: string) => boolean;
type Identifier = { prefix?: string; intermediates?: string; final: string };

/** The part of xterm's parser API the silencer uses, recording what it registers. */
function fakeTerminal() {
  const id = ({ prefix = '', intermediates = '', final }: Identifier) =>
    `${prefix}${intermediates}${final}`;
  const csi = new Map<string, Handler>();
  const dcs = new Map<string, Handler>();
  const osc = new Map<number, Handler>();
  const term = {
    parser: {
      registerCsiHandler: (identifier: Identifier, handler: Handler) =>
        csi.set(id(identifier), handler),
      registerDcsHandler: (identifier: Identifier, handler: Handler) =>
        dcs.set(id(identifier), handler),
      registerOscHandler: (code: number, handler: Handler) => osc.set(code, handler),
    },
  };
  return { csi, dcs, osc, term };
}

test('the terminal view claims every query xterm answers and lets color settings through', () => {
  const { csi, dcs, osc, term } = fakeTerminal();
  const silence = new Function(
    'term',
    `${SILENCE_TERMINAL_QUERIES_JS}\nsilenceTerminalQueries(term);`,
  ) as (target: typeof term) => void;
  silence(term);

  // xterm 6 answers device attributes (c, >c), status and cursor reports (n, ?n), mode requests
  // ($p, ?$p) and setting requests (DCS $q). A handler returning true leaves them unanswered.
  assert.deepEqual([...csi.keys()].sort(), ['$p', '>c', '?$p', '?n', 'c', 'n']);
  for (const handler of csi.values()) assert.equal(handler(), true);
  assert.equal(dcs.get('$q')?.(), true);
  for (const code of [4, 10, 11, 12]) assert.equal(osc.get(code)?.('?'), true, `OSC ${code} query`);
  assert.equal(osc.get(4)?.('1;?'), true);
  assert.equal(osc.get(11)?.('#000000'), false, 'a color setting still applies');
});
