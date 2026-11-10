'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {p6, drawMainRarity, drawRushRarity, simulateReference} = require('./simulate_reference');

// All paths below are scripted, not PRNG/MC samples. Exhaustion and unused values
// make a wrong stop point observable rather than quietly changing the test path.
function sequence(values) {
  let index = 0;
  const random = () => {
    assert.ok(index < values.length, 'unexpected random request after scripted path');
    return values[index++];
  };
  random.done = () => assert.equal(index, values.length, 'scripted path was not fully consumed');
  return random;
}

function script(plans, {initialFivePity = 0} = {}) {
  const values = [];
  let five = initialFivePity;
  for (const plan of plans) {
    for (let n = 1; n <= plan.N; n++) {
      const six = (plan.sixes || {})[n];
      if (six === 'forced') {
        five = 0; // The forced slot consumes neither rarity nor identity randomness.
      } else if (six !== undefined) {
        values.push(0); // six-star rarity
        if (six === 'up') values.push(0);
        else if (six === 'future') values.push(.9, .01);
        else values.push(.9, .9); // one of five ordinary off-banner characters
        five = 0;
      } else {
        values.push(.999);
        if (five === 9) five = 0;
        else {values.push(.999); five++;}
      }
      if (n === 30) {
        for (let j = 1; j <= 10; j++) {
          const rush = (plan.rush || {})[j];
          if (rush === 'up') values.push(0, 0);
          else if (rush === 'future') values.push(0, .9, .01);
          else if (rush === 'off') values.push(0, .9, .9);
          else values.push(.999);
        }
      }
    }
  }
  return sequence(values);
}

function run(plans, options = {}) {
  const random = script(plans, options);
  const record = simulateReference(random, {...options, poolCount: plans.length, keepTrace: true});
  random.done();
  return record;
}

test('six-star curve uses failure count: 65 ordinary, then soft pity, 80 hard', () => {
  assert.equal(p6(0), .008);
  assert.equal(p6(64), .008);
  assert.equal(p6(65), .058);
  assert.ok(Math.abs(p6(78) - .708) < 1e-12);
  assert.equal(p6(79), 1);
});

test('ordinary and soft-pity five-star probability stays marginal 8%', () => {
  for (const probability of [.008, .058, .508, .708]) {
    const threshold = .08 / (1 - probability);
    assert.equal(drawMainRarity(probability, 0, false, sequence([.999, threshold - 1e-12])), 5);
    assert.equal(drawMainRarity(probability, 0, false, sequence([.999, threshold + 1e-12])), 4);
    assert.ok(Math.abs((1 - probability) * threshold - .08) < 1e-14);
  }
});

test('six-star and forced120 override five-star guarantee without extra random consumption', () => {
  const natural = sequence([0]);
  assert.equal(drawMainRarity(.008, 9, false, natural), 6);
  natural.done();
  const forced = sequence([]);
  assert.equal(drawMainRarity(.008, 9, true, forced), 6);
  forced.done();
  assert.equal(drawMainRarity(.008, 9, false, sequence([.99])), 5);
});

test('rush guarantee upgrades four-star only and does not overwrite a last-slot six', () => {
  assert.equal(drawRushRarity(false, true, sequence([.001])), 6);
  assert.equal(drawRushRarity(false, true, sequence([.999])), 5);
  assert.equal(drawRushRarity(true, true, sequence([.999])), 4);
  assert.equal(drawRushRarity(false, false, sequence([.0879])), 5);
  assert.equal(drawRushRarity(false, false, sequence([.0881])), 4);
});

test('an already-owned UP uses 10 free pulls, never buys up to30', () => {
  const r = run([{N: 10}], {initialOwned: [0]});
  assert.deepEqual([r.N, r.R, r.F, r.K6], [10, 0, 1, 0]);
  assert.equal(r.pools[0].preowned, true);
});

test('an already-owned UP with prior60 reward uses20 and ignores repeatedUP', () => {
  const r = run([{N: 20, sixes: {1: 'up', 17: 'up'}}], {initialOwned: [0], initialFreeBonus: true});
  assert.equal(r.N, 20);
  assert.equal(r.R, 0);
  assert.equal(r.pools[0].firstTargetAt, null);
});

test('early first UP still spends all10 or20 free pulls', () => {
  assert.equal(run([{N: 10, sixes: {1: 'up'}}]).N, 10);
  assert.equal(run([{N: 20, sixes: {1: 'up'}}], {initialFreeBonus: true}).N, 20);
});

for (const [hit, stop] of [[45, 45], [46, 60], [59, 60], [60, 60], [61, 61]]) {
  test(`first UP at${hit} stops at${stop}; 46-59 is inclusive`, () => {
    const r = run([{N: stop, sixes: {[hit]: 'up'}}]);
    assert.equal(r.N, stop);
    assert.equal(r.pools[0].firstTargetAt, hit);
    assert.equal(r.R, 1);
  });
}

