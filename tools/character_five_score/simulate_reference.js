'use strict';

// One record is a chronology of fresh regular limited banners, not one draw.
// This module never runs simulations on import; the caller owns the MC budget.
function p6(pity) {
  if (!Number.isInteger(pity) || pity < 0 || pity > 79) {
    throw new RangeError('six-star pity must be an integer in [0, 79]');
  }
  return pity >= 79 ? 1 : pity <= 64 ? .008 : .008 + .05 * (pity - 64);
}

function drawMainRarity(sixProbability, fiveFailures, forced, random) {
  if (forced || random() < sixProbability) return 6;
  // Eight percent is the marginal five-star probability, not a conditional rate.
  if (fiveFailures === 9 || random() < .08 / (1 - sixProbability)) return 5;
  return 4;
}

function drawRushRarity(high, last, random) {
  const value = random();
  if (value < .008) return 6;
  // Upgrade only a four-star result; the final-slot guarantee cannot erase a six.
  if (value < .088 || (last && !high)) return 5;
  return 4;
}

function rng(seed) {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new RangeError('seed must be a uint32');
  }
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) | 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function simulateReference(random, options = {}) {
  if (typeof random !== 'function') throw new TypeError('random must be a function');
  const {
    poolCount = 11,
    initialOwned = [],
    initialSixPity = 0,
    initialFivePity = 0,
    initialFreeBonus = false,
    keepTrace = false,
  } = options;
  if (!Number.isInteger(poolCount) || poolCount < 1 || poolCount > 11) {
    throw new RangeError('poolCount must be an integer in [1, 11]');
  }
  p6(initialSixPity);
  if (!Number.isInteger(initialFivePity) || initialFivePity < 0 || initialFivePity > 9) {
    throw new RangeError('initialFivePity must be an integer in [0, 9]');
  }
  if (!Array.isArray(initialOwned) || initialOwned.some(id => !Number.isInteger(id) || id < 0 || id > 10)) {
    throw new TypeError('initialOwned must contain limited-character ids in [0, 10]');
  }
  if (typeof initialFreeBonus !== 'boolean' || typeof keepTrace !== 'boolean') {
    throw new TypeError('initialFreeBonus and keepTrace must be boolean');
  }
  const owned = new Set(initialOwned);
  const out = {N: 0, R: 0, F: 0, K6: 0, forced120: 0, pools: []};
  let sixPity = initialSixPity;
  let fivePity = initialFivePity;
  let freeBonus = initialFreeBonus;

  for (let i = 0; i < poolCount; i++) {
    const preowned = owned.has(i);
    const freeDraws = freeBonus ? 20 : 10;
    const offLimited = i === 0 ? [1, 2] : i === 1 ? [0, 2] : [i - 1, i - 2];
    const pool = {
      i, N: 0, R: 0, F: 0, K6: 0, forced120: 0,
      preowned, freeDraws, firstTargetAt: null, firstTargetSource: null,
      startPity: sixPity, startFivePity: fivePity, seenMainUp: false,
    };
    if (keepTrace) pool.trace = [];
    // Pre-owned targets only use free tickets; no 30-pull milestone purchase.
    let stopAt = preowned ? freeDraws : null;

    function obtainSix(kind, forced, rushIndex = null) {
      let id;
      if (forced || random() < .5) id = i;
      else {
        const choice = Math.floor(random() * 7);
        id = choice < 2 ? offLimited[choice] : -1;
      }
      out.K6++;
      pool.K6++;
      if (id >= 0) owned.add(id);
      if (id === i) {
        if (kind === 'main') pool.seenMainUp = true;
        if (!preowned && pool.firstTargetAt === null) {
          pool.firstTargetAt = pool.N;
          pool.firstTargetSource = kind;
          const targetStop = pool.N >= 46 && pool.N <= 59 ? 60 : pool.N;
          stopAt = Math.max(freeDraws, targetStop);
        }
      }
      return {id, kind, forced, pos: pool.N, rushIndex};
    }

    for (;;) {
      pool.N++;
      out.N++;
      // Rush UPs do not settle the main-pool one-shot 120 guarantee.
      const forced = pool.N === 120 && !pool.seenMainUp;
      const beforeSix = sixPity;
      const beforeFive = fivePity;
      const rarity = drawMainRarity(p6(sixPity), fivePity, forced, random);
      let event = {kind: 'main', pos: pool.N, id: null, forced};
      if (rarity === 6) {
        event = obtainSix('main', forced);
        sixPity = 0;
        fivePity = 0;
        if (forced) {out.forced120++; pool.forced120++;}
      } else {
        sixPity++;
        if (rarity === 5) {out.F++; pool.F++; fivePity = 0;}
        else fivePity++;
      }
      if (keepTrace) pool.trace.push({...event, rarity, beforeSix, beforeFive, afterSix: sixPity, afterFive: fivePity});

      if (pool.N === 30) {
        out.R++;
        pool.R++;
        let high = false;
        // Always finish the independent batch, even if its first result is UP.
        for (let j = 0; j < 10; j++) {
          const rushRarity = drawRushRarity(high, j === 9, random);
          let rushEvent = {kind: 'rush', pos: 30, rushIndex: j + 1, id: null, forced: false};
          if (rushRarity === 6) rushEvent = obtainSix('rush', false, j + 1);
          else if (rushRarity === 5) {out.F++; pool.F++;}
          if (rushRarity >= 5) high = true;
          if (keepTrace) pool.trace.push({...rushEvent, rarity: rushRarity, beforeSix: sixPity, beforeFive: fivePity, afterSix: sixPity, afterFive: fivePity});
        }
      }
      if (stopAt !== null && pool.N >= stopAt) break;
      // An assertion of the first-copy contract, not an artificial draw cap.
      if (pool.N >= 120) throw new Error('first-copy reference failed to terminate by its guaranteed UP');
    }
    pool.endPity = sixPity;
    pool.endFivePity = fivePity;
    freeBonus = pool.N >= 60;
    out.pools.push(pool);
  }
  out.endPity = sixPity;
  out.endFivePity = fivePity;
  out.owned = [...owned].sort((a, b) => a - b);
  return out;
}

module.exports = {p6, drawMainRarity, drawRushRarity, rng, simulateReference};
