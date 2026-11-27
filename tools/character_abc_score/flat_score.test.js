'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {LIMITED, COMMON} = require('../gacha_rating_app/character_ledger');
const {scoreCharacterFlatABC, scoreCharacterFlatB} = require('./flat_score');

function pool(index, total, events, fields = {}) {
  return {index, total, rushUsed: false, events: events.map(([at, character]) => ({at, character})), ...fields};
}

function tokenRecord() {
  return {initialPity: 0, initialOwned: [], completeHistory: true, pools: [
    pool(0, 250, [[20, LIMITED[0]], [80, COMMON[0]], [150, COMMON[0]], [220, COMMON[0]]], {tokens: [{at: 240}]}),
    pool(1, 30, [[30, LIMITED[1]]]),
  ]};
}

function referenceWeightedScore(parts) {
  const weight = parts.reduce((sum, part) => sum + part.weight, 0);
  assert.ok(weight > 0);
  return parts.reduce((sum, part) => sum + part.score * part.weight, 0) / weight;
}

function assertOutputWeighted(axis, weights) {
  assert.equal(axis.status, 'scored');
  assert.deepEqual(axis.details.groupWeights, weights);
  let total = 0;
  let output = 0;
  for (const [zone, count] of Object.entries(weights)) {
    if (!count) continue;
    total += count * referenceWeightedScore(axis.details.groups[zone]);
    output += count;
  }
  const score = axis.details.baseScore ?? axis.score;
  assert.ok(Math.abs(score - total / output) < 1e-10);
}

test('计入 UP 的 240 信物只改变当期 UP 的成本边界', () => {
  const {actual, axes} = scoreCharacterFlatABC(tokenRecord());
  assert.equal(axes.up.status, 'scored');
  assert.equal(axes.limited.status, 'scored');
  assert.equal(axes.characterSix.status, 'scored');
  assert.equal(actual.byAxis.up.B.paid, 220);
  assert.equal(actual.byAxis.up.B.up, 1);
  assert.deepEqual(actual.byAxis.up.transfers, [{from: 0, to: 1, draws: 10, paid: 10}]);
  assert.equal(actual.A.paid, 50);
  assert.equal(actual.B.paid, 200);
  assert.equal(actual.B.six, 3);
  assert.equal(actual.B.limited, 0);
  assert.deepEqual(actual.transfers, [{from: 0, to: 1, draws: 30, paid: 30}]);
});

test('信物明细缺失时保留六星与限定分，限定只按已确认的份数参照', () => {
  const record = tokenRecord();
  const verified = scoreCharacterFlatABC(record);
  delete record.pools[0].tokens;
  const missing = scoreCharacterFlatABC(record);
  assert.equal(missing.axes.up.status, 'unscored');
  assert.match(missing.axes.up.reason, /信物/);
  assert.deepEqual(missing.axes.characterSix, verified.axes.characterSix);
  assert.equal(missing.axes.limited.status, 'scored');
  assert.equal(missing.actual.A.limited, verified.actual.A.limited);
  assert.equal(missing.actual.B.limited, verified.actual.B.limited);
});

test('图鉴只影响限定参照和 New，加急独立记账', () => {
  const record = {initialPity: 0, initialOwned: [], pools: [
    pool(0, 59, [[27, LIMITED[1]], [59, LIMITED[0]]], {
      rushUsed: true, rush: [{character: LIMITED[2]}],
    }),
  ]};
  const first = scoreCharacterFlatABC(record);
  record.initialOwned = [LIMITED[1], LIMITED[2]];
  const repeat = scoreCharacterFlatABC(record);
  assert.deepEqual(repeat.actual, first.actual);
  assert.deepEqual(repeat.axes.characterSix, first.axes.characterSix);
  assert.deepEqual(repeat.axes.up, first.axes.up);
  assert.ok(Number.isFinite(repeat.axes.limited.details.baseScore));
  assert.equal(first.axes.limited.details.newAdjustment.observed, 2);
  assert.ok(first.axes.limited.score > first.axes.limited.details.baseScore);
  assert.equal(repeat.axes.limited.details.newAdjustment.status, 'no-opportunity');
  assert.equal(repeat.axes.limited.score, repeat.axes.limited.details.baseScore);
  assert.deepEqual(first.actual.C, {draws: 10, paid: 0, six: 1, up: 0, limited: 1});
  assert.equal(first.actual.A.limited, 2);
  assert.equal(first.axes.limited.details.groups.C[0].details.observed, 1);
});

