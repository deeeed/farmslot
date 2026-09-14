// Read-only geometry check after scrolling the actual decision control into view.
const walk = (root) =>
  [...root.querySelectorAll('*')].flatMap((element) =>
    element.shadowRoot ? [element, ...walk(element.shadowRoot)] : [element],
  );
const button = walk(document).find((element) =>
  element.matches('[data-testid="native-worker-resume"]'),
);
if (!button) return null;
button.scrollIntoView({ behavior: 'instant', block: 'center' });
const rect = button.getBoundingClientRect();
let top = Math.max(0, rect.top);
let bottom = Math.min(innerHeight, rect.bottom);
let left = Math.max(0, rect.left);
let right = Math.min(innerWidth, rect.right);
let parent = button.parentElement ?? button.getRootNode().host;
while (parent) {
  const style = getComputedStyle(parent);
  const bounds = parent.getBoundingClientRect();
  if (['auto', 'scroll', 'hidden', 'clip'].includes(style.overflowY)) {
    top = Math.max(top, bounds.top);
    bottom = Math.min(bottom, bounds.bottom);
  }
  if (['auto', 'scroll', 'hidden', 'clip'].includes(style.overflowX)) {
    left = Math.max(left, bounds.left);
    right = Math.min(right, bounds.right);
  }
  parent = parent.parentElement ?? parent.getRootNode().host;
}
return {
  label: button.textContent.trim(),
  disabled: button.disabled,
  visible:
    rect.height > 0 &&
    rect.width > 0 &&
    bottom - top >= rect.height - 1 &&
    right - left >= rect.width - 1,
  height: rect.height,
  visibleHeight: Math.max(0, bottom - top),
};
