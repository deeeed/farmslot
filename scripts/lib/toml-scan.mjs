export function isTomlSectionHeader(line) {
  return /^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?$/.test(line);
}

export function scanTomlLine(line, state) {
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (state.quote === '"""' || state.quote === "'''") {
      if (state.quote === '"""' && escaped) {
        escaped = false;
        continue;
      }
      if (state.quote === '"""' && char === '\\') {
        escaped = true;
        continue;
      }
      if (line.startsWith(state.quote, index)) {
        const quoteChar = state.quote[0];
        let closingRunLength = 3;
        while (line[index + closingRunLength] === quoteChar) closingRunLength += 1;
        index += closingRunLength - 1;
        state.quote = null;
      }
      continue;
    }
    if (state.quote) {
      if (state.quote === '"' && escaped) {
        escaped = false;
      } else if (state.quote === '"' && char === '\\') {
        escaped = true;
      } else if (char === state.quote) {
        state.quote = null;
      }
      continue;
    }
    if (char === '#') break;
    if (line.startsWith('"""', index) || line.startsWith("'''", index)) {
      state.quote = line.slice(index, index + 3);
      index += 2;
    } else if (char === '"' || char === "'") {
      state.quote = char;
    } else if (char === '[') {
      state.arrayDepth += 1;
    } else if (char === ']') {
      state.arrayDepth = Math.max(0, state.arrayDepth - 1);
    }
  }
  if (state.quote === '"' || state.quote === "'") state.quote = null;
}

export function tomlSectionHeaderIndexes(lines) {
  const headers = new Set();
  const state = { arrayDepth: 0, quote: null };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (state.arrayDepth === 0 && state.quote === null && isTomlSectionHeader(line)) {
      headers.add(index);
      continue;
    }
    scanTomlLine(line, state);
  }
  return headers;
}
