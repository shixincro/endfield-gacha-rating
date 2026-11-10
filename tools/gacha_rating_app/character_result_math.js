'use strict';

// Integer-lattice equivalent-cost reference. These fixed credits are scoring
// weights; observed draw counts are never rounded to obtain them.
const ORDINARY_SIX_MEAN = 53.89927355371168;
const C6 = 54;
const CUP = 108;
const CL = 84;
const MAX_WIDTH = 200001;
const MAX_ABS = 200000;
const FFT_THRESHOLD = 1000000;
const EPS = 1e-12;
const meta = new WeakMap();
const upCache = new Map();

function integer(value, low, high, label) {
  if (!Number.isSafeInteger(value) || value < low || value > high) {
    throw new RangeError(`${label} must be an integer in [${low}, ${high}]`);
  }
  return value;
}
function hazard(age) {
  if (age >= 80) return 1;
  return age <= 65 ? .008 : .008 + .05 * (age - 65);
}
function inspected(d) {
  if (meta.has(d)) return meta.get(d);
  if (!d || !Array.isArray(d.p)) throw new TypeError('distribution requires {lo, p:Array}');
  integer(d.lo, -MAX_ABS, MAX_ABS, 'distribution lo');
  integer(d.p.length, 1, MAX_WIDTH, 'distribution width');
  integer(d.lo + d.p.length - 1, -MAX_ABS, MAX_ABS, 'distribution hi');
  let mass = 0;
  const nz = [];
  for (let i = 0; i < d.p.length; i++) {
    const p = d.p[i];
    if (!Number.isFinite(p) || p < 0) throw new RangeError('invalid probability');
    mass += p;
    if (p) nz.push([i, p]);
  }
  if (mass > 1 + 1e-9) throw new RangeError('distribution mass exceeds one');
  const result = {mass, hi: d.lo + d.p.length - 1, nz, truncated: mass < 1 - EPS};
  if (Object.isFrozen(d) && Object.isFrozen(d.p)) meta.set(d, result);
  return result;
}
function distribution(lo, probabilities) {
  const d = {lo, p: Array.from(probabilities)};
  inspected(d);
  Object.freeze(d.p);
  Object.freeze(d);
  inspected(d);
  return d;
}
function point(value = 0) { return distribution(value, [1]); }
function sumMass(d) { return inspected(d).mass; }