test('歪 New 低于中性时按原分余量扣分，未知图鉴仍返回基础分', () => {
  const record = tokenRecord();
  const result = scoreCharacterFlatABC(record);
  const axis = result.axes.limited;
  const {baseScore, newAdjustment} = axis.details;
  assert.equal(newAdjustment.status, 'scored');
  assert.equal(newAdjustment.observed, 0);
  assert.ok(newAdjustment.score < 50);
  assert.equal(newAdjustment.weight, .20 * newAdjustment.expected / (1 + newAdjustment.expected));
  assert.equal(axis.score, baseScore + newAdjustment.delta);
  assert.ok(newAdjustment.delta < 0 && newAdjustment.delta >= -20);
  assert.ok(axis.score >= 0 && axis.score <= 100);
  delete record.initialOwned;
  const unavailable = scoreCharacterFlatABC(record).axes.limited;
  assert.equal(unavailable.details.newAdjustment.status, 'unavailable');
  assert.equal(unavailable.score, baseScore);
  assert.equal(unavailable.details.newAdjustment.weight, 0);
});

test('跨过未抽的池继承尾水，最后一池未继承的尾抽待结算', () => {
  const record = {initialPity: 0, completeHistory: true, pools: [
    pool(0, 60, [[50, LIMITED[0]]]),
    pool(1, 0, []),
    pool(2, 60, [[30, LIMITED[2]]]),
  ]};
  const {actual} = scoreCharacterFlatABC(record);
  assert.deepEqual(actual.transfers, [{from: 0, to: 2, draws: 10, paid: 10}]);
  assert.deepEqual(actual.pending, [{from: 2, draws: 30, paid: 30}]);
  assert.equal(actual.A.draws + actual.B.draws + actual.pending[0].draws, 120);
});

test('只抽 60 且未拿首 UP 时仍有 A 区结果', () => {
  const result = scoreCharacterFlatABC({initialPity: 0, pools: [pool(0, 60, [])]});
  for (const axis of Object.values(result.axes)) {
    assert.equal(axis.status, 'scored');
    assert.ok(axis.score < 50);
    assert.equal(axis.details.groups.B.length, 0);
  }
  assert.equal(result.actual.A.paid, 50);
});

test('同产出下未完成 A 的消耗也参与总成本比较', () => {
  const record = {initialPity: 0, completeHistory: true, pools: [
    pool(0, 11, [[11, LIMITED[0]]]),
  ]};
  const finished = scoreCharacterFlatABC(record);
  record.pools.push(pool(1, 60, []));
  const attempted = scoreCharacterFlatABC(record);
  assert.equal(attempted.actual.A.paid, 51);
  for (const key of Object.keys(finished.axes)) {
    assert.equal(attempted.axes[key].details.groups.A[0].details.observedPaid, 51);
    assert.ok(attempted.axes[key].details.groups.A[0].score < finished.axes[key].details.groups.A[0].score);
  }
});

test('B 区独立评分复现整轴的 B 部分，且不受加急出货影响', () => {
  const record = tokenRecord();
  const whole = scoreCharacterFlatABC(record);
  const bOnly = scoreCharacterFlatB(record);
  assert.equal(bOnly.scope, 'B');
  for (const key of Object.keys(bOnly.axes)) {
    assert.deepEqual(Object.keys(bOnly.axes[key].details.groups), ['B']);
    assert.deepEqual(bOnly.axes[key].details.groups.B, whole.axes[key].details.groups.B);
  }
  record.pools[0].rushUsed = true;
  record.pools[0].rush = [{character: LIMITED[0]}];
  assert.deepEqual(scoreCharacterFlatB(record).axes, bOnly.axes);
  assert.notEqual(scoreCharacterFlatABC(record).axes.up.score, whole.axes.up.score);
});

