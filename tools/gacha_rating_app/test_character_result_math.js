'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('./character_result_math');
const close = (a, b, eps = 1e-10) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const prob = (d, x) => d.p[x - d.lo] || 0;
const mean = d => d.p.reduce((s, p, i) => s + p * (d.lo + i), 0);
const variance = d => { const mu = mean(d); return d.p.reduce((s, p, i) => s + p * (d.lo + i - mu) ** 2, 0); };

test('fixed credits are not rounded observations', () => {
  assert.equal(m.C6, 54); assert.equal(m.CUP, 108); assert.equal(m.CL, 84);
  close(m.CL * 9 / 14, m.C6);
  const d = m.sixCost(m.sixWait());
  close(mean(d), m.ORDINARY_SIX_MEAN);
  close(m.sumMass(d), 1);
  assert.ok(prob(d, 79) > 0);
});
test('equal completed-six total waits score equally', () => {
  const d = m.convolveMany([m.sixCost(m.sixWait()), m.sixCost(m.sixWait())]);
  assert.equal(m.midTail(d, 20 + 80), m.midTail(d, 50 + 50));
  close(variance(d), 2 * variance(m.sixCost(m.sixWait())), 1e-7);
});
test('no rush reduces exactly to completed waiting distribution', () => {
  const d = m.sixCost(m.sixWait());
  const fused = m.convolve(d, m.rushCountCost(0));
  for (const n of [1, 20, 50, 79, 80]) close(m.midTail(d, n), m.midTail(fused, n));
});
test('rush-only scores are binomial mid-ranks and batch partition independent', () => {
  const d = m.rushCountCost(20);
  const split = m.convolve(m.rushCountCost(10), m.rushCountCost(10));
  close(m.sumMass(d), 1);
  for (let k = 0; k <= 20; k++) {
    close(prob(d, -m.C6 * k), prob(split, -m.C6 * k));
    let rank = 0;
    for (let j = 0; j < k; j++) rank += prob(d, -m.C6 * j);
    rank += .5 * prob(d, -m.C6 * k);
    close(m.midTail(d, -m.C6 * k), rank);
  }
  close(mean(d), -m.C6 * 20 * .008);
  close(variance(d), m.C6 ** 2 * 20 * .008 * .992, 1e-8);
});
test('rush binomial remains stable away from tiny probabilities', () => {
  const d = m.rushCountCost(1100, .5, 1);
  close(m.sumMass(d), 1); close(mean(d), -550, 1e-8);
  close(m.midTail(d, -550), .5);
});
test('hard120 endpoint folds all survival mass into a real six-star', () => {
  const entries = m.sixWait(0, [{at: 0, deadline: 50}]);
  assert.equal(entries.length, 50);
  assert.equal(entries.at(-1).forced, true);
  close(entries.at(-1).p, .992 ** 49);
  close(m.sumMass(m.sixCost(entries)), 1);
  assert.equal(m.sixWait().at(-1).forced, false);
});
test('forced endpoint has certain limited weight, ordinary80 does not', () => {
  const forced = m.limitedCost([{wait: 50, p: 1, forced: true}], 2);
  close(prob(forced, 50 - m.CL), 1);
  close(prob(forced, 50 - 2 * m.CL), 0);
  const ordinary = m.limitedCost([{wait: 80, p: 1, forced: false}], 2);
  close(prob(ordinary, 80), 5 / 14);
  close(prob(ordinary, 80 - m.CL), 7 / 14);
  close(prob(ordinary, 80 - 2 * m.CL), 2 / 14);
});
test('identity-only unknown opening is supported without inventing a six wait', () => {
  const d = m.identityCost(1, false);
  close(prob(d, 0), 5 / 14);
  close(prob(d, -m.CL), 8 / 14);
  close(prob(d, -2 * m.CL), 1 / 14);
  assert.throws(() => m.sixCost([{wait: 0, p: 1, forced: false}]), /wait/);
});
test('cycle schedule changes apply after the boundary draw', () => {
  const switched = m.sixWait(0, [{at: 0, deadline: 50}, {at: 20, deadline: null}]);
  assert.equal(switched.length, 80);
  assert.equal(switched.some(e => e.forced), false);
  const switchAtDeadline = m.sixWait(0, [{at: 0, deadline: 50}, {at: 50, deadline: null}]);
  assert.equal(switchAtDeadline.length, 50);
  assert.equal(switchAtDeadline.at(-1).forced, true);
});
test('known initial pity conditions residual waiting correctly', () => {
  const d = m.sixWait(79);
  assert.deepEqual(d, [{wait: 1, p: 1, forced: false}]);
  assert.deepEqual(m.sixWait(79, [{at: 0, deadline: 1}]), [{wait: 1, p: 1, forced: true}]);
});
test('rush limited NEW bonus is spent only once per identity', () => {
  const d = m.rushLimitedCost(2, 1);
  close(m.sumMass(d), 1);
  // One missing identity cannot produce weighted total four in two draws.
  close(prob(d, -4 * m.CL), 0);
  const one = m.rushLimitedCost(1, 1);
  close(prob(one, -2 * m.CL), .008 / 14);
  const twoMissing = m.rushLimitedCost(2, 2);
  close(prob(twoMissing, -4 * m.CL), 2 * (.008 / 14) ** 2);
  const repeatedIndependentNew = m.convolve(one, one);
  assert.ok(prob(repeatedIndependentNew, -4 * m.CL) > 0);
});
test('rush limited without NEW equals binomial limited yield', () => {
  const d = m.rushLimitedCost(20, 0);
  const expected = m.rushCountCost(20, .008 * 9 / 14, m.CL);
  close(m.sumMass(d), 1);
  for (let k = 0; k <= 20; k++) close(prob(d, -m.CL * k), prob(expected, -m.CL * k));
});
test('first UP DP includes the120 atom and approved equal-result example', () => {
  const d = m.upWait(0, 120);
  close(m.sumMass(d), 1);
  close(mean(d), 81.37567692616713);
  close(prob(d, 120), .3409628607238892);
  const both = m.convolve(d, d);
  close(m.midTail(both, 20 + 120), .6693436477425931);
  close(m.midTail(both, 70 + 70), .6693436477425931);
  assert.equal(m.upWait(0, 120), d);
});
test('UP hard endpoint and ordinary small-pity boundary are distinct', () => {
  close(prob(m.upWait(79, 1), 1), 1);
  close(prob(m.upWait(79, null, 1), 1), .5);
});
test('failed UP episodes preserve endpoint-hit vs censor distinction', () => {
  const wait = m.upWait(0, null, 10);
  const d = m.upFailedCost(wait, 10);
  close(m.sumMass(d), 1);
  close(prob(d, 10 - m.CUP), prob(wait, 10));
  close(prob(d, 10), 1 - m.sumMass(wait));
  close(m.midTail(d, 10), .5 * (1 - m.sumMass(wait)));
  assert.deepEqual(m.upFailedCost(wait, 0), m.point());
});
test('missing high-tail probability is not renormalized', () => {
  const d = m.distribution(1, [.2, .3]);
  close(m.midTail(d, 1), .9);
  close(m.midTail(d, 2), .65);
  assert.throws(() => m.midTail(d, 3), /unresolved/);
  const shifted = m.convolve(d, m.point(-100));
  close(m.sumMass(shifted), .5);
  close(m.midTail(shifted, -98), .65);
});
test('convolution preserves a valid unknown-upper-tail boundary', () => {
  const a = m.distribution(1, [.2, .3]);
  const b = m.distribution(-10, [.5, .5]);
  const d = m.convolve(a, b);
  assert.equal(d.lo, -9);
  assert.equal(d.p.length, 2);
  close(prob(d, -9), .1);
  close(prob(d, -8), .25);
  close(m.midTail(d, -8), .775);
  assert.throws(() => m.midTail(d, -7), /unresolved/);
});
test('requested high cutoff and convolveMany negative credits stay safe', () => {
  const a = m.distribution(1, [.5, .5]);
  const d = m.convolveMany([a, m.point(-100)], {highCap: -99});
  assert.equal(d.lo, -99);
  close(m.sumMass(d), .5);
  close(m.midTail(d, -99), .75);
});
test('partial cutoffs account for all future negative support', () => {
  const a = m.distribution(0, [.2, .3, .5]);
  const b = m.distribution(-3, [.2, 0, 0, .8]);
  const c = m.distribution(-8, [.7, 0, 0, 0, 0, 0, 0, .3]);
  const full = m.convolveMany([a, a, b, a, c]);
  for (const cutoff of [-11, -9, -7, -4, 0]) {
    const truncated = m.convolveMany([a, a, b, a, c], {highCap: cutoff});
    close(m.midTail(truncated, cutoff), m.midTail(full, cutoff));
  }
  close(m.midTail(m.convolveMany([a, b], {highCap: -4}), -4), 1);
});
test('FFT dense convolution agrees with independent binomial law', () => {
  const a = m.rushCountCost(1250, .4, 1);
  const result = m.convolve(a, a);
  const expected = m.rushCountCost(2500, .4, 1);
  close(m.sumMass(result), 1);
  for (let k = 850; k <= 1150; k++) close(prob(result, -k), prob(expected, -k), 1e-11);
  for (const k of [900, 975, 1000, 1025, 1100]) close(m.midTail(result, -k), m.midTail(expected, -k), 1e-10);
});
test('FFT truncation retains unresolved upper mass', () => {
  const a = m.distribution(0, Array(1500).fill(.5 / 1500));
  const result = m.convolve(a, a);
  assert.equal(result.p.length, 1500);
  close(prob(result, 0), (.5 / 1500) ** 2, 1e-12);
  close(prob(result, 1499), 1500 * (.5 / 1500) ** 2, 1e-12);
  close(m.sumMass(result), 1500 * 1501 / 2 * (.5 / 1500) ** 2, 1e-10);
  assert.throws(() => m.midTail(result, 1500), /unresolved/);
});
test('bounded six-plus-pooled-rush reference has weighted mean mid-rank50', () => {
  const d = m.convolveMany([
    m.sixCost(m.sixWait()),
    m.sixCost(m.sixWait(0, [{at: 0, deadline: 50}])),
    m.rushCountCost(20),
  ]);
  close(m.sumMass(d), 1);
  let expectation = 0;
  for (let i = 0; i < d.p.length; i++) if (d.p[i]) expectation += d.p[i] * m.midTail(d, d.lo + i);
  close(100 * expectation, 50, 1e-8);
});
test('joint limited-plus-rush reference has weighted mean mid-rank50', () => {
  const d = m.convolveMany([
    m.limitedCost(m.sixWait(), 2),
    m.limitedCost(m.sixWait(0, [{at: 0, deadline: 50}]), 1),
    m.rushLimitedCost(10, 2),
  ]);
  close(m.sumMass(d), 1);
  let expectation = 0;
  for (let i = 0; i < d.p.length; i++) if (d.p[i]) expectation += d.p[i] * m.midTail(d, d.lo + i);
  close(100 * expectation, 50, 1e-8);
});
test('UP completed-plus-bounded-failure reference has weighted mean mid-rank50', () => {
  const d = m.convolveMany([
    m.upCompletedCost(m.upWait(0, 120)),
    m.upFailedCost(m.upWait(0, 120), 30),
    m.rushCountCost(10, .004, m.CUP),
  ]);
  close(m.sumMass(d), 1);
  let expectation = 0;
  for (let i = 0; i < d.p.length; i++) if (d.p[i]) expectation += d.p[i] * m.midTail(d, d.lo + i);
  close(100 * expectation, 50, 1e-8);
  // This validates the frozen reference's rank arithmetic, not strategy-wide
  // calibration when actual policies/caps/ownership differ from that reference.
});
test('invalid support and excess work fail rather than hanging', () => {
  assert.throws(() => m.sixWait(80), /initialPity/);
  assert.throws(() => m.sixWait(0, [{at: 1, deadline: 10}]), /start/);
  assert.throws(() => m.sixWait(0, [{at: 0, deadline: 0}]), /deadline/);
  assert.throws(() => m.upWait(0, null, 50001), /maxWait/);
  assert.throws(() => m.rushCountCost(10000), /support/);
  assert.throws(() => m.limitedCost(m.sixWait(), 3), /missing/);
  assert.throws(() => m.upFailedCost(m.upWait(0, null, 3), 4), /resolved/);
  assert.throws(() => m.distribution(0, [1.1]), /mass/);
});
