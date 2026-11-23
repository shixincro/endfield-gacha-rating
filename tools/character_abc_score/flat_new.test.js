'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {COMMON, LIMITED} = require('../gacha_rating_app/character_ledger');
const {prepare} = require('./ledger');
const {scoreFlatNew} = require('./flat_new');

const [MAIN, OFF_A, OFF_B] = LIMITED;
const [STANDARD] = COMMON;

function pool(index, total, events, extras = {}) {
  return {
    index, total, rushUsed: false, rush: [], tokens: [],
    events: events.map(([at, character, forced]) => ({at, character, forced, source: 'main'})),
    ...extras,
  };
}

function record(pools, extras = {}) {
  return {initialPity: 0, initialOwned: [], completeHistory: true, pools, ...extras};
}

function score(input) {
  return scoreFlatNew(prepare(input));
}

function close(actual, expected, tolerance = 1e-11) {
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
    `${actual} does not match ${expected}`);
}

function distribution(result, masses, observed) {
  assert.equal(result.status, 'scored');
  assert.equal(result.observed, observed);
  assert.equal(result.probabilities.length, masses.length);
  result.probabilities.forEach((probability, count) => close(probability, masses[count]));
  const below = masses.slice(0, observed).reduce((sum, probability) => sum + probability, 0);
  const equal = masses[observed];
  close(result.below, below);
  close(result.equal, equal);
  close(result.above, 1 - below - equal);
  close(result.expected, masses.reduce((sum, probability, count) => sum + count * probability, 0));
  close(result.score, 100 * (below + .5 * equal));
}

test('two off-UP golds are nine identity paths, with repeats counting once', () => {
  // The 3x3 possible identity pairings have integer masses based on weights
  // common=5, off-A=1, off-B=1. Only (A,B) and (B,A) get two New.
  const masses = [25/49, 22/49, 2/49];
  distribution(score(record([pool(0, 2, [[1, OFF_A], [2, OFF_A]])])), masses, 1);
  distribution(score(record([pool(0, 2, [[1, OFF_A], [2, OFF_B]])])), masses, 2);
  distribution(score(record([pool(0, 2, [[1, STANDARD], [2, STANDARD]])])), masses, 0);
});

test('main and rush at the same progress share one set of acquired roles', () => {
  const atTie = (main, rush) => pool(0, 30, [[30, main]], {
    rushUsed: true, rushAt: 30, rush: [{at: 1, character: rush, source: 'rush'}],
  });
  distribution(score(record([atTie(OFF_A, OFF_A)])), [25/49, 22/49, 2/49], 1);
  const mainThenRush = score(record([atTie(OFF_A, OFF_B)]));
  const swapped = score(record([atTie(OFF_B, OFF_A)]));
  distribution(mainThenRush, [25/49, 22/49, 2/49], 2);
  assert.deepEqual(swapped, mainThenRush);
});

test('a locked main UP and the final-progress rush both affect the next pool catalog', () => {
  const first = pool(0, 30, [[30, MAIN]], {
    rushUsed: true, rushAt: 30, rush: [{at: 1, character: OFF_B, source: 'rush'}],
  });
  const second = pool(1, 1, [[1, OFF_B]]);
  // Pool 1 can miss with weight 5/7, then miss new OFF_B with weight 6/7
  // since MAIN was acquired as a fixed UP. Only OFF_A then OFF_B yields two.
  const result = score(record([first, second]));
  distribution(result, [30/49, 18/49, 1/49], 1);
});

test('only non-UP golds can be New opportunities; 120 UPs and 240 tokens do not count', () => {
  const forced = score(record([pool(0, 120, [[60, STANDARD], [120, MAIN, true]], {
    rushUsed: true, rushAt: 30, rush: [{at: 1, character: MAIN, source: 'rush'}],
  })]));
  distribution(forced, [5/7, 2/7], 0);

  const main = [[30, MAIN], [110, STANDARD], [190, STANDARD], [240, STANDARD]];
  const withoutToken = score(record([pool(0, 240, main)]));
  const withToken = score(record([pool(0, 240, main, {tokens: [{at: 240, character: MAIN}]})]));
  assert.deepEqual(withToken, withoutToken);
});

test('a full catalog or a record with only locked UPs gives no scoring effect', () => {
  const completeCatalog = score(record([pool(0, 2, [[1, OFF_A], [2, OFF_B]])], {
    initialOwned: [...LIMITED],
  }));
  const onlyUP = score(record([pool(0, 2, [[1, MAIN], [2, MAIN]])]));
  for (const result of [completeCatalog, onlyUP]) {
    assert.equal(result.score, null);
    assert.equal(result.expected, 0);
    assert.equal(result.observed, 0);
    assert.deepEqual(result.probabilities, [1]);
    assert.ok(result.reason);
  }
});

test('unknown opening catalog and discontinuous history withhold New scoring', () => {
  const known = pool(0, 1, [[1, OFF_A]]);
  const unknown = score(record([known], {initialOwned: null}));
  const gap = score(record([known, pool(2, 1, [[1, OFF_A]], {initialPity: 0, freeAllowance: 10})], {
    completeHistory: false,
  }));
  const forcedGap = score(record([known, pool(1, 1, [[1, OFF_B]], {
    interruptionBefore: true, initialPity: 0, freeAllowance: 10,
  })]));
  for (const result of [unknown, gap, forcedGap]) {
    assert.equal(result.score, null);
    assert.equal(result.expected, null);
    assert.ok(result.reason);
  }
});

test('many missed New chances stay below 50, even with one late New', () => {
  const misses = Array.from({length: 9}, (_, index) => [index + 1, STANDARD]);
  const never = score(record([pool(0, 9, misses)]));
  const once = score(record([pool(0, 9, [...misses.slice(0, -1), [9, OFF_A]])]));
  const twice = score(record([pool(0, 9, [...misses.slice(0, -2), [8, OFF_A], [9, OFF_B]])]));
  const p0 = (5/7)**9;
  const p1 = 2*((6/7)**9 - p0);
  const masses = [p0, p1, 1 - p0 - p1];
  distribution(never, masses, 0);
  distribution(once, masses, 1);
  distribution(twice, masses, 2);
  assert.ok(never.score < once.score && once.score < 50 && twice.score > 50);
});
