'use strict';

const {probabilities: {P}} = require('../gacha_rating_app/character_ledger');

const WATER = 80;
const TOKEN_STEP = 240;
const MAX_DRAWS = 30000;
const MAX_WORK = 100000000;
const CACHE_BYTES = 24 * 1024 * 1024;
const MOMENT_CACHE_ENTRIES = 768;
const MASS_TOLERANCE = 1e-8;
const AXES = ['characterSix', 'limited', 'up'];
const momentsCache = new Map();
const distributionCache = new Map();
let distributionBytes = 0;

class FlatBStopLimit extends RangeError {
  constructor(message) {
    super(message);
    this.name = 'FlatBStopLimit';
  }
}

function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function normalize(axis, input) {
  const {start, target, window, output} = input ?? {};
  if (!AXES.includes(axis) || !isCount(start) || !isCount(target) ||
      (!target && !isCount(window)) || (axis !== 'up' && !isCount(output))) {
    throw new RangeError('B区同停手参照的指标或参数不合法');
  }
  const offset = start % TOKEN_STEP;
  const horizon = target ? TOKEN_STEP * target - offset : window;
  if (horizon > MAX_DRAWS) throw new FlatBStopLimit('B区同停手参照主抽数超过30000');
  const key = target ? `target/${offset}/${target}` : `fixed/${offset}/${window}`;
  return {offset, target, horizon, output, key};
}

function checkWork(work) {
  if (work > MAX_WORK) throw new FlatBStopLimit('B区同停手参照达到计算量上限');
}

// Unconditional outputs under the policy, before conditioning on the observed
// number of golds or limited characters. This also supplies the UP stop PMF.
function moments({offset, target, horizon, key}) {
  const cached = momentsCache.get(key);
  if (cached) return cached;
  let progressLimit = Math.max(1, target);
  checkWork(horizon * progressLimit * WATER);
  let live = new Float64Array(progressLimit * WATER);
  let next = new Float64Array(live.length);
  live[0] = 1;
  const stop = new Float64Array(horizon + 1);
  let expectedSix = 0;
  let expectedUp = 0;
  for (let draw = 1; draw <= horizon; draw++) {
    const token = (offset + draw) % TOKEN_STEP === 0;
    const nextLimit = target && token ? progressLimit - 1 : progressLimit;
    next.fill(0);
    for (let progress = 0; progress < progressLimit; progress++) {
      const base = progress * WATER;
      const tokenCompletes = progress >= nextLimit;
      let gold = 0;
      let total = 0;
      for (let pity = 0; pity < WATER; pity++) {
        const mass = live[base + pity];
        if (!mass) continue;
        const hit = mass * P[pity + 1];
        gold += hit;
        total += mass;
        if (!tokenCompletes && pity + 1 < WATER) {
          next[base + pity + 1] = mass - hit;
        }
      }
      expectedSix += gold;
      expectedUp += 0.5 * gold + (token ? total : 0);
      if (!target) next[base] = gold;
      else if (tokenCompletes) stop[draw] += total;
      else {
        next[base] += 0.5 * gold;
        if (progress + 1 === nextLimit) stop[draw] += 0.5 * gold;
        else next[base + WATER] += 0.5 * gold;
      }
    }
    [live, next] = [next, live];
    progressLimit = nextLimit;
  }
  if (!target) stop[horizon] = 1;
  const mass = stop.reduce((sum, value) => sum + value, 0);
  if (Math.abs(mass - 1) > MASS_TOLERANCE) {
    throw new Error('B区同停手参照概率质量不守恒');
  }
  const result = {stop, expectedSix, expectedUp};
  if (momentsCache.size >= MOMENT_CACHE_ENTRIES) {
    momentsCache.delete(momentsCache.keys().next().value);
  }
  momentsCache.set(key, result);
  return result;
}

function rememberDistribution(key, series, cap, horizon) {
  const bytes = (cap + 1) * (horizon + 1) * Float64Array.BYTES_PER_ELEMENT;
  if (bytes > CACHE_BYTES) return;
  while (distributionBytes + bytes > CACHE_BYTES) {
    const first = distributionCache.keys().next().value;
    distributionBytes -= distributionCache.get(first).bytes;
    distributionCache.delete(first);
  }
  distributionCache.set(key, {series, cap, bytes});
  distributionBytes += bytes;
}

