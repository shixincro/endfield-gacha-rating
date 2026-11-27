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
const offMomentsCache = new Map();
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
function outputDistributions(axis, {offset, target, horizon, key, unlimitedOff}, output) {
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
  const givenSix = six ? 1 : unlimitedOff === undefined ? 9 / 14 : 0.5 + unlimitedOff;
  const offLimited = six ? 0.5 : unlimitedOff ?? 2 / 14;
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

function normalizeCapacity(raw, horizon) {
  if (raw == null) return null;
  const {remaining, grantAt, grants} = raw;
  if (!Array.isArray(remaining) || remaining.length !== 2 ||
      !remaining.every(value => isCount(value) && value <= 6) ||
      !Array.isArray(grants) || grants.length !== 2 || !grants.every(isCount) ||
      (grantAt != null && !isCount(grantAt))) {
    throw new RangeError('B区限定潜能参照不合法');
  }
  const usable = grants.map((grant, i) => Math.min(grant, remaining[i]));
  if (grantAt == null || grantAt >= horizon || !usable.some(Boolean)) {
    return {remaining, grantAt: null, grants: [0, 0]};
  }
  if (grantAt === 0) {
    return {remaining: remaining.map((value, i) => value - usable[i]), grantAt: null, grants: [0, 0]};
  }
  return {remaining, grantAt, grants: usable};
}

// The other old limited identity and the five common identities are equivalent
// when computing the unconditional credited output of a single off-banner card.
function expectedOff({offset, target, horizon, key}, remaining, grantAt, grant) {
  if (!remaining) return 0;
  const cacheKey = [key, remaining, grant ? grantAt : null, grant].join('/');
  const cached = offMomentsCache.get(cacheKey);
  if (cached !== undefined) return cached;
  let progressLimit = Math.max(1, target);
  const stride = (remaining + 1) * WATER;
  checkWork(horizon * progressLimit * stride);
  let live = new Float64Array(progressLimit * stride);
  let next = new Float64Array(live.length);
  live[remaining * WATER] = 1;
  let expected = 0;
  for (let draw = 1; draw <= horizon; draw++) {
    const token = target && (offset + draw) % TOKEN_STEP === 0;
    const nextLimit = token ? progressLimit - 1 : progressLimit;
    const fixedEnd = !target && draw === horizon;
    const grantNow = draw === grantAt ? grant : 0;
    next.fill(0);
    for (let progress = 0; progress < progressLimit; progress++) {
      const stopsWithoutUp = fixedEnd || progress >= nextLimit;
      const stopsWithUp = stopsWithoutUp || (target && progress + 1 >= nextLimit);
      const base = progress * stride;
      for (let left = 0; left <= remaining; left++) {
        const from = base + left * WATER;
        const stay = base + Math.max(0, left - grantNow) * WATER;
        let gold = 0;
        for (let pity = 0; pity < WATER; pity++) {
          const mass = live[from + pity];
          if (!mass) continue;
          const hit = mass * P[pity + 1];
          gold += hit;
          if (!stopsWithoutUp && pity + 1 < WATER) next[stay + pity + 1] += mass - hit;
        }
        const off = left ? gold / 14 : 0;
        expected += off;
        if (!stopsWithoutUp) {
          if (left) next[base + Math.max(0, left - 1 - grantNow) * WATER] += off;
          next[stay] += 0.5 * gold - off;
        }
        if (!stopsWithUp) next[stay + (target ? stride : 0)] += 0.5 * gold;
      }
    }
    [live, next] = [next, live];
    progressLimit = nextLimit;
  }
  if (offMomentsCache.size >= MOMENT_CACHE_ENTRIES) {
    offMomentsCache.delete(offMomentsCache.keys().next().value);
  }
  offMomentsCache.set(cacheKey, expected);
  return expected;
}

function cappedOutputDistributions({offset, target, horizon, key}, output, capacity) {
  const {remaining: [first, second], grantAt, grants: [grantFirst, grantSecond]} = capacity;
  const cacheKey = ['capped-limited', key, first, second, grantAt, grantFirst, grantSecond].join('/');
  const cached = distributionCache.get(cacheKey);
  if (cached && cached.cap >= output) return cached.series;
  if (cached) {
    distributionCache.delete(cacheKey);
    distributionBytes -= cached.bytes;
  }
  // Golds may continue after both cards hit full potential. Only effective
  // output increases count, so discarding counts above cap remains exact.
  const progressWidth = Math.max(1, target);
  const capacityWidth = (first + 1) * (second + 1);
  const preferred = Math.min(horizon, Math.max(output, target ? 6 + 3 * target : 5));
  const maxCells = 2000000;
  const cap = progressWidth * (preferred + 1) * capacityWidth * WATER <= maxCells ? preferred : output;
  const countStride = capacityWidth;
  const progressStride = (cap + 1) * countStride;
  const rowCount = progressWidth * progressStride;
  if (rowCount * WATER > maxCells || (cap + 1) * (horizon + 1) > maxCells) {
    throw new FlatBStopLimit('B区满潜参照达到内存上限');
  }
  let live = new Float64Array(rowCount * WATER);
  let next = new Float64Array(live.length);
  const seen = new Uint32Array(rowCount);
  const row = (progress, count, a, b) =>
    progress * progressStride + count * countStride + a * (second + 1) + b;
  let liveRows = [row(0, 0, first, second)];
  let nextRows = [];
  live[liveRows[0] * WATER] = 1;
  const exits = Array.from({length: cap + 1}, () => new Float64Array(horizon + 1));
  if (!horizon) exits[0][0] = 1;

  let progressLimit = progressWidth;
  let work = 0;
  for (let draw = 1; draw <= horizon; draw++) {
    if (!liveRows.length) break;
    work += liveRows.length * WATER;
    checkWork(work);
    const token = target && (offset + draw) % TOKEN_STEP === 0;
    const nextLimit = token ? progressLimit - 1 : progressLimit;
    const fixedEnd = !target && draw === horizon;
    const consumeFirst = draw === grantAt ? grantFirst : 0;
    const consumeSecond = draw === grantAt ? grantSecond : 0;
    nextRows.length = 0;

    function add(rowIndex, pity, mass) {
      if (!mass) return;
      const at = rowIndex * WATER;
      if (seen[rowIndex] !== draw) {
        seen[rowIndex] = draw;
        next.fill(0, at, at + WATER);
        nextRows.push(rowIndex);
      }
      next[at + pity] += mass;
    }

    for (const liveRow of liveRows) {
      const progress = Math.floor(liveRow / progressStride);
      const count = Math.floor((liveRow % progressStride) / countStride);
      const a = Math.floor((liveRow % countStride) / (second + 1));
      const b = liveRow % (second + 1);
      const aNext = Math.max(0, a - consumeFirst);
      const bNext = Math.max(0, b - consumeSecond);
      const startsAt = liveRow * WATER;
      const stay = row(progress, count, aNext, bNext);
      const stopsWithoutUp = fixedEnd || progress >= nextLimit;
      const stopsWithUp = stopsWithoutUp || (target && progress + 1 >= nextLimit);
      let gold = 0;
      for (let pity = 0; pity < WATER; pity++) {
        const mass = live[startsAt + pity];
        if (!mass) continue;
        const hit = mass * P[pity + 1];
        gold += hit;
        if (stopsWithoutUp) exits[count][draw - 1 - pity] += mass - hit;
        else if (pity + 1 < WATER) add(stay, pity + 1, mass - hit);
      }
      if (!gold) continue;
      const common = gold * (7 - Number(a > 0) - Number(b > 0)) / 14;
      if (stopsWithoutUp) exits[count][draw] += common;
      else add(stay, 0, common);
      if (count === cap) continue;
      if (stopsWithoutUp) {
        exits[count + 1][draw] += gold * (Number(a > 0) + Number(b > 0)) / 14;
      } else {
        if (a) add(row(progress, count + 1, Math.max(0, a - 1 - consumeFirst), bNext), 0, gold / 14);
        if (b) add(row(progress, count + 1, aNext, Math.max(0, b - 1 - consumeSecond)), 0, gold / 14);
      }
      if (stopsWithUp) exits[count + 1][draw] += 0.5 * gold;
      else add(row(progress + Number(Boolean(target)), count + 1, aNext, bNext), 0, 0.5 * gold);
    }
    [live, next] = [next, live];
    [liveRows, nextRows] = [nextRows, liveRows];
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
  const capacity = axis === 'limited' ? normalizeCapacity(input.capacity, plan.horizon) : null;
  const saturated = capacity?.remaining.every(value => value === 0);
  const expectedOutput = capacity ? 0.5 * expectedSix + capacity.remaining.reduce((sum, remaining, i) =>
    sum + expectedOff(plan, remaining, capacity.grantAt, capacity.grants[i]), 0)
    : axis === 'characterSix' ? expectedSix : expectedSix * 9 / 14;
  let joint;
  if (plan.output > plan.horizon) joint = new Float64Array(plan.horizon + 1);
  else if (saturated) {
    const capped = {...plan, key: plan.key + '/off-full', unlimitedOff: 0};
    joint = outputDistributions(axis, capped, plan.output)[plan.output];
  } else if (capacity) joint = cappedOutputDistributions(plan, plan.output, capacity)[plan.output];
  else joint = outputDistributions(axis, plan, plan.output)[plan.output];
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
  return {probabilities, expectedOutput, conditionedMass, ...(capacity ? {capacity} : {})};
}

module.exports = {stoppedBKernel, FlatBStopLimit};
