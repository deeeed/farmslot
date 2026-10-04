'use strict';

// Partial-match assertions standing in for vitest's toMatchObject and
// expect.stringContaining, kept local so the suite runs on any supported Node.

const assert = require('node:assert/strict');

const CONTAINS = Symbol('contains');

function contains(text) {
  return { [CONTAINS]: text };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertMatch(actual, expected, label = 'value') {
  if (isPlainObject(expected) && CONTAINS in expected) {
    assert.equal(typeof actual, 'string', `${label} should be a string`);
    assert.ok(
      actual.includes(expected[CONTAINS]),
      `${label} should contain ${JSON.stringify(expected[CONTAINS])}, got ${JSON.stringify(actual)}`,
    );
  } else if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `${label} should be an array`);
    assert.equal(actual.length, expected.length, `${label} length`);
    expected.forEach((item, index) => assertMatch(actual[index], item, `${label}[${index}]`));
  } else if (isPlainObject(expected)) {
    assert.ok(actual !== null && typeof actual === 'object', `${label} should be an object`);
    for (const [key, value] of Object.entries(expected)) {
      assertMatch(actual[key], value, `${label}.${key}`);
    }
  } else {
    assert.deepStrictEqual(actual, expected, label);
  }
}

// Validator for assert.rejects/assert.throws: the error message contains `text`.
function messageContains(text) {
  return (error) => {
    assert.ok(
      String(error && error.message).includes(text),
      `expected error message to contain ${JSON.stringify(text)}, got ${JSON.stringify(error && error.message)}`,
    );
    return true;
  };
}

// Validator for assert.rejects: the error partially matches `expected`.
function errorMatches(expected) {
  return (error) => {
    assertMatch(error, expected, 'error');
    return true;
  };
}

module.exports = { assertMatch, contains, errorMatches, messageContains };
