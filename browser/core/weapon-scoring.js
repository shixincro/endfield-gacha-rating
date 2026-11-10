/** Browser equivalent of tools/gacha_rating_app/weapon_scoring.py. */
import {MAX_DP_CELL_UPDATES, giftCount, workUnits, parseProfile, scoreWeaponProfile} from './weapon-profile.js';
import {WEAPON_REFERENCE_DATA} from './weapon-reference-data.js';

export const WEAPON_VERSION = 'weapon-potential-table-loss-v2-20261104';
const isInt = value => typeof value === 'number' && Number.isInteger(value);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw new Error(message); };
const sum = values => values.reduce((a, b) => a + b, 0);
const references = new Map();

export function profileFromTable(config) {
  if (!isObject(config)) fail('专武配置须为潜能数量表。');
  const types = config.totalTypes, counts = config.counts;
  if (!isInt(types) || types < 1 || types > 30) fail('总专武种类须为1至30的整数。');
  if (!Array.isArray(counts) || counts.length !== 5 || counts.some(n => !isInt(n) || n < 0 || n > 30))
    fail('1至5潜的专武数量均须为0至30的整数。');
  if (sum(counts) > types) fail('各潜能数量之和不能超过总专武种类。');
  const overflow = config.overflowCopies === undefined ? 0 : config.overflowCopies;
  if (!isInt(overflow) || overflow < 0 || overflow > 30000) fail('溢出专武数量须为0至30000的整数。');
  const full = counts[4];
  if (overflow && !full) fail('有溢出时至少需要一把5潜专武。');
  let allocation = config.overflowByType;
  if (allocation == null) {
    if (overflow && full > 1) fail('请分别填写各把5潜专武的溢出份数。');
    allocation = full === 1 ? [overflow] : Array(full).fill(0);
  }
  if (!Array.isArray(allocation) || allocation.length !== full || allocation.some(n => !isInt(n) || n < 0 || n > overflow) || sum(allocation) !== overflow)
    fail('各把5潜专武的溢出份数之和须等于溢出专武数量。');
  const potentials = [];
  for (let p = 1; p <= 4; p++) for (let n = 0; n < counts[p - 1]; n++) potentials.push(p);
  potentials.push(...allocation.map(copies => 5 + copies));
  return [types, ...potentials].join(' ');
}

export function validatedProfile(weapon) {
  const config = weapon.potentialConfig;
  const profile = config != null ? profileFromTable(config) : weapon.profile;
  if (profile != null && typeof profile !== 'string') fail('潜能配置格式无效。');
  if (!profile || !profile.trim()) return null;
  const parsed = parseProfile(profile), types = parsed.total_types;
  if (types < 1 || types > 30) fail('专武种类数须为1至30。');
  const up = weapon.KU, draws = weapon.N;
  if (isInt(up)) {
    const gifts = parsed.total_copies - up;
    if (gifts < 0) fail('结果谱总份数少于原始抽出专武数，请核对潜能和溢出。');
    if (types > up) fail('结果谱种类数不能超过原始抽出专武数。');
    if (isInt(draws) && gifts > giftCount(draws)) fail('由结果谱推算的赠品数超出当前总抽数能够到达的赠品节点。');
  }
  if (sum(parsed.copy_target_counts.map(row => workUnits(row.copies))) > MAX_DP_CELL_UPDATES)
    fail('结果谱超出当前确定性计算预算，请核对高潜能和溢出份数。');
  return parsed.normalized;
}

export function lossDraws(weapon) {
  const loss = weapon.lossDraws;
  if (loss == null) return 0;
  if (!isInt(loss) || loss < 0 || loss > 30000) fail('亏损抽数须为非负整数。');
  if (isInt(weapon.N) && isInt(weapon.KU) && loss > weapon.N - weapon.KU)
    fail('扣除亏损后，剩余抽数不能少于抽出的当期专武数。');
  return loss;
}

function reference(axis) {
  if (references.has(axis)) return references.get(axis);
  const source = WEAPON_REFERENCE_DATA[axis], rows = source.rows;
  const prefix = new Float64Array(rows.length + 1), suffix = new Float64Array(rows.length + 1);
  for (let i = 0; i < rows.length; i++) prefix[i + 1] = prefix[i] + rows[i][2];
  for (let i = rows.length - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + rows[i][2];
  const result = {...source, prefix, suffix};
  references.set(axis, result);
  return result;
}

function rawAxisResult(draws, count, ref) {
  let less = null, equal = null, greater = null, score = null;
  if (draws) {
    const rows = ref.rows;
    let low = 0, high = rows.length;
    // Integer cross-products preserve rational ties; current input limits keep
    // all products exactly representable as JavaScript safe integers.
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (rows[mid][0] * draws < count * rows[mid][1]) low = mid + 1;
      else high = mid;
    }
    const left = low;
    const tied = left < rows.length && rows[left][0] * draws === count * rows[left][1];
    const right = left + (tied ? 1 : 0);
    less = Math.min(1, ref.prefix[left]);
    equal = tied ? rows[left][2] : 0;
    greater = Math.min(1, ref.suffix[right]);
    score = Math.min(100, Math.max(0, 100 * (less + equal / 2)));
  }
  return {
    count, rate: draws ? count / draws : null, score, p_less: less, p_equal: equal, p_greater: greater,
    reference_expected_rate: ref.expected_rate, reference_expected_count: ref.expected_count,
    reference_expected_draws: ref.expected_draws,
  };
}

/** Score raw facts without mutating them; loss draws affect only signature. */
export function scoreWeaponRecord(weapon) {
  if (!isObject(weapon) || ['N', 'K6', 'KU'].some(name => !isInt(weapon[name])))
    fail('武器抽数、六星数或专武数未识别完整。');
  const n = weapon.N, six = weapon.K6, up = weapon.KU;
  if (n <= 0 || n > 30000) fail('当前工具支持1至30000次武器抽取。');
  if (!(0 <= up && up <= six && six <= n)) fail('原始武器数量须满足0 ≤ 专武数 ≤ 六星数 ≤ 总抽数。');
  const individual = weapon.allowIndividualDraws === true;
  if (n % 10 && !individual) fail('截图武器总抽数须为10的倍数；单次申领记录须有明确标记。');
  let loss = 0, lossError = null;
  try { loss = lossDraws(weapon); } catch (error) { lossError = error.message; }
  const signatureN = n - loss, profile = validatedProfile(weapon);
  let result;
  if (profile) {
    result = scoreWeaponProfile(n, six, up, profile, {allowIndividualDraws: individual, lossDraws: loss});
    result.mode = 'potential-profile';
  } else {
    result = {
      version: WEAPON_VERSION, mode: 'raw-totals', reference: 'first_signature_ten_boundary_completed_pools_ratio',
      reference_pools: 10, total_draws: n, method: '100*(P(reference_ratio<observed_ratio)+0.5*P(equal))',
      raw_input: {N: n, K6: six, KU: up},
      six_star: rawAxisResult(n, six, reference('six_star')),
      signature: rawAxisResult(signatureN, up, reference('signature')), warnings: [],
    };
    for (const [key, count] of [['six_star', six], ['signature', up]])
      Object.assign(result[key], {raw_count: count, effective_count: count, gifts: 0});
  }
  result.six_star.total_draws = n;
  result.signature.total_draws = signatureN;
  result.averageEstimate = null;
  result.routingVersion = WEAPON_VERSION;
  result.lossDraws = loss;
  if (lossError || !signatureN) result.signature = {score: null, reason: lossError || '扣除亏损后没有可评分的专武抽数。'};
  return result;
}
