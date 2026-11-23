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

test('信物明细缺失时只影响 UP', () => {
  const record = tokenRecord();
  const verified = scoreCharacterFlatABC(record);
  delete record.pools[0].tokens;
  const missing = scoreCharacterFlatABC(record);
  assert.equal(missing.axes.up.status, 'unscored');
  assert.match(missing.axes.up.reason, /信物/);
  assert.deepEqual(missing.axes.characterSix, verified.axes.characterSix);
  assert.deepEqual(missing.axes.limited, verified.axes.limited);
});

test('限定基础分不依赖图鉴，加急独立记账', () => {
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
  assert.deepEqual(repeat.axes.limited.details.groups, first.axes.limited.details.groups);
  assert.equal(repeat.axes.limited.details.baseScore, first.axes.limited.details.baseScore);
  assert.equal(first.axes.limited.details.newAdjustment.observed, 2);
  assert.ok(first.axes.limited.score > first.axes.limited.details.baseScore);
  assert.equal(repeat.axes.limited.details.newAdjustment.status, 'no-opportunity');
  assert.equal(repeat.axes.limited.score, repeat.axes.limited.details.baseScore);
  assert.deepEqual(first.actual.C, {draws: 10, paid: 0, six: 1, up: 0, limited: 1});
  assert.equal(first.actual.A.limited, 2);
  assert.equal(first.axes.limited.details.groups.C[0].details.rate, .008 * 9 / 14);
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
