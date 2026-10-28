// Manual node:test entrypoints need the same store isolation as node --test.
process.env.NODE_TEST_CONTEXT = '1';