test('first UP at30 still completes rush and repeats do not extend its target', () => {
  const r = run([{N: 30, sixes: {30: 'up'}, rush: {1: 'up', 10: 'up'}}]);
  assert.equal(r.N, 30);
  assert.equal(r.K6, 3);
  assert.equal(r.pools[0].trace.filter(e => e.kind === 'rush').length, 10);
});

test('rush UP at30 stops main at30; main pity and120 flag remain untouched', () => {
  const r = run([{N: 30, rush: {1: 'up', 10: 'up'}}]);
  assert.equal(r.N, 30);
  assert.equal(r.endPity, 30);
  assert.equal(r.endFivePity, 0);
  assert.equal(r.pools[0].seenMainUp, false);
  assert.equal(r.pools[0].firstTargetSource, 'rush');
  assert.ok(r.pools[0].trace.filter(e => e.kind === 'rush').every(e => e.beforeSix === e.afterSix && e.beforeFive === e.afterFive));
});

test('a repeat UP while completing60 does not move the first-copy stop', () => {
  const r = run([{N: 60, sixes: {46: 'up', 58: 'up'}}]);
  assert.equal(r.pools[0].firstTargetAt, 46);
  assert.equal(r.N, 60);
});

test('actual60 grants20 free draws next pool; future off-UP is recognized preowned', () => {
  const r = run([{N: 60, sixes: {1: 'future', 46: 'up'}}, {N: 20}]);
  assert.deepEqual(r.pools.map(p => [p.N, p.freeDraws, p.preowned]), [[60, 10, false], [20, 20, true]]);
  assert.equal(r.R, 1);
});

test('a future off-UP with no60 grants only10, not30, on its later banner', () => {
  const r = run([{N: 10, sixes: {1: 'future', 2: 'up'}}, {N: 10}]);
  assert.deepEqual(r.pools.map(p => p.N), [10, 10]);
  assert.equal(r.pools[1].preowned, true);
  assert.equal(r.R, 0);
});

test('both main pity counters carry across pools and a main six resets both', () => {
  const r = run([{N: 10, sixes: {3: 'up'}}, {N: 10, sixes: {4: 'up'}}]);
  assert.deepEqual([r.pools[0].endPity, r.pools[0].endFivePity], [7, 7]);
  assert.deepEqual([r.pools[1].startPity, r.pools[1].startFivePity], [7, 7]);
  const secondMain = r.pools[1].trace.filter(e => e.kind === 'main');
  assert.equal(secondMain[2].rarity, 5);
  assert.equal(secondMain[3].afterSix, 0);
  assert.equal(secondMain[3].afterFive, 0);
});

test('initial inherited79 pity immediately reaches a natural six and free tail continues', () => {
  const r = run([{N: 10, sixes: {1: 'up'}}], {initialSixPity: 79, initialFivePity: 9});
  assert.equal(r.pools[0].trace[0].beforeSix, 79);
  assert.equal(r.pools[0].trace[0].afterFive, 0);
  assert.equal(r.N, 10);
});

test('no mainUP forces120 even after a119 off-six, with no artificial cap', () => {
  const r = run([{N: 120, sixes: {80: 'off', 119: 'off', 120: 'forced'}}]);
  assert.equal(r.N, 120);
  assert.equal(r.forced120, 1);
  assert.equal(r.K6, 3);
  assert.equal(r.endPity, 0);
  assert.equal(r.endFivePity, 0);
  assert.equal(r.pools[0].firstTargetAt, 120);
});

test('record totals equal pool ledgers and ordinary/rush event counts reconcile', () => {
  const r = run([{N: 60, sixes: {46: 'up'}}, {N: 30, rush: {10: 'up'}}]);
  for (const field of ['N', 'R', 'F', 'K6', 'forced120']) {
    assert.equal(r[field], r.pools.reduce((sum, p) => sum + p[field], 0));
  }
  const events = r.pools.flatMap(p => p.trace);
  assert.equal(events.length, r.N + 10 * r.R);
  assert.equal(events.filter(e => e.rarity === 5).length, r.F);
  assert.equal(events.filter(e => e.rarity === 6).length, r.K6);
});

test('invalid initial-state options fail before any draw', () => {
  for (const options of [{poolCount: 0}, {poolCount: 12}, {initialSixPity: 80}, {initialFivePity: 10}, {initialOwned: [-1]}, {initialFreeBonus: 1}]) {
    assert.throws(() => simulateReference(() => {throw new Error('must not draw');}, options), /must be|must contain/);
  }
});
