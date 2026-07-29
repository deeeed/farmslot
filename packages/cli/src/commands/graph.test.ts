import assert from 'node:assert/strict';
import test from 'node:test';

import { Command } from 'commander';

import { GRAPH_VERB_METHODS, GRAPH_VERBS, type GraphVerb, registerGraphCommand } from './graph.js';

function registeredGraphVerbs(): Set<string> {
  const program = new Command();
  program.exitOverride();
  registerGraphCommand(program);
  const graph = program.commands.find((cmd) => cmd.name() === 'graph');
  assert.ok(graph, 'graph command must register');
  return new Set(graph.commands.map((cmd) => cmd.name()));
}

test('every GRAPH_VERB registers as a commander subcommand', () => {
  const names = registeredGraphVerbs();
  for (const verb of GRAPH_VERBS) {
    assert.ok(names.has(verb), `missing graph subcommand: ${verb}`);
  }
});

test('GRAPH_VERB_METHODS maps each verb to a workGraph.* handler method', () => {
  for (const verb of GRAPH_VERBS) {
    const method = GRAPH_VERB_METHODS[verb as GraphVerb];
    assert.match(method, /^workGraph\./, `${verb} must map to workGraph.*`);
  }
  assert.equal(GRAPH_VERB_METHODS.list, 'workGraph.list');
  assert.equal(GRAPH_VERB_METHODS.show, 'workGraph.get');
  assert.equal(GRAPH_VERB_METHODS.create, 'workGraph.create');
  assert.equal(GRAPH_VERB_METHODS['add-node'], 'workGraph.addNode');
  assert.equal(GRAPH_VERB_METHODS['add-edge'], 'workGraph.addEdge');
  assert.equal(GRAPH_VERB_METHODS['remove-node'], 'workGraph.removeNode');
  assert.equal(GRAPH_VERB_METHODS['remove-edge'], 'workGraph.removeEdge');
  assert.equal(GRAPH_VERB_METHODS.activate, 'workGraph.activate');
  assert.equal(GRAPH_VERB_METHODS.pause, 'workGraph.pause');
  assert.equal(GRAPH_VERB_METHODS.tick, 'workGraph.schedulerTick');
  assert.equal(GRAPH_VERB_METHODS['gate-resolve'], 'workGraph.gateResolve');
});

test('graph command help lists the full verb family', async () => {
  const program = new Command();
  program.exitOverride();
  registerGraphCommand(program);
  const graph = program.commands.find((cmd) => cmd.name() === 'graph');
  assert.ok(graph);
  let help = '';
  graph.configureOutput({
    writeOut: (str) => {
      help += str;
    },
    writeErr: (str) => {
      help += str;
    },
  });
  try {
    await graph.parseAsync(['--help'], { from: 'user' });
  } catch {
    // commander exitOverride throws on help
  }
  for (const verb of GRAPH_VERBS) {
    assert.match(help, new RegExp(verb.replace('-', '\\-')), `help missing ${verb}`);
  }
});
