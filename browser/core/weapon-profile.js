/** Browser-native port of tools/weapon_score_v2/potential_profile_score.py.
 * Float64 terminal moments remain deterministic DP. The final percentile is
 * the same normal approximation as the Python tool, not an exact ratio CDF.
 */
export const PROFILE_VERSION = 'weapon-result-profile-gift-inclusive-normal-1.0';
export const PROFILE_REFERENCE = 'result_profile_fresh_banners_terminal_moments_normal_ratio';
export const MAX_DP_CELL_UPDATES = 120_000_000;
const MAX_PROFILE_TYPES = 1000;
const MAX_PROFILE_TEXT = 8192;
const MAX_TOTAL_DRAWS = 1_000_000_000;
const targetCache = new Map();
const isInt = value => typeof value === 'number' && Number.isInteger(value);
const fail = message => { throw new Error(message); };

export function parseProfile(profile) {
  if (typeof profile !== 'string' || !profile.trim()) fail('结果谱不能为空，例如 12、12 5 1 或 11 5*7。');
  if (profile.length > MAX_PROFILE_TEXT) fail(`结果谱文本不能超过 ${MAX_PROFILE_TEXT} 个字符。`);
  const tokens = profile.replace(/\s*\*\s*/gu, '*').trim().split(/\s+/u);
  if (!/^[0-9]+$/u.test(tokens[0]) || tokens.slice(1).some(token => !/^[0-9]+(?:\*[0-9]+)?$/u.test(token)))
    fail('首项须为种类数；后续填非负潜能或“潜能*数量”，例如 11 5*7。');
  const raw = tokens.map(token => token.split('*'));
  if (raw.some(group => group.some(value => value.replace(/^0+/u, '').length > 9))) fail('结果谱中的数值过大。');
  const groups = raw.map(group => group.map(Number));
  const types = groups[0][0], listed = [];
  if (types > MAX_PROFILE_TYPES) fail(`结果谱种类数最多支持 ${MAX_PROFILE_TYPES}。`);
  for (const group of groups.slice(1)) {
    const [potential, count = 1] = group;
    if (count < 1) fail('“潜能*数量”中的数量须为正整数。');
    if (listed.length + count > types) fail('展开后的潜能项数不能超过首项指定的专武种类数。');
    for (let i = 0; i < count; i++) listed.push(potential);
  }
  const potentials = [...listed, ...Array(types - listed.length).fill(0)].sort((a, b) => b - a);
  const copies = potentials.map(p => p + 1), counts = new Map();
  for (const c of copies) counts.set(c, (counts.get(c) || 0) + 1);
  return {
    total_types: types, potentials, copies_per_type: copies,
    total_copies: copies.reduce((a, b) => a + b, 0),
    normalized: [types, ...potentials.filter(Boolean)].join(' '),
    copy_target_counts: [...counts.keys()].sort((a, b) => a - b).map(c => ({copies: c, types: counts.get(c)})),
    overflow_copies: copies.reduce((a, c) => a + Math.max(0, c - 6), 0),
    interpretation: 'actual_result_used_as_reference_target',
  };
}

export const giftCount = draws => draws < 180 ? 0 : 1 + Math.floor((draws - 180) / 160);
export const horizon = copies => copies === 1 ? 80 : 180 + 160 * (copies - 2);
export const workUnits = copies => horizon(copies) * (copies + 10) * 40 * 3;

function integer(value, name) {
  if (!isInt(value)) fail(`${name} must be an integer, not bool or a fraction`);
  return value;
}

/** erfc(x) = Gamma(1/2, x*x) / Gamma(1/2), with reflection for x < 0.
 * A positive power series evaluates the central part; Lentz's continued
 * fraction evaluates the upper tail without subtracting nearly equal values.
 * This also retains tiny tail scores that a rounded `1 - erf(x)` would lose.
 */
