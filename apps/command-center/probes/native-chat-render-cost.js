// Per-delta render cost of a streamed assistant message in a 300+ row conversation.
// Route: #dev/native-session?stream=1. The preview feeds 200 deltas, one per 50 ms, through the
// production conversation cache; this probe starts the stream and reads the preview's result.
const dev = document.querySelector('native-session-dev');
const view = () => dev?.shadowRoot?.querySelector('native-session-view')?.shadowRoot;
const timeline = () => view()?.querySelector('.timeline');
let end = Date.now() + 20000;
while (Date.now() < end && !(timeline()?.querySelectorAll(':scope > article').length >= 300))
  await new Promise((r) => setTimeout(r, 100));
const rows = timeline()?.querySelectorAll(':scope > article').length ?? 0;
if (rows < 300) throw new Error(`Expected 300+ rows before streaming, saw ${rows}`);
const output = dev.shadowRoot.querySelector('[data-testid="native-stream-cost"]');
dev.shadowRoot.querySelector('[data-testid="native-stream-start"]').click();
end = Date.now() + 60000;
while (Date.now() < end && !output.textContent.trim().startsWith('{')) {
  if (output.textContent.includes('Stream failed')) throw new Error(output.textContent.trim());
  await new Promise((r) => setTimeout(r, 250));
}
if (!output.textContent.trim().startsWith('{')) throw new Error('Stream did not finish in 60 s');
const cost = JSON.parse(output.textContent);
const t = timeline();
await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
const last = [...t.querySelectorAll(':scope > article.assistant')].at(-1);
return {
  chrome: navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0],
  ...cost,
  // The reader stayed at the end while it streamed.
  distanceFromEnd: Math.round(t.scrollHeight - t.scrollTop - t.clientHeight),
  streamedTail: last?.textContent.trim().slice(-60),
  styleElements: t.querySelectorAll('style').length,
};
