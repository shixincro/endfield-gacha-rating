'use strict';

const {BANNERS, COMMON, LIMITED} = require('../gacha_rating_app/character_ledger');

const RATING_AXES = new Set(['characterSix', 'up', 'limited']);

class FlatInputError extends Error {}

function requireInput(condition, message) {
  if (!condition) throw new FlatInputError(message);
}

function integer(value, min, max) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

function nameOf(name) {
  return name === '俊卫' ? '骏卫' : name;
}

function offIndices(index) {
  if (index === 0) return [1, 2];
  if (index === 1) return [0, 2];
  return [index - 1, index - 2];
}

function validateIssues(issues, label) {
  const blocker = Array.isArray(issues) && issues.find(issue =>
    issue?.severity === 'error' &&
    (!Array.isArray(issue.axes) || issue.axes.some(axis => RATING_AXES.has(axis))));
  requireInput(!blocker, blocker ? label + '存在待处理的评分冲突：' + (blocker.message || blocker.code || '未提供详情') : '');
}

function validateInterruptionProjection(record) {
  const excluded = record.interruptionCorrection?.excludedIndices ?? [];
  requireInput(Array.isArray(excluded) && excluded.every(index => integer(index, 0, LIMITED.length - 1)),
    '中断修正的排除卡池编号无效');
  for (const index of excluded) {
    const next = record.pools.find(pool => pool?.index > index);
    requireInput(!record.pools.some(pool => pool?.index === index) && (!next || next.interruptionBefore === true),
      '账本带有尚未应用的中断修正，请传入已应用修正的角色范围');
  }
}

function characterId(name, label, index, off) {
  const normalized = nameOf(name);
  if (COMMON.includes(normalized)) return -1;
  const id = LIMITED.indexOf(normalized);
  requireInput(id === index || off.includes(id), label + '有未知或不属于当期池的六星角色');
  return id;
}

function paymentPrefix(pool, previous, carry, knownGap, label) {
  let allowance = pool.freeAllowance;
  if (allowance != null) {
    requireInput([0, 10, 20].includes(allowance), label + '的免费额度须为 0、10 或 20 抽');
  } else if (carry && !knownGap) {
    allowance = previous.total >= 60 ? 20 : 10;
  } else if (pool.index === 0 || knownGap) {
    allowance = 10;
  }

  const declared = pool.freeDrawPositions;
  let freePositions;
  if (declared != null) {
    requireInput(Array.isArray(declared) && declared.length <= 20 &&
      new Set(declared).size === declared.length &&
      declared.every(position => integer(position, 1, pool.total)) &&
      (allowance == null || declared.length === Math.min(allowance, pool.total)),
    label + '的免费抽位置与已知投入或额度不符');
    freePositions = new Set(declared);
  } else {
    requireInput(allowance != null || pool.total === 0, label + '的免费额度不明，请先补充');
  }

  const prefix = new Uint32Array(pool.total + 1);
  for (let at = 1; at <= pool.total; at++) {
    const isFree = freePositions ? freePositions.has(at) : at <= allowance;
    prefix[at] = prefix[at - 1] + Number(!isFree);
  }
  return prefix;
}

function readMain(pool, openingPity, off, label) {
  requireInput(Array.isArray(pool.events), label + '缺少主池出货列表');
  let lastAt = 0;
  let pity = openingPity;
  let seenUp = false;
  const events = [];
  for (const event of pool.events) {
    requireInput(event && integer(event.at, lastAt + 1, pool.total) &&
      (event.source == null || event.source === 'main'), label + '的主池出货位置或来源无效');
    requireInput(pity + event.at - lastAt <= 80, label + '在第 ' + event.at + ' 抽之前已越过六星 80 保底');
    const forced = !seenUp && event.at === 120;
    const id = characterId(event.character, label, pool.index, off);
    requireInput(seenUp || event.at < 120 || (forced && id === pool.index),
      label + '缺少第 120 抽的强制当期 UP');
    requireInput(event.forced == null || event.forced === forced,
      label + '的第 ' + event.at + ' 抽强制标记不符合 120 保障规则');
    events.push({at: event.at, id});
    seenUp ||= id === pool.index;
    lastAt = event.at;
    pity = 0;
  }
  requireInput(seenUp || pool.total < 120, label + '缺少第 120 抽的强制当期 UP');
  const tail = pity + pool.total - lastAt;
  requireInput(tail < 80, label + '的未出尾段越过六星 80 保底');
  requireInput(pool.tail == null || pool.tail === tail, label + '的期末水位与出货列表不符');
  return {events, tail};
}

