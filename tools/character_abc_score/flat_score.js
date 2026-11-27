'use strict';

const {prepare} = require('./ledger');
const {scoreFlatA, FlatALimit} = require('./flat_a');
const {scoreFlatBMatched, FlatBLimit} = require('./flat_b');
const {FlatBStopLimit} = require('./flat_b_stop');
const {scoreFlatNew} = require('./flat_new');
const {replayLimitedPotential} = require('./flat_potential');
const {convolveMany, distribution, midTail, rushCountCost} = require('../gacha_rating_app/character_result_math');

const VERSION = 'character-abc-flat-v6-effective-output-weight';
const OUTPUT = {characterSix: 'six', up: 'up', limited: 'limited'};
const RUSH_RATE = {characterSix: .008, up: .004};
const RUSH_SIZE = 10;
const OFF_RATE = .008 / 14;
const FACTORIAL = [1];
for (let i = 1; i <= RUSH_SIZE; i++) FACTORIAL.push(FACTORIAL[i - 1] * i);
const rushLimitedCache = new Map();
const MAX_NEW_WEIGHT = .20;

function hits(events, index) {
  return {six: events.length, up: events.filter(id => id === index).length,
    limited: events.filter(id => id >= 0).length};
}

function sum(rows, key) {
  return rows.reduce((total, row) => total + row[key], 0);
}

function phase(rows) {
  return Object.fromEntries(['draws', 'paid', 'six', 'up', 'limited'].map(key => [key, sum(rows, key)]));
}

function tokenPositions(raw, pool) {
  if (raw.tokens == null && pool.total < 240) return [];
  if (!Array.isArray(raw.tokens)) return null;
  const at = raw.tokens.map(token => typeof token === 'number' ? token : token?.at).sort((a, b) => a - b);
  return at.length === Math.floor(pool.total / 240) && at.every((value, i) => value === 240 * (i + 1)) ? at : null;
}

function describePools(input, prepared) {
  const ledger = input?.ledger ?? input;
  const rawPools = (ledger?.character ?? ledger).pools;
  let tail = 0;
  return prepared.pools.map((pool, i) => {
    const previous = prepared.pools[i - 1];
    const raw = rawPools[i];
    const continues = pool.carry && pool.index === previous.index + 1;
    const standardFree = continues && previous.total >= 60 ? 20 : 10;
    const inheritsVoucher = continues && (raw.freeAllowance == null || raw.freeAllowance === standardFree);
    const usedFree = pool.total - pool.paidPrefix[pool.total];
    const declaredExhausted = raw.freeDrawPositions != null && usedFree < pool.total && [0, 10, 20].includes(usedFree);
    const knownFreeFromPositions = declaredExhausted ? usedFree
      : raw.freeDrawPositions != null && usedFree === pool.total && usedFree > 10 ? 20 : null;
    const freeAllowance = raw.freeAllowance ?? (pool.carry || pool.index === 0 ? standardFree
      : knownFreeFromPositions);
    const first = pool.events.findIndex(event => event.id === pool.index);
    const complete = first !== -1;
    const observedAt = complete ? pool.events[first].at : pool.total;
    const last = pool.events.at(-1);
    const openingPity = pool.carry ? tail : pool.openingPity;
    tail = last ? pool.total - last.at : openingPity + pool.total;
    return {
      ...pool, openingPity, tail, freeAllowance, inheritsVoucher,
      referenceOpeningPity: pool.carry ? 0 : pool.openingPity,
      referenceFreeAllowance: freeAllowance,
      complete, observedAt, lastHit: last?.at ?? 0,
      a: hits(pool.events.slice(0, complete ? first + 1 : undefined).map(event => event.id), pool.index),
      b: complete ? pool.events.slice(first + 1) : [],
      tokens: tokenPositions(raw, pool),
    };
  });
}

function receivingPool(pools, i) {
  for (let j = i + 1; j < pools.length && pools[j].carry; j++) {
    if (pools[j].total > 0) return j;
  }
  return -1;
}