export function erfc(x) {
  if (Number.isNaN(x)) return NaN;
  if (x < 0) return 2 - erfc(-x);
  if (x === 0) return 1;
  if (!Number.isFinite(x)) return 0;
  const z = x * x;
  if (!Number.isFinite(z)) return 0;
  // Recover the rounding error in x*x before exponentiating it. Otherwise
  // tiny normal tails lose relative accuracy from rounding a large exponent.
  const split = 134217729 * x, hi = split - (split - x), lo = x - hi;
  const squareError = ((hi * hi - z) + 2 * hi * lo) + lo * lo;
  const scale = Math.exp(-z) * Math.exp(-squareError) * x / Math.sqrt(Math.PI);
  if (scale === 0) return 0;
  if (z < 1.5) {
    let term = 2, sum = term;
    for (let i = 1; i < 10000; i++) {
      term *= z / (i + .5);
      sum += term;
      if (Math.abs(term) <= Math.abs(sum) * Number.EPSILON) break;
    }
    return Math.max(0, 1 - sum * scale);
  }
  let b = z + .5, c = 1e300, d = 1 / b, h = d;
  for (let i = 1; i < 10000; i++) {
    const a = -i * (i - .5);
    b += 2;
    d = a * d + b;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + a / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) <= 4 * Number.EPSILON) break;
  }
  return scale * h;
}

function targetMoments(copies) {
  integer(copies, 'copies');
  if (copies < 1 || workUnits(copies) > MAX_DP_CELL_UPDATES) fail('单种专武的份数超出当前确定性计算预算。');
  if (targetCache.has(copies)) {
    const cached = targetCache.get(copies);
    targetCache.delete(copies); targetCache.set(copies, cached);
    return cached;
  }
  const rows = copies + 10, stride = rows * 40;
  let active = new Float64Array(3 * stride), next = new Float64Array(3 * stride);
  active[0] = 1;
  const mean = new Float64Array(4), second = Array.from({length: 4}, () => new Float64Array(4));
  let mass = 0;
  for (let draw = 1; draw <= horizon(copies); draw++) {
    next.fill(0);
    for (let u = 0; u < rows; u++) {
      const start = u * 40;
      let p = 0, m = 0, s = 0;
      for (let pity = 0; pity < 40; pity++) {
        const ix = start + pity;
        p += active[ix]; m += active[stride + ix]; s += active[2 * stride + ix];
        if (pity < 39 && !(draw === 80 && u === 0)) {
          next[ix + 1] = .96 * active[ix];
          next[stride + ix + 1] = .96 * active[stride + ix];
          next[2 * stride + ix + 1] = .96 * active[2 * stride + ix];
        }
      }
      if (p === 0) continue;
      if (draw === 80 && u === 0) {
        // Only paths without an earlier drawn UP retain the first-80 promise.
        next[start + 40] += p;
        next[stride + start + 40] += m + p;
        next[2 * stride + start + 40] += s + 2 * m + p;
        continue;
      }
      p = .04 * p + .96 * active[start + 39];
      m = .04 * m + .96 * active[stride + start + 39];
      s = .04 * s + .96 * active[2 * stride + start + 39];
      const offP = .75 * p, offM = .75 * m, offS = .75 * s;
      next[start] += offP;
      next[stride + start] += offM + offP;
      next[2 * stride + start] += offS + 2 * offM + offP;
      if (u + 1 < rows) {
        const upP = .25 * p, upM = .25 * m, upS = .25 * s;
        next[start + 40] += upP;
        next[stride + start + 40] += upM + upP;
        next[2 * stride + start + 40] += upS + 2 * upM + upP;
      }
    }
    [active, next] = [next, active];
    if (draw % 10) continue;
    const gifts = giftCount(draw);
    for (let u = Math.max(0, copies - gifts); u < rows; u++) {
      const start = u * 40;
      let p = 0, m = 0, s = 0;
      for (let pity = 0; pity < 40; pity++) {
        const ix = start + pity;
        p += active[ix]; m += active[stride + ix]; s += active[2 * stride + ix];
        active[ix] = active[stride + ix] = active[2 * stride + ix] = 0;
      }
      mass += p;
      mean[1] += m; second[1][1] += s;
      const values = [draw, 0, u, gifts];
      for (const i of [0, 2, 3]) {
        const v = values[i];
        mean[i] += v * p;
        second[i][1] += v * m; second[1][i] += v * m;
        for (const j of [0, 2, 3]) second[i][j] += v * values[j] * p;
      }
    }
  }
  let remaining = 0;
  for (let i = 0; i < stride; i++) remaining += active[i];
  if (Math.abs(mass - 1) > 2e-11 || remaining > 2e-11) fail(`结果谱 DP 概率质量不守恒：${mass}`);
  for (let i = 0; i < 4; i++) mean[i] /= mass;
  const covariance = Array.from({length: 4}, (_, i) => Array.from({length: 4}, (_, j) =>
    (second[i][j] + second[j][i]) / (2 * mass) - mean[i] * mean[j]));
  const result = {mean: Array.from(mean), covariance, mass};
  if (targetCache.size >= 64) targetCache.delete(targetCache.keys().next().value);
  targetCache.set(copies, result);
  return result;
}