function readRush(pool, off, label) {
  const supplied = pool.rush ?? [];
  requireInput(Array.isArray(supplied) && supplied.length <= 10, label + '的加急六星列表无效');
  requireInput(typeof pool.rushUsed === 'boolean' || (pool.rushUsed == null && pool.total < 30 && !supplied.length),
    label + '是否使用加急尚未确认');
  if (!pool.rushUsed) {
    requireInput(!supplied.length, label + '有加急出货但未使用加急');
    return {rushAt: null, rush: []};
  }
  const rushAt = pool.rushAt ?? 30;
  requireInput(integer(rushAt, 30, pool.total), label + '的加急必须在第 30 主抽或之后使用');
  const rush = supplied.map(event => {
    requireInput(event && (event.source == null || event.source === 'rush') && event.forced !== true,
      label + '的加急事件来源或保底标记无效');
    return characterId(event.character, label, pool.index, off);
  });
  return {rushAt, rush};
}

function prepare(input) {
  const ledger = input?.ledger ?? input;
  const record = ledger?.character ?? ledger;
  requireInput(Array.isArray(record?.pools) && record.pools.length > 0, '需要含有卡池的角色账本');
  validateInterruptionProjection(record);
  validateIssues(ledger?.character ? ledger.issues : null, '账本');
  validateIssues(record.issues, '角色账本');
  requireInput(record.initialOwned == null || Array.isArray(record.initialOwned), '期初图鉴无效');
  let initialOwnedMask = 0;
  for (const name of record.initialOwned ?? []) {
    const id = LIMITED.indexOf(nameOf(name));
    requireInput(id >= 0 || COMMON.includes(nameOf(name)), '期初图鉴中有未知六星角色');
    if (id >= 0) initialOwnedMask |= 1 << id;
  }
  let includeNew = Array.isArray(record.initialOwned);

  const pools = [];
  const seenIds = new Set();
  let previousTail = null;
  let totalMain = 0;
  let totalPaid = 0;
  let totalRush = 0;
  for (const pool of record.pools) {
    requireInput(pool && integer(pool.index, 0, LIMITED.length - 1), '卡池编号超出已支持的常规池范围');
    const label = BANNERS[pool.index];
    const previous = pools.at(-1);
    requireInput(!previous || pool.index > previous.index, label + '的卡池序号重复或倒序');
    requireInput(pool.up == null || nameOf(pool.up) === LIMITED[pool.index], label + '不符合常规池 UP 名单');
    requireInput(integer(pool.total, 0, 30000 - totalMain), label + '的主池抽数无效或总抽数超过上限');
    requireInput(pool.complete !== false, label + '的主池记录有缺段');
    validateIssues(pool.issues, label);

    const id = pool.id ?? pool.index;
    requireInput((typeof id === 'string' || Number.isSafeInteger(id)) && !seenIds.has(id), label + '的卡池 ID 无效或重复');
    seenIds.add(id);
    const adjacent = previous != null && pool.index === previous.index + 1;
    const carry = previous != null && pool.interruptionBefore !== true && (adjacent || record.completeHistory === true);
    const knownGap = carry && !adjacent;
    const recordOpening = previous || pool.interruptionBefore === true ? null : record.initialPity;
    const openingPity = carry ? null : pool.initialPity ?? recordOpening;
    const actualOpening = carry ? previousTail : openingPity;
    requireInput(integer(actualOpening, 0, 79), label + '的期初水位未知或越界');
    if (carry && pool.initialPity != null) {
      requireInput(pool.initialPity === previousTail, label + '的期初水位和前池期末水位不符');
    }
    if (!previous && pool.interruptionBefore !== true && pool.initialPity != null && record.initialPity != null) {
      requireInput(pool.initialPity === record.initialPity, label + '的期初水位与账本不符');
    }
    if (pool.interruptionBefore === true || (previous && !carry)) includeNew = false;

    const paidPrefix = paymentPrefix(pool, previous, carry, knownGap, label);
    const off = offIndices(pool.index);
    const {events, tail} = readMain(pool, actualOpening, off, label);
    const {rushAt, rush} = readRush(pool, off, label);
    pools.push({id, index: pool.index, total: pool.total, off, paidPrefix, rushAt, rush, events, carry, openingPity});
    previousTail = tail;
    totalMain += pool.total;
    totalPaid += paidPrefix[pool.total];
    if (rushAt != null) totalRush += 10;
  }

  return {initialPity: pools[0].openingPity, initialOwnedMask, includeNew, pools, totalMain, totalPaid, totalRush};
}