function splitAxis(axis, pools) {
  const a = [];
  const b = [];
  const transfers = [];
  const pending = [];
  const incoming = new Map();
  for (const [i, pool] of pools.entries()) {
    const donated = incoming.get(i) ?? {draws: 0, paid: 0};
    const {id, index, carry, openingPity, freeAllowance, paidPrefix, complete, observedAt,
      referenceOpeningPity, referenceFreeAllowance, inheritsVoucher} = pool;
    const capacityA = axis === 'limited' ? {capacity: pool.potential.aContext} : {};
    a.push({id, carry, openingPity, freeAllowance, paidPrefix, complete, observedAt, referenceOpeningPity,
      referenceFreeAllowance: referenceFreeAllowance ?? (observedAt === 0 ? 10 : null),
      inheritsVoucher, draws: observedAt + donated.draws,
      paid: paidPrefix[observedAt] + donated.paid, transferredPaid: donated.paid, ...pool.a,
      limited: pool.potential.a, ...capacityA});
    if (!complete) continue;

    const isUp = axis === 'up';
    const tokens = isUp ? pool.tokens ?? [] : [];
    const lastUp = pool.b.findLast(event => event.id === index)?.at ?? observedAt;
    const completeEnd = isUp ? Math.max(lastUp, tokens.at(-1) ?? observedAt) : pool.lastHit;
    const end = Math.max(pool.lastHit, completeEnd);
    const counts = hits(pool.b.map(event => event.id), index);
    // The shared stopping policy uses the actual draw positions and token nodes.
    // Only the UP axis additionally requires verified token entries in the ledger.
    const stopTarget = counts.up + Math.floor(pool.total / 240);
    const capacityB = axis === 'limited' ? {capacity: pool.potential.bContext} : {};
    b.push({id, start: observedAt, end, completeEnd, paidPrefix, freeAllowance,
      draws: end - observedAt, paid: paidPrefix[end] - paidPrefix[observedAt],
      ...counts, limited: pool.potential.b, ...capacityB, up: counts.up + tokens.length, stopTarget});

    if (end === pool.total) continue;
    const next = receivingPool(pools, i);
    const remainder = {from: id, draws: pool.total - end, paid: paidPrefix[pool.total] - paidPrefix[end]};
    if (next < 0) pending.push(remainder);
    else {
      const earlier = incoming.get(next);
      incoming.set(next, {draws: remainder.draws + (earlier?.draws ?? 0), paid: remainder.paid + (earlier?.paid ?? 0)});
      transfers.push({...remainder, to: pools[next].id});
    }
  }
  return {a, b, actual: {A: phase(a), B: phase(b), transfers, pending}};
}

function limitedRushDistribution([remainingFirst, remainingSecond]) {
  const key = `${remainingFirst}/${remainingSecond}`;
  const cached = rushLimitedCache.get(key);
  if (cached) return cached;
  const probabilities = new Float64Array(RUSH_SIZE + 1);
  const otherRate = 1 - RUSH_RATE.up - 2 * OFF_RATE;
  let expected = 0;
  for (let up = 0; up <= RUSH_SIZE; up++) {
    for (let first = 0; first <= RUSH_SIZE - up; first++) {
      for (let second = 0; second <= RUSH_SIZE - up - first; second++) {
        const rest = RUSH_SIZE - up - first - second;
        const arrangements = FACTORIAL[RUSH_SIZE] /
          (FACTORIAL[up] * FACTORIAL[first] * FACTORIAL[second] * FACTORIAL[rest]);
        const mass = arrangements * RUSH_RATE.up ** up * OFF_RATE ** (first + second) * otherRate ** rest;
        const count = up + Math.min(first, remainingFirst) + Math.min(second, remainingSecond);
        probabilities[RUSH_SIZE - count] += mass;
        expected += count * mass;
      }
    }
  }
  const result = {distribution: distribution(-RUSH_SIZE, probabilities), expected};
  rushLimitedCache.set(key, result);
  return result;
}

function rushPart(axis, rush, pools) {
  if (!rush.draws) return [];
  const observed = rush[OUTPUT[axis]];
  if (axis === 'limited') {
    const forecasts = pools.filter(pool => pool.rushAt != null)
      .map(pool => limitedRushDistribution(pool.potential.cRemaining));
    return [{score: 100 * midTail(convolveMany(forecasts.map(item => item.distribution)), -observed),
      weight: sum(forecasts, 'expected'), details: {method: 'fixed-rush-limited-capacity-midrank',
        draws: rush.draws, observed}}];
  }
  const rate = RUSH_RATE[axis];
  return [{score: 100 * midTail(rushCountCost(rush.draws, rate, 1), -observed),
    weight: rush.draws * rate, details: {method: 'fixed-rush-count-midrank', draws: rush.draws, observed, rate}}];
}