export function referenceProfileMoments(profile) {
  const parsed = parseProfile(profile), targets = parsed.copy_target_counts;
  if (targets.reduce((s, row) => s + workUnits(row.copies), 0) > MAX_DP_CELL_UPDATES)
    fail('结果谱超出当前确定性计算预算，请减少不同高份数项。');
  const mean = [0, 0, 0, 0], covariance = Array.from({length: 4}, () => [0, 0, 0, 0]);
  for (const row of targets) {
    const one = targetMoments(row.copies);
    for (let i = 0; i < 4; i++) {
      mean[i] += row.types * one.mean[i];
      for (let j = 0; j < 4; j++) covariance[i][j] += row.types * one.covariance[i][j];
    }
  }
  const sources = [[0], [1, 3], [2, 3]];
  const inclusiveMean = sources.map(indices => indices.reduce((s, i) => s + mean[i], 0));
  const inclusiveCovariance = sources.map(a => sources.map(b => {
    let result = 0;
    for (const i of a) for (const j of b) result += covariance[i][j];
    return result;
  }));
  return {
    variables: ['draws', 'six_star', 'signature'], mean: inclusiveMean, covariance: inclusiveCovariance,
    raw_variables: ['draws', 'drawn_six_star', 'drawn_signature', 'gifts'], raw_mean: mean, raw_covariance: covariance,
    mean_gifts: mean[3],
    minimum_draws: targets.reduce((s, row) => s + 10 * Math.floor((row.copies + 9) / 10) * row.types, 0),
    maximum_draws: targets.reduce((s, row) => s + horizon(row.copies) * row.types, 0),
    gift_milestones: '180 + 160*k, k=0,1,2,...', method: 'finite_state_terminal_first_second_moments_float64',
    distribution_is_exact: false, moments_are_exact_within_reference_model: true,
  };
}

function profileAxisResult(draws, rawCount, gifts, index, moments) {
  const count = rawCount + gifts, mean = moments.mean, covariance = moments.covariance;
  const rate = draws ? count / draws : null;
  let residualMean = null, residualVariance = null, z = null, score = null;
  if (draws) {
    residualMean = mean[index] - rate * mean[0];
    residualVariance = covariance[index][index] + rate * rate * covariance[0][0] - 2 * rate * covariance[index][0];
    const tolerance = 1e-10 * Math.max(1, covariance[index][index], rate * rate * covariance[0][0]);
    if (residualVariance < -tolerance) fail('结果谱残差方差为负，无法计算。');
    residualVariance = Math.max(0, residualVariance);
    if (residualVariance) {
      z = -residualMean / Math.sqrt(residualVariance);
      score = 50 * erfc(-z / Math.SQRT2);
    } else score = residualMean > 0 ? 0 : residualMean < 0 ? 100 : 50;
  }
  return {
    raw_count: rawCount, gifts, count, effective_count: count, rate, score,
    expected_count: mean[index], expected_draws: mean[0], reference_rate: mean[0] ? mean[index] / mean[0] : null,
    reference_rate_definition: 'E[K]/E[N], not E[K/N]',
    residual_mean: residualMean, residual_variance: residualVariance, z, approximate: true,
  };
}