test('UP 总分以各区实得份数加权，保留零出货的独立分', () => {
  const record = tokenRecord();
  record.pools[0].rushUsed = true;
  record.pools[1] = pool(1, 60, [[30, LIMITED[1]], [60, COMMON[0]]]);
  const missed = scoreCharacterFlatABC(record).axes.up;
  const {A, B, C} = missed.details.groups;
  assert.deepEqual(missed.details.groupWeights, {A: 2, B: 1, C: 0});
  assert.equal(B.length, 2);
  assert.ok(Number.isFinite(C[0].score));
  assert.equal(C[0].weight, .04);
  const bScore = B.reduce((sum, part) => sum + part.score * part.weight, 0) /
    B.reduce((sum, part) => sum + part.weight, 0);
  assert.ok(Math.abs(missed.score - (2 * A[0].score + bScore) / 3) < 1e-10);

  record.pools[0].rush = [{character: LIMITED[0]}];
  const hit = scoreCharacterFlatABC(record).axes.up;
  assert.deepEqual(hit.details.groupWeights, {A: 2, B: 1, C: 1});
  assert.deepEqual(hit.details.groups.A, A);
  assert.deepEqual(hit.details.groups.B, B);
  assert.ok(Math.abs(hit.score - (2 * A[0].score + bScore + hit.details.groups.C[0].score) / 4) < 1e-10);
});

test('三轴全区零产出时按参照权重保留未出货评分', () => {
  const record = {initialPity: 0, pools: [pool(0, 30, [], {rushUsed: true})]};
  const {axes} = scoreCharacterFlatABC(record);
  for (const axis of Object.values(axes)) {
    assert.equal(axis.status, 'scored');
    const {A, B, C} = axis.details.groups;
    assert.equal(A.length, 1);
    assert.equal(B.length, 0);
    assert.equal(C.length, 1);
    assert.equal(axis.details.groupWeights, undefined);
    assert.ok(Math.abs(axis.score - referenceWeightedScore([...A, ...C])) < 1e-10);
    assert.equal(axis.details.weight, A[0].weight + C[0].weight);
  }
});

test('三轴有产出时，使用加急而未出货仍显示独立分，合分与未使用加急一致', () => {
  const record = tokenRecord();
  const absent = scoreCharacterFlatABC(record).axes;
  record.pools[0].rushUsed = true;
  const missed = scoreCharacterFlatABC(record).axes;
  const weights = {characterSix: {A: 2, B: 3, C: 0}, up: {A: 2, B: 1, C: 0}, limited: {A: 2, B: 0, C: 0}};
  for (const key of Object.keys(weights)) {
    assertOutputWeighted(absent[key], weights[key]);
    assertOutputWeighted(missed[key], weights[key]);
    assert.equal(absent[key].details.groups.C.length, 0);
    assert.equal(missed[key].details.groups.C.length, 1);
    assert.ok(Number.isFinite(missed[key].details.groups.C[0].score));
    assert.ok(missed[key].details.groups.C[0].weight > 0);
    assert.equal(missed[key].score, absent[key].score);
  }
  const {groups, weight} = missed.characterSix.details;
  const reference = Object.values(groups).flat().reduce((sum, part) => sum + part.weight, 0);
  assert.equal(weight, reference);
  assert.notEqual(weight, 5);
});

test('平铺完成首 UP 就停，没有 B 区可结算', () => {
  const record = {initialPity: 0, pools: [pool(0, 30, [[30, LIMITED[0]]])]};
  const result = scoreCharacterFlatB(record);
  for (const axis of Object.values(result.axes)) {
    assert.equal(axis.status, 'unscored');
    assert.equal(axis.score, null);
    assert.match(axis.reason, /没有可结算的 B 区/);
  }
});