function combine(groups, {emptyReason = '没有可比较的抽卡投入', groupWeights, keepReferenceWeight = false} = {}) {
  let weight = 0;
  let total = 0;
  let referenceWeight = 0;
  for (const [zone, parts] of Object.entries(groups)) {
    const zoneReferenceWeight = groupWeights ? sum(parts, 'weight') : 0;
    const scale = zoneReferenceWeight > 0 ? groupWeights[zone] / zoneReferenceWeight : 1;
    for (const part of parts) {
      if (!Number.isFinite(part.score) || part.score < 0 || part.score > 100 ||
          !Number.isFinite(part.weight) || part.weight < 0) throw new Error('候选分数或权重无效');
      const partWeight = part.weight * scale;
      weight += partWeight;
      total += partWeight * part.score;
      referenceWeight += part.weight;
    }
  }
  return weight > 0
    ? {status: 'scored', score: Math.max(0, Math.min(100, total / weight)),
      details: {groups, weight: keepReferenceWeight ? referenceWeight : weight,
        ...(groupWeights ? {groupWeights} : {})}}
    : {status: 'unscored', score: null, reason: emptyReason};
}

function adjustLimited(base, prepared) {
  if (base.status !== 'scored') return base;
  const {status, score, expected, observed, below, equal, reason} = scoreFlatNew(prepared);
  const weight = status === 'scored' ? MAX_NEW_WEIGHT * expected / (1 + expected) : 0;
  const direction = ((score ?? 50) - 50) / 50;
  const room = direction >= 0 ? 100 - base.score : base.score;
  const delta = weight * direction * room;
  return {...base, score: base.score + delta, details: {...base.details, baseScore: base.score,
    newAdjustment: {status, score, expected, observed, weight, delta,
      ...(below == null ? {} : {below, equal}), ...(reason == null ? {} : {reason})}}};
}

function scoreRecord(input, onlyB) {
  const prepared = prepare(input);
  const pools = describePools(input, prepared);
  const potential = replayLimitedPotential(prepared, pools.map(pool => pool.tokens));
  for (const [i, pool] of pools.entries()) pool.potential = potential[i];
  const C = phase(pools.map(pool => ({draws: pool.rushAt == null ? 0 : RUSH_SIZE, paid: 0,
    ...hits(pool.rush, pool.index), limited: pool.potential.c})));
  const byAxis = {};
  const axes = {};
  for (const axis of Object.keys(OUTPUT)) {
    const {a, b, actual} = splitAxis(axis, pools);
    byAxis[axis] = actual;
    try {
      const missingTokens = axis === 'up' && pools.find(pool => pool.tokens === null);
      const unknownFree = onlyB ? b.find(row => row.draws && row.freeAllowance == null)
        : pools.find(pool => pool.total && pool.freeAllowance == null);
      if (missingTokens || unknownFree) {
        const reason = missingTokens ? `${missingTokens.id} 的 240 信物明细未确认` : `${unknownFree.id} 的免费额度未确认`;
        axes[axis] = {status: 'unscored', score: null, reason};
      } else if (onlyB) {
        axes[axis] = combine({B: scoreFlatBMatched(axis, b)}, {emptyReason: '没有可结算的 B 区投入'});
      } else {
        const {A, B} = actual;
        const output = OUTPUT[axis];
        const effective = {A: A[output], B: B[output], C: C[output]};
        const groupWeights = Object.values(effective).some(count => count > 0) ? effective : undefined;
        const groups = {A: scoreFlatA(axis, a), B: scoreFlatBMatched(axis, b), C: rushPart(axis, C, pools)};
        // The six-star hover uses details.weight as the expected output.
        axes[axis] = combine(groups, {groupWeights, keepReferenceWeight: axis === 'characterSix'});
      }
    } catch (error) {
      if (!(error instanceof FlatALimit) && !(error instanceof FlatBLimit) && !(error instanceof FlatBStopLimit)) throw error;
      axes[axis] = {status: 'unscored', score: null, reason: error.message};
    }
  }
  if (!onlyB) axes.limited = adjustLimited(axes.limited, prepared);
  const {A, B, pending, transfers} = byAxis.characterSix;
  return {version: VERSION, ...(onlyB ? {scope: 'B'} : {}), axes,
    actual: {A, B, C, byAxis, pending, transfers, endPity: pools.at(-1).tail,
      saturatedOffLimited: sum(potential, 'saturatedOff')}};
}

function scoreCharacterFlatABC(input) {
  return scoreRecord(input, false);
}

function scoreCharacterFlatB(input) {
  return scoreRecord(input, true);
}

module.exports = {VERSION, scoreCharacterFlatABC, scoreCharacterFlatB};
