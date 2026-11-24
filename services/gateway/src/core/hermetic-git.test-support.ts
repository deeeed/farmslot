// Import first, for its side effect: git in this test file, both its fixtures and the code under
// test, reads no global or system config, as on a CI runner. A developer machine whose global
// config signs commits (commit.gpgsign) otherwise makes slot prepare refuse the fixture slot
// ("Commit signing is not ready") before it reaches the step under test.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