// Track only paths with output <= cap. Counts are monotone, so discarded
// paths cannot contribute to any of the cached conditional distributions.
function outputDistributions(axis, {offset, target, horizon, key}, output) {
  const cacheKey = `${axis}/${key}`;
  const cached = distributionCache.get(cacheKey);
  if (cached) {
    distributionCache.delete(cacheKey);
    distributionBytes -= cached.bytes;
    if (cached.cap >= output) {
      rememberDistribution(cacheKey, cached.series, cached.cap, horizon);
      return cached.series;
    }
  }
  let progressLimit = Math.max(1, target);
  let cap = Math.min(horizon, Math.max(output, target ? 6 + 3 * target : 5));
  if (horizon * progressLimit * (cap + 1) * WATER > MAX_WORK) cap = output;
  const stride = (cap + 1) * WATER;
  checkWork(horizon * progressLimit * stride);
  let live = new Float64Array(progressLimit * stride);
  let next = new Float64Array(live.length);
  live[0] = 1;
  const exits = Array.from({length: cap + 1}, () => new Float64Array(horizon + 1));
  const six = axis === 'characterSix';
  const givenSix = six ? 1 : 9 / 14;
  const offLimited = six ? 0.5 : 2 / 14;
  if (!horizon) exits[0][0] = 1;
  for (let draw = 1; draw <= horizon; draw++) {
    const token = target && (offset + draw) % TOKEN_STEP === 0;
    const nextLimit = token ? progressLimit - 1 : progressLimit;
    const fixedEnd = !target && draw === horizon;
    next.fill(0);
    for (let progress = 0; progress < progressLimit; progress++) {
      const stopsWithoutUp = fixedEnd || progress >= nextLimit;
      const stopsWithUp = stopsWithoutUp || progress + 1 >= nextLimit;
      const progressBase = progress * stride;
      const lastPossibleOutput = Math.min(cap, draw - 1);
      for (let count = progress; count <= lastPossibleOutput; count++) {
        const base = progressBase + count * WATER;
        const byEnd = exits[count];
        let gold = 0;
        if (stopsWithoutUp) {
          for (let pity = 0; pity < WATER; pity++) {
            const mass = live[base + pity];
            if (!mass) continue;
            const hit = mass * P[pity + 1];
            gold += hit;
            // A terminal miss leaves the endpoint at the previous gold.
            byEnd[draw - 1 - pity] += mass - hit;
          }
        } else {
          for (let pity = 0; pity < WATER; pity++) {
            const mass = live[base + pity];
            if (!mass) continue;
            const hit = mass * P[pity + 1];
            gold += hit;
            if (pity + 1 < WATER) next[base + pity + 1] = mass - hit;
          }
        }
        if (!gold) continue;
        if (!target) {
          if (fixedEnd) {
            byEnd[draw] += gold * (1 - givenSix);
            if (count < cap) exits[count + 1][draw] += gold * givenSix;
          } else {
            next[base] += gold * (1 - givenSix);
            if (count < cap) next[base + WATER] += gold * givenSix;
          }
          continue;
        }
        if (stopsWithoutUp) byEnd[draw] += gold * (0.5 - offLimited);
        else next[base] += gold * (0.5 - offLimited);
        if (count === cap) continue;
        if (stopsWithoutUp) exits[count + 1][draw] += gold * offLimited;
        else next[base + WATER] += gold * offLimited;
        if (stopsWithUp) exits[count + 1][draw] += 0.5 * gold;
        else next[base + stride + WATER] += 0.5 * gold;
      }
    }
    [live, next] = [next, live];
    progressLimit = nextLimit;
  }
  rememberDistribution(cacheKey, exits, cap, horizon);
  return exits;
}

function stoppedBKernel(axis, input) {
  const plan = normalize(axis, input);
  const {stop, expectedSix, expectedUp} = moments(plan);
  if (axis === 'up') {
    return {probabilities: stop.slice(), expectedOutput: expectedUp, conditionedMass: 1};
  }
  const expectedOutput = axis === 'characterSix' ? expectedSix : expectedSix * 9 / 14;
  const joint = plan.output <= plan.horizon
    ? outputDistributions(axis, plan, plan.output)[plan.output]
    : new Float64Array(plan.horizon + 1);
  const conditionedMass = joint.reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(conditionedMass) || conditionedMass < 0 ||
      conditionedMass > 1 + MASS_TOLERANCE) {
    throw new Error('B区同停手参照的条件概率质量不合法');
  }
  const probabilities = joint.slice();
  if (conditionedMass) {
    for (let draw = 0; draw < probabilities.length; draw++) {
      probabilities[draw] /= conditionedMass;
    }
  }
  return {probabilities, expectedOutput, conditionedMass};
}

module.exports = {stoppedBKernel, FlatBStopLimit};
