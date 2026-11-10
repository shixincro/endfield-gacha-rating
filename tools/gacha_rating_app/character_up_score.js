'use strict';

// UP-only production scorer. The reference is frozen offline, never generated
// from the player's stopping policy or simulated on a request.
const reference = require('./character_up_reference.json');
const math = require('./character_result_math');
const VERSION = 'up-state-residual-flat-reference-v1-20261022';
const validPity = p => Number.isSafeInteger(p) && p >= 0 && p < 80;
const hazard = age => age === 80 ? 1 : age <= 65 ? .008 : .008 + .05 * (age - 65);

function buildExpectations() {
  const nextSix = new Float64Array(80);
  nextSix[79] = 1;
  for (let p = 78; p >= 0; p--) nextSix[p] = 1 + (1 - hazard(p + 1)) * nextSix[p + 1];
  const noCap = Float64Array.from(nextSix, x => x + nextSix[0]);
  const capped = Array.from({length:121}, () => new Float64Array(80));
  capped[1].fill(1);
  for (let d = 2; d <= 120; d++) for (let p = 0; p < 80; p++) {
    const q = hazard(p + 1), previous = capped[d - 1];
    capped[d][p] = 1 + .5 * q * previous[0] + (p < 79 ? (1 - q) * previous[p + 1] : 0);
  }
  return {noCap, capped};
}
const expectations = buildExpectations();
function expectedRemaining(pity, remaining120) {
  if (!validPity(pity)) throw new Error('UP段的真实六星水位未知或越界');
  if (remaining120 === null) return expectations.noCap[pity];
  if (!Number.isSafeInteger(remaining120) || remaining120 < 1 || remaining120 > 120)
    throw new Error('UP段的剩余120保障距离无效');
  return expectations.capped[remaining120][pity];
}
// Stable empirical midrank; compare ties within numerical recurrence error.
function percentile(sorted, observed) {
  if (!Number.isFinite(observed)) throw new Error('UP统计量不是有限数值');
  const bound = x => {
    let lo = 0, hi = sorted.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (sorted[mid] < x) lo = mid + 1; else hi = mid; }
    return lo;
  };
  return 50 * (bound(observed - 1e-9) + bound(observed + 1e-9)) / sorted.length;
}

function scoreUp(record, data, common = {}) {
  let completed = 0, unsuccessful = 0;
  const poolIds = new Set();
  for (const s of data.completedUp) {
    completed += expectedRemaining(s.initialPity, s.remaining120) - s.actual;
    poolIds.add(s.pool);
  }
  for (const s of data.failedUp) {
    const endRemaining = s.remaining120 == null ? null : s.remaining120 - s.actual;
    unsuccessful += expectedRemaining(s.initialPity, s.remaining120) - s.actual
      - expectedRemaining(s.endPity, endRemaining);
    poolIds.add(s.pool);
  }
  for (const p of record.pools) if (p.rushUsed === true) poolIds.add(p.id ?? p.index);
  const rush = 108 * (data.rushUp - .004 * data.rushDraws);
  const observed = completed + unsuccessful + rush;
  const details = {...common, method:VERSION,
    reference:'optimal-flat-whole-history-model-percentile-not-all-player-ranking',
    completed:data.completedUp, unsuccessful:data.failedUp,
    actualMainUp:data.actualMainUp, completeMainUp:data.completedUp.length,
    observedResidual:observed, residualParts:{completed, unsuccessful, rush},
    failedEpisodeRule:'V(start)-elapsed-V(true-ending-pity,remaining120); never treat a failed segment as a completed hit',
    referencePoolCount:poolIds.size, referenceVersion:reference.version,
    referenceInitialState:'zero pity and empty initial limited ownership; active known pools only',
    partialCoverage:data.excluded.length > 0 || record.completeHistory !== true,
    limitations:'平铺模型分位；尽量降低但不保证消除停手策略差异。部分区间、非零期初和追潜的参照仍有近似。'};
  if (!data.completedUp.length && !data.failedUp.length) {
    if (!data.rushDraws) return {score:null,status:'unscored',reason:'没有可确认的UP等待段或已使用加急',details};
    const law = math.rushCountCost(data.rushDraws, .004, 108);
    return {score:100 * math.midTail(law, -108 * data.rushUp), status:'scored',
      details:{...details, reference:'rush-only-aggregate-binomial', referenceSamples:null}};
  }
  const samples = reference.byPoolCount[String(poolIds.size)];
  if (!samples?.length) return {score:null,status:'unscored',reason:'可评分池数超出已校准的1至12池UP参照',details};
  const score = percentile(samples, observed);
  return {score,status:'scored',details:{...details,referenceSamples:samples.length,
    empiricalEndpoint:score===0||score===100,
    endpointMeaning:'0/100仅表示达到有限参照样本的边缘，不表示理论概率绝对为0/1'}};
}

module.exports = {VERSION, scoreUp, expectedRemaining, buildExpectations, percentile};
