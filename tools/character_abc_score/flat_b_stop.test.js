'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {stoppedBKernel} = require('./flat_b_stop');

const GOLD = .008;
const MAIN_UP = GOLD / 2;
const LIMITED = GOLD * 9 / 14;
const MISS = 1 - GOLD;

function close(actual, expected, tolerance = 1e-10) {
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
    `${actual} does not match ${expected}`);
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function checkMass(result, expected = 1) {
  assert.ok(result.probabilities.every(value => Number.isFinite(value) && value >= 0));
  close(sum(result.probabilities), expected);
}

test('a fixed one-draw B window uses ordinary gold odds even at banner draw 120', () => {
  const one = stoppedBKernel('characterSix', {start: 119, target: 0, window: 1, output: 1});
  close(one.conditionedMass, GOLD);
  close(one.expectedOutput, GOLD);
  close(one.probabilities[0], 0);
  close(one.probabilities[1], 1);
  checkMass(one);

  const none = stoppedBKernel('characterSix', {start: 119, target: 0, window: 1, output: 0});
  close(none.conditionedMass, MISS);
  close(none.expectedOutput, GOLD);
  close(none.probabilities[0], 1);
  checkMass(none);
});

test('a two-draw fixed window ranks by the last actual gold, not the spent window', () => {
  const exactlyOne = stoppedBKernel('characterSix', {start: 30, target: 0, window: 2, output: 1});
  close(exactlyOne.conditionedMass, 2 * GOLD * MISS);
  close(exactlyOne.expectedOutput, 2 * GOLD);
  close(exactlyOne.probabilities[1], .5);
  close(exactlyOne.probabilities[2], .5);
  checkMass(exactlyOne);

  const oneLimited = stoppedBKernel('limited', {start: 30, target: 0, window: 2, output: 1});
  close(oneLimited.conditionedMass, 2 * LIMITED * (1 - LIMITED));
  close(oneLimited.expectedOutput, 2 * LIMITED);
  // The last gold was at draw 1 only if the first draw was limited and
  // the second was a true miss. A common second gold moves it to draw 2.
  const early = MISS / (2 * (1 - LIMITED));
  close(oneLimited.probabilities[1], early);
  close(oneLimited.probabilities[2], 1 - early);
  checkMass(oneLimited);
});

test('a token can finish a zero-limited path without adding gold or moving its last gold', () => {
  const none = stoppedBKernel('limited', {start: 239, target: 1, output: 0});
  close(none.conditionedMass, 1 - LIMITED);
  close(none.expectedOutput, LIMITED);
  close(none.probabilities[0], MISS / (1 - LIMITED));
  close(none.probabilities[1], GOLD * 5 / 14 / (1 - LIMITED));
  checkMass(none);

  const goldMiss = stoppedBKernel('characterSix', {start: 239, target: 1, output: 0});
  close(goldMiss.conditionedMass, MISS);
  close(goldMiss.probabilities[0], 1);
  checkMass(goldMiss);
});

test('moving the B start moves the next 240 milestone and simultaneous UP plus token counts twice', () => {
  const early = stoppedBKernel('up', {start: 238, target: 1});
  close(early.conditionedMass, 1);
  close(early.probabilities[1], MAIN_UP);
  close(early.probabilities[2], 1 - MAIN_UP);
  close(sum(early.probabilities.slice(3)), 0);
  checkMass(early);

  const later = stoppedBKernel('up', {start: 239, target: 1});
  close(later.probabilities[1], 1);
  close(later.expectedOutput, 1 + MAIN_UP);
  checkMass(later);

  const two = stoppedBKernel('up', {start: 239, target: 2});
  close(two.conditionedMass, 1);
  close(two.probabilities[1], MAIN_UP);
  close(two.probabilities[2], (1 - MAIN_UP) * MAIN_UP);
  close(sum(two.probabilities.slice(242)), 0);
  checkMass(two);

  const twoEarlier = stoppedBKernel('up', {start: 238, target: 2});
  close(twoEarlier.probabilities[1], 0);
  close(twoEarlier.probabilities[2], MAIN_UP + (1 - MAIN_UP) * MAIN_UP);
  checkMass(twoEarlier);
});

test('a zero-gold condition beyond ordinary hard pity has no probability mass', () => {
  const none = stoppedBKernel('characterSix', {start: 120, target: 1, output: 0});
  close(none.conditionedMass, 0);
  checkMass(none, 0);
});

test('conditional limited end times agree with the independent duo diagnostic', () => {
  // Golden values from the independent single-copy diagnostic that was used
  // to investigate the duo3/duo8 bias. The zero-output case is deliberate.
  const cases = [
    {start: 8, output: 0, at: 190, below: .3150722041418591, equal: .011371310399625316},
    {start: 65, output: 1, at: 100, below: .7305422631547437, equal: .002223957554269289},
    {start: 100, output: 2, at: 139, below: .9104824319792733, equal: .04438846364592279},
    {start: 120, output: 3, at: 120, below: .9692097263853124, equal: .030790273614687745},
  ];
  for (const {start, output, at, below, equal} of cases) {
    const result = stoppedBKernel('limited', {start, target: 1, output});
    assert.ok(result.conditionedMass > 0);
    close(sum(result.probabilities.slice(0, at)), below);
    close(result.probabilities[at], equal);
    close(sum(result.probabilities.slice(241 - start)), 0);
    checkMass(result);
  }
});
