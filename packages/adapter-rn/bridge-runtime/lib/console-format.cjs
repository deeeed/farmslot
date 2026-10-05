'use strict';

// Render CDP Runtime.consoleAPICalled args (RemoteObjects) into a log line.
// Primitives carry `value`; objects/arrays do not — a bare console.log(obj)
// arrived as the literal "Object". Hermes ships an inline `preview` (the same
// one React Native DevTools renders in its console), so objects expand from it
// synchronously — no extra CDP round-trip, so the stream never blocks. Depth is
// bounded because previews nest one level via `valuePreview`; beyond that the
// child preview's own description is used.

const MAX_PREVIEW_DEPTH = 2;

function formatPropertyValue(prop, depth) {
  if (prop.valuePreview && depth < MAX_PREVIEW_DEPTH) {
    return formatPreview(prop.valuePreview, depth + 1);
  }
  if (prop.type === 'string' && prop.value !== undefined) return JSON.stringify(prop.value);
  if (prop.value !== undefined) return String(prop.value);
  return prop.subtype || prop.type || '';
}

function formatPreview(preview, depth) {
  const properties = Array.isArray(preview.properties) ? preview.properties : [];
  const overflow = preview.overflow ? ', …' : '';
  if (preview.subtype === 'array') {
    return `[${properties.map((p) => formatPropertyValue(p, depth)).join(', ')}${overflow}]`;
  }
  const body = properties.map((p) => `${p.name}: ${formatPropertyValue(p, depth)}`).join(', ');
  // Name a non-plain constructor (Error, Map, custom class) so the class is not lost.
  const ctor =
    preview.description && preview.description !== 'Object' ? `${preview.description} ` : '';
  return properties.length > 0 || overflow ? `${ctor}{ ${body}${overflow} }` : `${ctor}{}`;
}

function formatRemoteObject(a) {
  if (!a || typeof a !== 'object') return String(a == null ? '' : a);
  // Primitives (number/boolean/string) carry a directly-usable value.
  if (a.type !== 'object' && a.type !== 'function' && a.value !== undefined) return String(a.value);
  if (a.type === 'undefined') return 'undefined';
  if (a.subtype === 'null') return 'null';
  if (a.preview) return formatPreview(a.preview, 1);
  // Functions, errors, and objects with no preview: the description is the best
  // available text (className / Error stack / etc.); fall back to bare value/type.
  if (a.description !== undefined) return a.description;
  if (a.value !== undefined) return String(a.value);
  return a.type || '';
}

function formatArgs(args, maxLineChars) {
  const text = (args || []).map(formatRemoteObject).join(' ');
  return maxLineChars && text.length > maxLineChars ? `${text.slice(0, maxLineChars)}…` : text;
}

module.exports = { formatArgs, formatRemoteObject, formatPreview };