test('三轴按实得份数共享 B 停手规则，零限定也参与同产出比较', () => {
  const result = scoreCharacterFlatB(tokenRecord());
  for (const key of ['characterSix', 'up', 'limited']) {
    const [part] = result.axes[key].details.groups.B;
    assert.equal(part.details.method, 'b-matched-stop-same-output-permanent-cost-dp');
    assert.equal(part.details.pools[0].target, 1);
  }
  const [limited] = result.axes.limited.details.groups.B;
  assert.equal(limited.details.output, 0);
  assert.ok(limited.weight > 0);
});

test('未再拿 UP 的 B 使用已观察窗口，而 UP 保留未出分支', () => {
  const record = {initialPity: 0, pools: [pool(0, 2, [[1, LIMITED[0]], [2, COMMON[0]]], {freeAllowance: 0})]};
  const {axes} = scoreCharacterFlatB(record);
  assert.equal(axes.characterSix.score, 50);
  assert.equal(axes.characterSix.details.groups.B[0].details.pools[0].window, 1);
  assert.equal(axes.up.details.groups.B[0].details.method, 'b-unfinished-no-output-survival-dp');
  assert.equal(axes.limited.details.groups.B[0].details.output, 0);
});

test('确认信物满潜后，A、B、C 的溢出歪出均按常驻比较', () => {
  const record = {initialPity: 0, initialOwned: [], completeHistory: true, pools: [
    pool(0, 240, [5, 40, 80, 120, 180].map(at => [at, LIMITED[0]]), {tokens: [{at: 240}]}),
    pool(1, 60, [[5, LIMITED[0]], [10, LIMITED[1]], [35, LIMITED[0]], [60, LIMITED[1]]], {
      rushUsed: true, rush: [{character: LIMITED[0]}, {character: LIMITED[1]}],
    }),
  ]};
  const saturated = scoreCharacterFlatABC(record);
  assert.equal(saturated.actual.saturatedOffLimited, 3);
  assert.equal(saturated.actual.A.limited, 2);
  assert.equal(saturated.actual.B.limited, 5);
  assert.equal(saturated.actual.C.limited, 1);
  assert.equal(saturated.actual.C.six, 2);
  assert.equal(saturated.actual.byAxis.up.B.up, 6);
  assertOutputWeighted(saturated.axes.characterSix, {A: 3, B: 6, C: 2});
  assertOutputWeighted(saturated.axes.up, {A: 2, B: 6, C: 1});
  assertOutputWeighted(saturated.axes.limited, {A: 2, B: 5, C: 1});
  const common = structuredClone(record);
  for (const event of [...common.pools[1].events, ...common.pools[1].rush]) {
    if (event.character === LIMITED[0]) event.character = COMMON[0];
  }
  const scores = scoreCharacterFlatABC(common);
  for (const key of Object.keys(scores.axes)) {
    assert.equal(saturated.axes[key].status, 'scored');
    assert.ok(Math.abs(saturated.axes[key].score - scores.axes[key].score) < 1e-10);
  }
});

test('两名可歪角色都满潜时，限定加急参照只计算当期 UP', () => {
  const record = {initialPity: 0, initialOwned: [], completeHistory: true, pools: [
    pool(0, 6, Array.from({length: 6}, (_, i) => [i + 1, LIMITED[0]])),
    pool(1, 6, Array.from({length: 6}, (_, i) => [i + 1, LIMITED[1]])),
    pool(2, 30, [[1, LIMITED[2]]], {rushUsed: true, rush: [{character: LIMITED[0]}, {character: LIMITED[1]}]}),
  ]};
  const result = scoreCharacterFlatABC(record);
  assert.deepEqual(result.actual.C, {draws: 10, paid: 0, six: 2, up: 0, limited: 0});
  const c = result.axes.limited.details.groups.C[0];
  assert.ok(Math.abs(c.weight - .04) < 1e-12);
  assert.ok(Math.abs(c.score - 50 * (1 - .004) ** 10) < 1e-10);
});
