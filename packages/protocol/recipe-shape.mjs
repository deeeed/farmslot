import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

import {
  filterWorkerAcceptanceCriteria,
  registeredAcceptanceCriteria,
} from './scripts/acceptance.mjs';
import {
  BUILT_IN_RECIPE_PLATFORMS,
  recipeFileIdentity,
} from './scripts/recipe-library-identity.mjs';
const POLICY = {
  short: {
    good: 8,
    max: 40,
  },
  positive: {
    short: 0.6,
    composed: 0.8,
    parameterized: 0.7,
  },
  skipValueKeys:
    '^(test_?id|selector|locator|route|screen|page|text|label|key|role|target|path|url|file|dir|expect|expected|equals|contains|match|text_?match|status|state|mode|platform|visibility|direction|surface|title|message|name|description|reason|kind|format|assert|source|stream|cmd|command|cwd|artifacts|category|covers|expression|fail_when|probes|scope|require_features|pixels|distance|width|height|x|y|index|count|timeout|interval|retries|attempts|delay|poll|limit)$|_ms$|^css_|timeout|delay|interval|duration|poll',
  selectorKeys: '^(test_?id|selector|locator|route|text|label|ref|key)$',
};
Object.freeze(POLICY.short);
Object.freeze(POLICY.positive);
Object.freeze(POLICY);
const POLICY_VERSION = 1;
const STRUCTURAL = new Set([
  'action',
  'intent',
  'next',
  'cases',
  'default',
  'proves',
  'claimBindings',
  'ref',
  'review',
  'id',
]);
const skipValue = new RegExp(POLICY.skipValueKeys, 'i');
const selectorKey = new RegExp(POLICY.selectorKeys, 'i');
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (record(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
function stableDigest(value) {
  return bytesToHex(sha256(utf8ToBytes(JSON.stringify(canonical(value)))));
}
function graphOrder(nodes, start) {
  const seen = new Set(),
    order = [],
    stack = [start];
  while (stack.length) {
    const id = stack.pop();
    if (typeof id !== 'string' || !record(nodes[id]) || seen.has(id)) continue;
    seen.add(id);
    const node = nodes[id];
    if (node.action === 'end') continue;
    order.push(id);
    const edges = [node.next, ...Object.values(record(node.cases) ? node.cases : {}), node.default];
    stack.push(...edges.reverse());
  }
  return order;
}
function recipeShapeSelector(node) {
  for (const [key, value] of Object.entries(node))
    if (
      !STRUCTURAL.has(key) &&
      selectorKey.test(key) &&
      ['string', 'number'].includes(typeof value)
    )
      return `${key}=${value}`;
  return null;
}
function recipeShapeNodeToken(node) {
  const action = node.action ?? '?';
  let selector = recipeShapeSelector(node);
  if (!selector) return action;
  if (selector.includes('{{')) {
    selector = selector.replace(/\{\{[^}]*\}\}/g, '*');
    if (!/\w/.test(selector.slice(selector.indexOf('=') + 1).replaceAll('*', ''))) return action;
  }
  return `${action}|${selector}`;
}
function isRecipeShapeObservation(action = '') {
  return (
    ['wait', 'app.hud', 'end'].includes(action) ||
    action.startsWith('assert') ||
    action.includes('.assert_') ||
    action.includes('.read_') ||
    ['wait_for', 'screenshot', 'capture_surface'].some((suffix) => action.endsWith(suffix))
  );
}
function recipeShapeSignature(tokens) {
  return tokens.map((token) =>
    isRecipeShapeObservation(token.split('|')[0]) ? token.split('|')[0] : token,
  );
}
function inspectRecipeShape(recipe) {
  const workflow = recipe.workflow ?? {},
    nodes = workflow.nodes ?? {};
  const reachable = [
    ...new Set([...graphOrder(nodes, workflow.entry), ...graphOrder(nodes, workflow.teardown)]),
  ];
  const order = [
    ...reachable,
    ...Object.keys(nodes).filter(
      (id) => !reachable.includes(id) && record(nodes[id]) && nodes[id].action !== 'end',
    ),
  ];
  const tokens = order.map((id) => recipeShapeNodeToken(nodes[id]));
  return { order, reachable, tokens, signature: recipeShapeSignature(tokens) };
}
function valueLeaves(value, path, out) {
  if (Array.isArray(value))
    value.forEach((item, index) => valueLeaves(item, [...path, String(index)], out));
  else if (record(value))
    Object.entries(value).forEach(([key, item]) => valueLeaves(item, [...path, key], out));
  else if (typeof value === 'string' && value.includes('{{')) out.templated++;
  else if (
    (typeof value === 'string' && value !== '') ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    out.literals.push(path.join('.'));
}
function nodeValues(node, id, out) {
  for (const [key, value] of Object.entries(node)) {
    if (STRUCTURAL.has(key) || skipValue.test(key)) continue;
    if (key === 'params' && record(value)) {
      for (const [parameter, item] of Object.entries(value))
        if (!skipValue.test(parameter)) valueLeaves(item, [id, key, parameter], out);
    } else valueLeaves(value, [id, key], out);
  }
}
function globRegex(pattern) {
  let result = '^';
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === '*') result += '.*';
    else if (char === '?') result += '.';
    else if (char === '[') {
      let end = index + 1;
      if (pattern[end] === '!') end++;
      if (pattern[end] === ']') end++;
      while (end < pattern.length && pattern[end] !== ']') end++;
      if (end === pattern.length) result += '\\[';
      else {
        let content = pattern.slice(index + 1, end);
        if (content.includes('-')) {
          const chunks = [];
          let beginning = index + 1,
            scan = beginning + (pattern[beginning] === '!' ? 2 : 1);
          for (;;) {
            const dash = pattern.indexOf('-', scan);
            if (dash < 0 || dash >= end) break;
            chunks.push(pattern.slice(beginning, dash));
            beginning = dash + 1;
            scan = dash + 3;
          }
          const tail = pattern.slice(beginning, end);
          if (tail) chunks.push(tail);
          else chunks[chunks.length - 1] += '-';
          // Preserve the dataset's fnmatchcase handling of reversed/empty ranges.
          for (let part = chunks.length - 1; part > 0; part--) {
            if (chunks[part - 1].slice(-1) > chunks[part][0]) {
              chunks[part - 1] = chunks[part - 1].slice(0, -1) + chunks[part].slice(1);
              chunks.splice(part, 1);
            }
          }
          content = chunks
            .map((chunk) => chunk.replaceAll('\\', '\\\\').replaceAll('-', '\\-'))
            .join('-');
        } else content = content.replaceAll('\\', '\\\\');
        content = content.replace(/[&~|]/g, '\\$&');
        if (!content) result += '(?!)';
        else if (content === '!') result += '.';
        else {
          if (content[0] === '!') content = '^' + content.slice(1);
          else if (['^', '['].includes(content[0])) content = '\\' + content;
          result += `[${content}]`;
        }
        index = end;
      }
    } else result += char.replace(/[\\^$+?.()|{}\[\]]/g, '\\$&');
  }
  return new RegExp(result + '$', 's');
}
function sameToken(token, pattern, patterns) {
  if (pattern.includes('*') && !patterns.has(pattern)) patterns.set(pattern, globRegex(pattern));
  return (
    token === pattern ||
    (!pattern.includes('|') && token.split('|')[0] === pattern) ||
    (pattern.includes('*') && patterns.get(pattern).test(token))
  );
}
function roundScore(value) {
  const scaled = value * 1000,
    floor = Math.floor(scaled),
    fraction = scaled - floor;
  return (fraction === 0.5 ? floor + (floor % 2) : Math.round(scaled)) / 1000;
}
function scoreRecipeShape(input) {
  const recipe = input.recipe;
  if (!record(recipe) || !record(recipe.workflow) || !record(recipe.workflow.nodes))
    throw new TypeError('Expected a Recipe v1 workflow.nodes object');
  const catalog = input.catalog ?? { available: false, blocks: [], sources: [] };
  const blocks = catalog.available ? (catalog.blocks ?? []) : [];
  if (blocks.length > 2048 || utf8ToBytes(JSON.stringify(catalog)).length > 8 * 1024 * 1024)
    throw new TypeError('Shape catalog exceeds 2048 blocks or 8 MiB');
  const inspected = inspectRecipeShape(recipe),
    nodes = recipe.workflow.nodes,
    count = inspected.order.length;
  const calls = inspected.order
    .filter((id) => nodes[id].action === 'call')
    .map((id) => nodes[id].ref);
  const values = { templated: 0, literals: [] };
  inspected.order.forEach((id) => nodeValues(nodes[id], id, values));
  const positions = new Set(),
    duplicates = [];
  const patterns = new Map();
  for (const block of blocks) {
    const signature = block.sig ?? block.tokens ?? [];
    if (!signature.length) continue;
    for (let start = 0; start <= inspected.tokens.length - signature.length; start++) {
      if (
        !signature.every((token, offset) =>
          sameToken(inspected.tokens[start + offset], token, patterns),
        )
      )
        continue;
      const span = Array.from({ length: signature.length }, (_, offset) => start + offset);
      if (span.every((index) => positions.has(index))) continue;
      span.forEach((index) => positions.add(index));
      duplicates.push({
        flow: block.id,
        ...(block.ref ? { ref: block.ref } : {}),
        nodes: inspected.order.slice(start, start + signature.length),
      });
    }
  }
  const short =
    count <= POLICY.short.good
      ? 1
      : Math.max(
          0,
          1 - (count - POLICY.short.good) / Math.max(1, POLICY.short.max - POLICY.short.good),
        );
  const composed = catalog.available ? (count ? 1 - positions.size / count : 1) : null;
  const parameterized =
    values.templated + values.literals.length
      ? values.templated / (values.templated + values.literals.length)
      : 1;
  const criteria = input.criteria ?? null,
    declaredReview = new Set(
      (recipe.proofTargets ?? [])
        .filter((target) => target.proofMode === 'review')
        .map((target) => target.id),
    );
  const expected = criteria?.map((criterion) => criterion.id) ?? [];
  const reviewOnly =
    criteria
      ?.filter((criterion) => criterion.proofMode === 'review' || declaredReview.has(criterion.id))
      .map((criterion) => criterion.id) ?? [];
  const proved = new Set(
    inspected.reachable.flatMap((id) => [
      ...(Array.isArray(nodes[id].proves) ? nodes[id].proves : []),
      ...(nodes[id].action === 'call' && record(nodes[id].claimBindings)
        ? Object.values(nodes[id].claimBindings)
        : []),
    ]),
  );
  const covered = expected.filter((id) => proved.has(id) && !reviewOnly.includes(id));
  const missing = expected.filter((id) => !covered.includes(id));
  const unexpected = [...proved].filter(
    (id) => !expected.includes(id) && !(input.nonLocalCriteria ?? []).includes(id),
  );
  const hints = [];
  if (parameterized < POLICY.positive.parameterized)
    values.literals.forEach((field) =>
      hints.push({
        kind: 'parameterize',
        field,
        message: `Lift ${field} into typed paramsSchema/params and use a params template at that field.`,
      }),
    );
  duplicates.forEach((duplicate) =>
    hints.push({
      kind: 'compose',
      nodes: duplicate.nodes,
      flow: duplicate.flow,
      ...(duplicate.ref ? { ref: duplicate.ref } : {}),
      message: `Replace ${duplicate.nodes.join(', ')} with ${duplicate.ref ?? duplicate.flow}.`,
    }),
  );
  if (short < POLICY.positive.short)
    hints.push({
      kind: 'shorten',
      message: `${count} executable nodes exceed the shortness target; remove repeated setup or compose available blocks.`,
    });
  missing.forEach((id) =>
    hints.push({
      kind: 'acceptance',
      criterionId: id,
      message: reviewOnly.includes(id)
        ? `${id} requires review and cannot be recipe-proven; record this limitation, never add an invalid proves node.`
        : `Bind a reachable qualifying proving node to registered ${id}.`,
    }),
  );
  if (!expected.length)
    hints.push({
      kind: 'acceptance',
      message:
        'No registered worker AC set is available; this is not an AC-bearing task-proof candidate.',
    });
  if (!catalog.available)
    hints.push({
      kind: 'catalog',
      message:
        'Declared library catalog is unavailable; composition and imitation eligibility are unknown.',
    });
  const goodShape =
    count > 0 &&
    short >= POLICY.positive.short &&
    composed !== null &&
    composed >= POLICY.positive.composed &&
    parameterized >= POLICY.positive.parameterized;
  const acComplete =
    criteria !== null && expected.length > 0 && missing.length === 0 && unexpected.length === 0;
  return {
    policyVersion: POLICY_VERSION,
    inputIdentity: {
      recipe: stableDigest(recipe),
      criteria: stableDigest({ criteria, nonLocalCriteria: input.nonLocalCriteria ?? [] }),
      catalog: stableDigest({
        available: catalog.available,
        blocks: catalog.blocks ?? [],
        sources: catalog.sources ?? [],
      }),
    },
    nodes: count,
    calls: calls.length,
    templatedValues: values.templated,
    literalValues: values.literals.length,
    short: roundScore(short),
    composed: composed === null ? null : roundScore(composed),
    parameterized: roundScore(parameterized),
    inlineDuplicates: duplicates,
    goodShape,
    acCoverage: {
      nonLocal: input.nonLocalCriteria ?? [],
      available: criteria !== null,
      expected,
      covered,
      missing,
      reviewOnly,
      unexpected,
      complete: acComplete,
    },
    eligibleForImitation: goodShape && acComplete,
    catalogTrust: 'worker-supplied-self-consistent',
    status:
      !catalog.available || criteria === null
        ? 'unavailable'
        : goodShape && acComplete
          ? 'ok'
          : 'warn',
    hints,
  };
}
function recipeShapeLibraryRef(name, relativePath, platforms = [], adapter) {
  const portable = relativePath.replaceAll('\\', '/').replace(/^recipes\//, '');
  // Offline catalogs may include every platform; a bound worker supplies its active adapter.
  const inferred =
    adapter ??
    [...BUILT_IN_RECIPE_PLATFORMS, ...platforms].find(
      (platform) =>
        portable.startsWith(platform + '/') || portable.endsWith('.' + platform + '.recipe.json'),
    );
  const identity = recipeFileIdentity(portable, inferred, platforms);
  if (!identity || 'error' in identity) return null;
  return name ? `${name}.${identity.ref}` : identity.ref;
}

function recipeShapeBlock(ref, recipe) {
  const inspected = inspectRecipeShape(recipe);
  const generic = new Set(['call', 'switch', 'wait', 'end', 'command']);
  const changing = inspected.signature.filter(
    (token) => !isRecipeShapeObservation(token.split('|')[0]),
  );
  if (
    inspected.signature.length < 2 ||
    !changing.some((token) => token.includes('|') || !generic.has(token))
  )
    return null;
  return {
    id: `flow:${ref}:${stableDigest(recipe).slice(0, 12)}`,
    ref,
    tokens: inspected.tokens,
    sig: inspected.signature,
  };
}
function processShapeRequest(request) {
  if (request.operation === 'policy') return { policyVersion: POLICY_VERSION, policy: POLICY };
  if (request.operation === 'inspect') return inspectRecipeShape(request.recipe);
  if (request.operation === 'selector') return recipeShapeSelector(request.node);
  if (request.operation === 'token') return recipeShapeNodeToken(request.node);
  if (request.operation === 'signature') return recipeShapeSignature(request.tokens);
  if (request.operation === 'observation') return isRecipeShapeObservation(request.action);
  if (request.operation === 'block')
    return recipeShapeBlock(
      request.ref ?? recipeShapeLibraryRef(request.name, request.relativePath, request.platforms),
      request.recipe,
    );
  if (request.operation === 'digest') return stableDigest(request.value);
  if (request.operation === 'criteria') {
    return filterWorkerAcceptanceCriteria(
      registeredAcceptanceCriteria(request.criteria ?? [], request.registration),
      request.registration,
      request.flow,
    );
  }
  return scoreRecipeShape(request);
}
function isRecipeShapeFeedback(value) {
  if (
    !record(value) ||
    !Number.isSafeInteger(value.policyVersion) ||
    value.policyVersion < 1 ||
    !record(value.inputIdentity) ||
    !record(value.acCoverage)
  )
    return false;
  if (
    !['recipe', 'criteria', 'catalog'].every((key) =>
      /^[a-f0-9]{64}$/.test(value.inputIdentity[key]),
    )
  )
    return false;
  if (
    !['nodes', 'calls', 'templatedValues', 'literalValues'].every(
      (key) => Number.isInteger(value[key]) && value[key] >= 0,
    )
  )
    return false;
  if (
    !['short', 'parameterized'].every(
      (key) => typeof value[key] === 'number' && value[key] >= 0 && value[key] <= 1,
    )
  )
    return false;
  if (
    value.composed !== null &&
    !(typeof value.composed === 'number' && value.composed >= 0 && value.composed <= 1)
  )
    return false;
  if (
    !['ok', 'warn', 'unavailable'].includes(value.status) ||
    value.catalogTrust !== 'worker-supplied-self-consistent'
  )
    return false;
  if (
    typeof value.goodShape !== 'boolean' ||
    typeof value.eligibleForImitation !== 'boolean' ||
    !Array.isArray(value.inlineDuplicates) ||
    !Array.isArray(value.hints)
  )
    return false;
  if (
    !value.inlineDuplicates.every(
      (item) =>
        record(item) &&
        typeof item.flow === 'string' &&
        (item.ref === undefined || typeof item.ref === 'string') &&
        Array.isArray(item.nodes) &&
        item.nodes.every((node) => typeof node === 'string'),
    )
  )
    return false;
  if (
    !value.hints.every(
      (item) =>
        record(item) &&
        ['field', 'flow', 'ref', 'criterionId'].every(
          (key) => item[key] === undefined || typeof item[key] === 'string',
        ) &&
        (item.nodes === undefined ||
          (Array.isArray(item.nodes) && item.nodes.every((node) => typeof node === 'string'))),
    )
  )
    return false;
  return (
    typeof value.acCoverage.available === 'boolean' &&
    typeof value.acCoverage.complete === 'boolean' &&
    ['expected', 'covered', 'missing', 'reviewOnly', 'unexpected', 'nonLocal'].every(
      (key) =>
        Array.isArray(value.acCoverage[key]) &&
        value.acCoverage[key].every((id) => typeof id === 'string'),
    ) &&
    value.hints.every(
      (hint) =>
        record(hint) &&
        typeof hint.message === 'string' &&
        ['parameterize', 'compose', 'shorten', 'acceptance', 'catalog'].includes(hint.kind),
    )
  );
}
export {
  inspectRecipeShape,
  isRecipeShapeFeedback,
  isRecipeShapeObservation,
  POLICY_VERSION,
  processShapeRequest,
  POLICY as RECIPE_SHAPE_POLICY,
  recipeShapeBlock,
  recipeShapeLibraryRef,
  recipeShapeNodeToken,
  recipeShapeSelector,
  recipeShapeSignature,
  scoreRecipeShape,
  stableDigest,
};