function fft(real, imaginary, inverse) {
  const n = real.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imaginary[i], imaginary[j]] = [imaginary[j], imaginary[i]];
    }
  }
  for (let length = 2; length <= n; length *= 2) {
    const angle = (inverse ? 2 : -2) * Math.PI / length;
    const unitReal = Math.cos(angle), unitImaginary = Math.sin(angle);
    for (let start = 0; start < n; start += length) {
      let wr = 1, wi = 0;
      for (let j = 0; j < length / 2; j++) {
        const left = start + j, right = left + length / 2;
        const vr = real[right] * wr - imaginary[right] * wi;
        const vi = real[right] * wi + imaginary[right] * wr;
        const ur = real[left], ui = imaginary[left];
        real[left] = ur + vr; imaginary[left] = ui + vi;
        real[right] = ur - vr; imaginary[right] = ui - vi;
        const nextReal = wr * unitReal - wi * unitImaginary;
        wi = wr * unitImaginary + wi * unitReal;
        wr = nextReal;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { real[i] /= n; imaginary[i] /= n; }
}
function fftConvolution(a, b, outputLength, expectedFullMass) {
  let size = 1;
  const fullLength = a.length + b.length - 1;
  while (size < fullLength) size *= 2;
  if (size > 524288) throw new RangeError('FFT support limit exceeded');
  const ar = new Float64Array(size), ai = new Float64Array(size);
  const br = new Float64Array(size), bi = new Float64Array(size);
  ar.set(a); br.set(b);
  fft(ar, ai, false); fft(br, bi, false);
  for (let i = 0; i < size; i++) {
    const real = ar[i] * br[i] - ai[i] * bi[i];
    ai[i] = ar[i] * bi[i] + ai[i] * br[i];
    ar[i] = real;
  }
  fft(ar, ai, true);
  const out = new Float64Array(outputLength);
  let mass = 0;
  for (let i = 0; i < outputLength; i++) {
    // The transform evaluates the same discrete polynomial product; negative
    // roundoff is not real probability. This is floating-point convolution,
    // not a sample estimate or a normal approximation.
    if (ar[i] < -1e-10) throw new Error('FFT numerical error exceeded tolerance');
    out[i] = Math.max(0, ar[i]);
    mass += out[i];
  }
  if (outputLength === fullLength && mass > 0) {
    if (Math.abs(mass - expectedFullMass) > 1e-8) throw new Error('FFT mass error exceeded tolerance');
    // Correct numerical drift to the product of RETAINED masses, never to1.
    const scale = expectedFullMass / mass;
    for (let i = 0; i < outputLength; i++) out[i] *= scale;
  }
  return out;
}

// A missing mass is an upper tail, not a renormalization request. When an
// operand has an unknown upper tail, only coefficients guaranteed not to
// receive any of that tail are retained in the result.
function convolve(a, b, options = {}) {
  const aa = inspected(a), bb = inspected(b);
  const requested = typeof options === 'number' ? options : options.highCap;
  if (requested != null) integer(requested, -MAX_ABS, MAX_ABS, 'highCap');
  const lo = a.lo + b.lo;
  let hi = aa.hi + bb.hi;
  if (aa.truncated) hi = Math.min(hi, aa.hi + b.lo);
  if (bb.truncated) hi = Math.min(hi, bb.hi + a.lo);
  if (requested != null) hi = Math.min(hi, requested);
  if (requested != null && requested < lo) return distribution(requested, [0]);
  integer(lo, -MAX_ABS, MAX_ABS, 'convolution lo');
  integer(hi, lo, MAX_ABS, 'convolution hi');
  integer(hi - lo + 1, 1, MAX_WIDTH, 'convolution width');
  if (aa.nz.length * bb.nz.length > FFT_THRESHOLD) {
    return distribution(lo, fftConvolution(a.p, b.p, hi - lo + 1, aa.mass * bb.mass));
  }
  const out = new Float64Array(hi - lo + 1);
  let left = aa.nz, right = bb.nz;
  if (left.length > right.length) [left, right] = [right, left];
  for (const [i, p] of left) {
    for (const [j, q] of right) {
      const k = i + j;
      if (k >= out.length) break;
      out[k] += p * q;
    }
  }
  return distribution(lo, out);
}
function convolveMany(distributions, options = {}) {
  if (!Array.isArray(distributions) || distributions.length > 1000) throw new RangeError('invalid distribution collection');
  if (!distributions.length) return point();
  const cap = typeof options === 'number' ? options : options.highCap;
  if (cap != null) integer(cap, -MAX_ABS, MAX_ABS, 'highCap');
  // Future negative credits can bring large partial costs back into range.
  // A partial cutoff is therefore FINAL cutoff minus ALL remaining minima.
  const suffixLo = new Array(distributions.length + 1).fill(0);
  for (let i = distributions.length - 1; i >= 0; i--) {
    inspected(distributions[i]);
    suffixLo[i] = suffixLo[i + 1] + distributions[i].lo;
  }
  let result = distributions[0];
  if (cap != null) result = convolve(result, point(), {highCap: cap - suffixLo[1]});
  for (let i = 1; i < distributions.length; i++) {
    result = convolve(result, distributions[i], cap == null ? {} : {highCap: cap - suffixLo[i + 1]});
  }
  return result;
}
function midTail(d, observed) {
  if (!Number.isFinite(observed)) throw new RangeError('observed cost must be finite');
  const info = inspected(d);
  if (info.truncated && observed > info.hi) throw new RangeError('observed cost lies in an unresolved upper tail');
  let value = Math.max(0, 1 - info.mass);
  for (let i = 0; i < d.p.length; i++) {
    const x = d.lo + i;
    if (x > observed) value += d.p[i];
    else if (x === observed) value += .5 * d.p[i];
  }
  return Math.max(0, Math.min(1, value));
}

function sixWait(initialPity = 0, schedule = [{at: 0, deadline: null}]) {
  integer(initialPity, 0, 79, 'initialPity');
  if (!Array.isArray(schedule) || !schedule.length || schedule.length > 1000 || schedule[0].at !== 0) {
    throw new RangeError('six-star schedule must start at elapsed draw zero');
  }
  let previous = -1;
  for (const entry of schedule) {
    integer(entry.at, 0, MAX_ABS - 1, 'schedule at');
    if (entry.at <= previous) throw new RangeError('schedule must be strictly chronological');
    if (entry.deadline != null) integer(entry.deadline, entry.at + 1, MAX_ABS, 'schedule deadline');
    previous = entry.at;
  }
  const entries = [];
  let survival = 1, j = 0;
  for (let wait = 1; wait <= 80 - initialPity; wait++) {
    while (j + 1 < schedule.length && schedule[j + 1].at < wait) j++;
    const forced = schedule[j].deadline === wait;
    const p = forced ? 1 : hazard(initialPity + wait);
    entries.push({wait, p: survival * p, forced});
    survival *= 1 - p;
    if (!survival) break;
  }
  return entries;
}
function costFromEntries(entries, weighted, missing = 0) {
  if (!Array.isArray(entries) || entries.length > 80) throw new RangeError('invalid six-star waiting entries');
  integer(missing, 0, 2, 'missing limited count');
  if (!entries.length) return point();
  let lo = Infinity, hi = -Infinity;
  const atoms = [];
  for (const e of entries) {
    integer(e.wait, weighted ? 0 : 1, 80, 'wait');
    if (!Number.isFinite(e.p) || e.p < 0 || typeof e.forced !== 'boolean') throw new RangeError('invalid wait entry');
    const weights = !weighted ? [[0, 1]] : e.forced ? [[1, 1]] : [[0, 5 / 14], [1, (9 - missing) / 14], [2, missing / 14]];
    for (const [w, probability] of weights) {
      if (!probability || !e.p) continue;
      const cost = e.wait - (weighted ? CL * w : 0);
      lo = Math.min(lo, cost); hi = Math.max(hi, cost);
      atoms.push([cost, probability * e.p]);
    }
  }
  if (!atoms.length) throw new RangeError('empty waiting probability');
  const out = new Float64Array(hi - lo + 1);
  for (const [cost, p] of atoms) out[cost - lo] += p;
  return distribution(lo, out);
}
function sixCost(entries) { return costFromEntries(entries, false); }
function limitedCost(entries, missing = 0) { return costFromEntries(entries, true, missing); }
function identityCost(missing = 0, forced = false) {
  return limitedCost([{wait: 0, p: 1, forced}], missing);
}

function rushCountCost(draws, probability = .008, credit = C6) {
  integer(draws, 0, 10000, 'rush draws');
  integer(credit, 1, MAX_ABS, 'credit');
  if (draws * credit >= MAX_WIDTH) throw new RangeError('rush support limit exceeded');
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) throw new RangeError('invalid rush probability');
  if (!draws || probability === 0) return point();
  if (probability === 1) return point(-credit * draws);
  // Start at the mode and normalize relative weights, avoiding underflow of
  // P(K=0) for larger sample sizes and non-small caller probabilities.
  const mode = Math.floor((draws + 1) * probability);
  const binomial = new Float64Array(draws + 1);
  binomial[mode] = 1;
  for (let k = mode; k > 0; k--) binomial[k - 1] = binomial[k] * k / (draws - k + 1) * (1 - probability) / probability;
  for (let k = mode; k < draws; k++) binomial[k + 1] = binomial[k] * (draws - k) / (k + 1) * probability / (1 - probability);
  let mass = 0;
  for (const p of binomial) mass += p;
  const out = new Float64Array(credit * draws + 1);
  for (let k = 0; k <= draws; k++) out[credit * (draws - k)] = binomial[k] / mass;
  return distribution(-credit * draws, out);
}
function rushLimitedCost(draws, missing = 0) {
  integer(draws, 0, 1000, 'rush draws');
  integer(missing, 0, 2, 'missing limited count');
  if (2 * CL * draws >= MAX_WIDTH) throw new RangeError('rush limited support limit exceeded');
  if (!draws) return point();
  const length = 2 * draws + 1;
  let states = Array.from({length: missing + 1}, () => new Float64Array(length));
  states[missing][0] = 1;
  for (let draw = 0; draw < draws; draw++) {
    const next = Array.from({length: missing + 1}, () => new Float64Array(length));
    for (let left = 0; left <= missing; left++) {
      for (let w = 0; w <= 2 * draw; w++) {
        const mass = states[left][w];
        if (!mass) continue;
        next[left][w] += mass * (1 - .008 * 9 / 14);
        next[left][w + 1] += mass * .008 * (9 - left) / 14;
        if (left) next[left - 1][w + 2] += mass * .008 * left / 14;
      }
    }
    states = next;
  }
  const out = new Float64Array(2 * CL * draws + 1);
  for (let left = 0; left <= missing; left++) {
    for (let w = 0; w < length; w++) out[CL * (2 * draws - w)] += states[left][w];
  }
  return distribution(-2 * CL * draws, out);
}

function upWait(initialPity = 0, remaining120 = null, maxWait = 2048) {
  integer(initialPity, 0, 79, 'initialPity');
  if (remaining120 != null) integer(remaining120, 1, 120, 'remaining120');
  integer(maxWait, 1, 50000, 'maxWait');
  const cap = remaining120 == null ? maxWait : Math.min(maxWait, remaining120);
  const key = `${initialPity}/${remaining120}/${cap}`;
  if (upCache.has(key)) return upCache.get(key);
  let state = new Float64Array(80);
  state[initialPity] = 1;
  const out = new Float64Array(cap);
  for (let draw = 1; draw <= cap; draw++) {
    const next = new Float64Array(80);
    if (draw === remaining120) {
      for (const p of state) out[draw - 1] += p;
      break;
    }
    for (let pity = 0; pity < 80; pity++) {
      if (!state[pity]) continue;
      const hit = state[pity] * hazard(pity + 1);
      out[draw - 1] += .5 * hit;
      next[0] += .5 * hit;
      if (pity < 79) next[pity + 1] += state[pity] - hit;
    }
    state = next;
  }
  const result = distribution(1, out);
  if (upCache.size >= 256) upCache.clear();
  upCache.set(key, result);
  return result;
}
function upCompletedCost(wait) { inspected(wait); return wait; }
function upFailedCost(wait, horizon) {
  integer(horizon, 0, 50000, 'failure horizon');
  const info = inspected(wait);
  if (wait.lo < 1) throw new RangeError('UP wait support must start after zero');
  if (info.truncated && horizon > info.hi) throw new RangeError('UP failure horizon exceeds resolved wait support');
  if (!horizon) return point();
  const lo = Math.min(horizon, wait.lo - CUP);
  const out = new Float64Array(horizon - lo + 1);
  let success = 0;
  for (let i = 0; i < wait.p.length && wait.lo + i <= horizon; i++) {
    success += wait.p[i];
    out[wait.lo + i - CUP - lo] += wait.p[i];
  }
  out[horizon - lo] += Math.max(0, 1 - success);
  return distribution(lo, out);
}

module.exports = {
  VERSION: 'character-result-integer-cost-v1-20261019',
  ORDINARY_SIX_MEAN, C6, CUP, CL, MAX_WIDTH,
  distribution, point, sumMass, convolve, convolveMany, midTail,
  sixWait, sixCost, limitedCost, identityCost, rushCountCost, rushLimitedCost,
  upWait, upCompletedCost, upFailedCost,
};