export function scoreWeaponProfile(N, K6, KU, profile, {allowIndividualDraws = false, lossDraws = 0} = {}) {
  const draws = integer(N, 'N'), six = integer(K6, 'K6'), up = integer(KU, 'KU');
  if (typeof allowIndividualDraws !== 'boolean') fail('allow_individual_draws 必须为布尔值。');
  if (draws < 0 || draws > MAX_TOTAL_DRAWS || (draws % 10 && !allowIndividualDraws))
    fail(`N 必须为 0 至 ${MAX_TOTAL_DRAWS} 的整十抽数；单抽记录须显式启用。`);
  if (!(0 <= up && up <= six && six <= draws)) fail('原始抽取数量必须满足 0 <= KU <= K6 <= N。');
  if (!isInt(lossDraws) || lossDraws < 0 || lossDraws > draws - up)
    fail('扣除亏损后，剩余抽数不能少于抽出的当期专武数。');
  const parsed = parseProfile(profile), copies = parsed.total_copies, types = parsed.total_types, gifts = copies - up;
  if (gifts < 0) fail('结果谱总份数少于原始抽出专武 KU；请补全溢出份数或核对统计范围。');
  if (!types && (draws || six || up)) fail('非空武器记录需要非空结果谱；结果谱 0 仅用于无记录。');
  if (types > up) fail('结果谱种类数不能超过原始抽出专武 KU；每个新池先在 80 抽内取得首把。');
  if (gifts > giftCount(draws)) fail('由结果谱推算的赠品数超出当前总抽数能够到达的赠品节点。');
  const moments = referenceProfileMoments(parsed.normalized);
  const warnings = [
    '手填的是实际取得结果谱，将其作为各新池的参照停手目标；不代表已知原定抽取策略。',
    '每池从零开始，逐件结算 40 抽六星与一次性 80 抽首专武保障，达标后结算完整十连。',
    '实际与参照的六星、专武产量都计入节点赠品；原始 N/K6/KU 保持不变。',
    '赠品数由结果谱总份数减原始 KU 推算，要求统计范围一致，不等于逐条赠品核验。',
    '终止均值和协方差由确定性 DP 计算；分数采用正态近似，不是精确分位或实际玩家排名。',
    '结果谱不能还原试水、未完成池、初始库存、跨复刻继承或实际停手方式；两项分数也不是联合百分位。',
  ];
  if (!draws) warnings.push('没有武器抽取记录，不赋予默认 50 分。');
  if (draws % 10) warnings.push('实际记录保留原始非整十抽数；参照仍在完整十连结束时停手。');
  if (parsed.overflow_copies) warnings.push('超过 5 潜的数字按额外取得份数保留；赠品节点按 180+160k 延续建模。');
  return {
    version: PROFILE_VERSION, reference: PROFILE_REFERENCE,
    method: '100*Phi(-E[K-r*N]/sqrt(Var(K-r*N))), r=observed_inclusive_count/N', total_draws: draws,
    inputs: {N: draws, K6: six, KU: up}, profile: parsed, inferred_gifts: gifts,
    gift_inference: 'profile.total_copies - original_KU',
    six_star: profileAxisResult(draws, six, gifts, 1, moments),
    signature: profileAxisResult(draws - lossDraws, up, gifts, 2, moments),
    reference_moments: moments, approximate: true, warnings,
  };
}

export function clearWeaponProfileCache() { targetCache.clear(); }