function emptyPhase() {
  return {draws: 0, paid: 0, six: 0, up: 0, limited: 0};
}

function replay(prepared,{trackNewOpportunity=false}={}) {
  const A = emptyPhase(), B = emptyPhase(), C = emptyPhase();
  const transfers = [];
  let endPity = prepared.initialPity;
  let owned = prepared.initialOwnedMask;
  let previous = null;
  let bTail = 0;
  const newOpportunity = trackNewOpportunity && prepared.includeNew
    ? {eligibleSix:0,oneCandidateSix:0,twoCandidateSix:0,expectedNew:0,actualNew:0}
    : null;

  function recordHit(part, id, pool, forced=false) {
    const isNew = prepared.includeNew && id >= 0 && id !== pool.index && !(owned & (1 << id));
    if (newOpportunity && !forced) {
      // Measure the chance before the hit updates the shared collection.
      const [first, second] = pool.off;
      const candidates = Number(!(owned & (1 << first))) + Number(!(owned & (1 << second)));
      if (candidates > 0) newOpportunity.eligibleSix++;
      if (candidates === 1) newOpportunity.oneCandidateSix++;
      else if (candidates === 2) newOpportunity.twoCandidateSix++;
      if (isNew) newOpportunity.actualNew++;
    }
    part.six++;
    if (id === pool.index) part.up++;
    if (id < 0) return;
    const bit = 1 << id;
    part.limited += isNew ? 2 : 1;
    owned |= bit;
  }

  for (const pool of prepared.pools) {
    if (!pool.carry) {
      endPity = pool.openingPity;
    } else if (bTail > 0) {
      const paid = previous.paidPrefix[previous.total] - previous.paidPrefix[previous.total - bTail];
      A.draws += bTail;
      A.paid += paid;
      B.draws -= bTail;
      B.paid -= paid;
      transfers.push({from: previous.id, to: pool.id, draws: bTail, paid});
    }

    const firstUp = pool.events.find(event => event.id === pool.index);
    const lastA = firstUp?.at ?? pool.total;
    A.draws += lastA;
    A.paid += pool.paidPrefix[lastA];
    B.draws += pool.total - lastA;
    B.paid += pool.paidPrefix[pool.total] - pool.paidPrefix[lastA];

    let pendingRush = pool.rushAt != null;
    const settleRush = () => {
      C.draws += 10;
      for (const id of pool.rush) recordHit(C, id, pool);
      pendingRush = false;
    };
    for (const event of pool.events) {
      if (pendingRush && pool.rushAt < event.at) settleRush();
      recordHit(event.at <= lastA ? A : B, event.id, pool, event === firstUp && event.at === 120);
    }
    if (pendingRush) settleRush();

    const lastHit = pool.events.at(-1);
    endPity = lastHit ? pool.total - lastHit.at : endPity + pool.total;
    bTail = firstUp ? endPity : 0;
    previous = pool;
  }
  if (newOpportunity) {
    newOpportunity.expectedNew = (newOpportunity.oneCandidateSix + 2 * newOpportunity.twoCandidateSix) / 14;
  }
  return {A, B, C, transfers, endPity,...(trackNewOpportunity?{newOpportunity}:{})};
}

module.exports = {prepare, replay, FlatInputError};
