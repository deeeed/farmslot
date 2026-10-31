/**
 * Companion's terminals show a tmux client attached through the gateway, a relay that can take
 * several seconds. The tmux client queries its terminal when it attaches and stops waiting after a
 * few seconds; a reply that arrives later is typed into the pane as keys (zsh then shows
 * "0;276;0c"). tmux works without the replies (it falls back to TERM), so the terminal view leaves
 * every query unanswered.
 *
 * Plain JavaScript source: it runs inside the terminal WebView, and the tests run it against xterm.
 */
export const SILENCE_TERMINAL_QUERIES_JS = `
function silenceTerminalQueries(term) {
  var handled = function () { return true; };
  [
    { final: 'c' },
    { prefix: '>', final: 'c' },
    { final: 'n' },
    { prefix: '?', final: 'n' },
    { intermediates: '$', final: 'p' },
    { prefix: '?', intermediates: '$', final: 'p' }
  ].forEach(function (id) { term.parser.registerCsiHandler(id, handled); });
  term.parser.registerDcsHandler({ intermediates: '$', final: 'q' }, handled);
  [4, 10, 11, 12].forEach(function (code) {
    term.parser.registerOscHandler(code, function (data) { return data.indexOf('?') !== -1; });
  });
}
`;
