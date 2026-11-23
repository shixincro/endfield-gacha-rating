'use strict';

const {prepare} = require('./ledger');
const {scoreFlatA, FlatALimit} = require('./flat_a');
const {scoreFlatBMatched, FlatBLimit} = require('./flat_b');
const {FlatBStopLimit} = require('./flat_b_stop');
const {scoreFlatNew} = require('./flat_new');
const {midTail, rushCountCost} = require('../gacha_rating_app/character_result_math');

const VERSION = 'character-abc-flat-v4-new-weight';
const OUTPUT = {characterSix: 'six', up: 'up', limited: 'limited'};
const RUSH_RATE = {characterSix: .008, up: .004, limited: .008 * 9 / 14};
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
    a.push({id, carry, openingPity, freeAllowance, paidPrefix, complete, observedAt, referenceOpeningPity,
      referenceFreeAllowance: referenceFreeAllowance ?? (observedAt === 0 ? 10 : null),
      inheritsVoucher, draws: observedAt + donated.draws,
      paid: paidPrefix[observedAt] + donated.paid, transferredPaid: donated.paid, ...pool.a});
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
    b.push({id, start: observedAt, end, completeEnd, paidPrefix, freeAllowance,
      draws: end - observedAt, paid: paidPrefix[end] - paidPrefix[observedAt],
      ...counts, up: counts.up + tokens.length, stopTarget});

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

function rushPart(axis, rush) {
  if (!rush.draws) return [];
  const observed = rush[OUTPUT[axis]];
  const rate = RUSH_RATE[axis];
  return [{score: 100 * midTail(rushCountCost(rush.draws, rate, 1), -observed),
    weight: rush.draws * rate, details: {method: 'fixed-rush-count-midrank', draws: rush.draws, observed, rate}}];
}

function combine(groups, emptyReason = '没有可比较的抽卡投入') {
  let weight = 0;
  let total = 0;
  for (const parts of Object.values(groups)) {
    for (const part of parts) {
      if (!Number.isFinite(part.score) || part.score < 0 || part.score > 100 ||
          !Number.isFinite(part.weight) || part.weight < 0) throw new Error('候选分数或权重无效');
      weight += part.weight;
      total += part.weight * part.score;
    }
  }
  return weight > 0
    ? {status: 'scored', score: Math.max(0, Math.min(100, total / weight)), details: {groups, weight}}
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
  const C = phase(pools.map(pool => ({draws: pool.rushAt == null ? 0 : 10, paid: 0, ...hits(pool.rush, pool.index)})));
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
        axes[axis] = combine({B: scoreFlatBMatched(axis, b)}, '没有可结算的 B 区投入');
      } else {
        axes[axis] = combine({A: scoreFlatA(axis, a), B: scoreFlatBMatched(axis, b), C: rushPart(axis, C)});
      }
    } catch (error) {
      if (!(error instanceof FlatALimit) && !(error instanceof FlatBLimit) && !(error instanceof FlatBStopLimit)) throw error;
      axes[axis] = {status: 'unscored', score: null, reason: error.message};
    }
  }
  if (!onlyB) axes.limited = adjustLimited(axes.limited, prepared);
  const {A, B, pending, transfers} = byAxis.characterSix;
  return {version: VERSION, ...(onlyB ? {scope: 'B'} : {}), axes,
    actual: {A, B, C, byAxis, pending, transfers, endPity: pools.at(-1).tail}};
}

function scoreCharacterFlatABC(input) {
  return scoreRecord(input, false);
}

function scoreCharacterFlatB(input) {
  return scoreRecord(input, true);
}

module.exports = {VERSION, scoreCharacterFlatABC, scoreCharacterFlatB};
