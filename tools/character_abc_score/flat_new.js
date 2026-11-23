'use strict';

const {LIMITED} = require('../gacha_rating_app/character_ledger');

const COUNT_STRIDE = LIMITED.length + 1;
const MAX_TRANSITIONS = 4000000;
const MASS_TOLERANCE = 1e-8;
const METHOD = 'new-given-non-up-gold-dp';

function collectSlots(prepared) {
  const slots = [];
  let owned = prepared.initialOwnedMask;
  let observed = 0;
  let eligibleSlots = 0;
  for (const pool of prepared.pools) {
    const up = 1 << pool.index;
    const off = pool.off.map(id => 1 << id);
    function append(id) {
      const actual = id < 0 ? 0 : 1 << id;
      if (id === pool.index) {
        slots.push({up, off: []});
      } else {
        slots.push({up: 0, off});
        eligibleSlots++;
        if (actual && !(owned & actual)) observed++;
      }
      owned |= actual;
    }

    let pendingRush = pool.rushAt != null;
    function appendRush() {
      for (const id of pool.rush) append(id);
      pendingRush = false;
    }
    for (const event of pool.events) {
      if (pendingRush && pool.rushAt < event.at) appendRush();
      append(event.id);
    }
    if (pendingRush) appendRush();
  }
  return {slots, observed, eligibleSlots};
}

function add(target, owned, count, probability) {
  const key = owned * COUNT_STRIDE + count;
  target.set(key, (target.get(key) ?? 0) + probability);
}

function noOpportunity(eligibleSlots) {
  return {status: 'no-opportunity', score: null, expected: 0, observed: 0,
    eligibleSlots, probabilities: [1], method: METHOD, reason: '记录内没有可能歪出未持有旧限定的位置'};
}

function unavailable(reason, observed = null, eligibleSlots = null) {
  return {status: 'unavailable', score: null, expected: null, observed, eligibleSlots, method: METHOD, reason};
}

function scoreFlatNew(prepared) {
  if (prepared?.includeNew !== true) {
    return unavailable('期初图鉴或中断期间的角色持有情况未确认');
  }
  const {slots, observed, eligibleSlots} = collectSlots(prepared);
  if (!eligibleSlots) return noOpportunity(eligibleSlots);

  const futureMasks = new Uint32Array(slots.length + 1);
  for (let i = slots.length - 1; i >= 0; i--) {
    const mask = futureMasks[i + 1];
    const {up, off} = slots[i];
    futureMasks[i] = up ? mask : mask | off[0] | off[1];
  }
  const seed = prepared.initialOwnedMask & futureMasks[0];
  let live = new Map([[seed * COUNT_STRIDE, 1]]);
  let transitions = 0;
  for (let i = 0; i < slots.length; i++) {
    const {up, off} = slots[i];
    transitions += live.size * (up ? 1 : 3);
    if (transitions > MAX_TRANSITIONS) {
      return unavailable('歪 New 参照达到计算量上限', observed, eligibleSlots);
    }
    const next = new Map();
    const keep = futureMasks[i + 1];
    for (const [key, probability] of live) {
      const owned = Math.floor(key / COUNT_STRIDE);
      const count = key % COUNT_STRIDE;
      if (up) {
        add(next, (owned | up) & keep, count, probability);
        continue;
      }
      // The ledger fixes these golds as non-UP. Five common identities
      // share this outcome; each of the two old limited identities is distinct.
      add(next, owned & keep, count, probability * (5 / 7));
      for (const bit of off) {
        add(next, (owned | bit) & keep, count + Number(!(owned & bit)), probability / 7);
      }
    }
    live = next;
  }

  const probabilities = Array(COUNT_STRIDE).fill(0);
  let highest = 0;
  for (const [key, probability] of live) {
    const count = key % COUNT_STRIDE;
    probabilities[count] += probability;
    highest = Math.max(highest, count);
  }
  const mass = probabilities.reduce((sum, probability) => sum + probability, 0);
  if (!Number.isFinite(mass) || Math.abs(mass - 1) > MASS_TOLERANCE ||
      !(probabilities[observed] > 0)) {
    return unavailable('歪 New 参照概率质量或实际结果校验失败', observed, eligibleSlots);
  }
  if (!highest) return noOpportunity(eligibleSlots);

  probabilities.length = highest + 1;
  let expected = 0;
  let below = 0;
  let above = 0;
  for (let count = 0; count < probabilities.length; count++) {
    const probability = probabilities[count] / mass;
    probabilities[count] = probability;
    expected += count * probability;
    if (count < observed) below += probability;
    if (count > observed) above += probability;
  }
  const equal = probabilities[observed];
  const score = 100 * Math.min(1, below + 0.5 * equal);
  return {status: 'scored', score, expected, observed, below, equal, above,
    probabilities, eligibleSlots, method: METHOD};
}

module.exports = {scoreFlatNew};
