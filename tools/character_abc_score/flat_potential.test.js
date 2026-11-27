'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {replayLimitedPotential} = require('./flat_potential');

function pool(index, off, entries, rushAt = null, rush = []) {
  return {index, off, events: entries.map(([at, id]) => ({at, id})), rushAt, rush};
}

test('已确认的 240 信物只推进潜能，之后的满潜歪出不计限定', () => {
  const prepared = {initialOwnedMask: 0, pools: [
    pool(0, [1, 2], [[20, 0], [40, 0], [65, 0], [100, 0], [165, 0]]),
    pool(1, [0, 2], [[4, 0], [30, 1], [45, 1], [70, 0]], 30, [0, 1, 2]),
  ]};

  const [first, later] = replayLimitedPotential(prepared, [[240], []]);
  assert.equal(first.a + first.b + first.c, 5);
  assert.deepEqual([later.a, later.b, later.c, later.saturatedOff], [1, 1, 2, 3]);
  assert.deepEqual(later.aContext.remaining, [0, 6]);
  assert.deepEqual(later.cRemaining, [0, 6]);

  const [, unconfirmed] = replayLimitedPotential(prepared, [null, []]);
  assert.deepEqual([unconfirmed.a, unconfirmed.b, unconfirmed.c, unconfirmed.saturatedOff], [2, 1, 2, 2]);
  assert.deepEqual(unconfirmed.aContext.remaining, [1, 6]);
});

test('同进度首主池 UP 先计入 A，加急在 B 第 0 抽更新剩余份数', () => {
  const prepared = {initialOwnedMask: 1 << 1, pools: [
    pool(0, [1, 2], [[8, 1], [16, 1], [24, 1], [29, 1], [30, 0], [31, 1], [32, 0]], 30, [1, 1, 0]),
  ]};

  const [observed] = replayLimitedPotential(prepared, [[]]);
  assert.deepEqual(observed, {
    a: 5, b: 1, c: 2, saturatedOff: 2,
    aContext: {remaining: [5, 6], grantAt: null, grants: [0, 0]},
    bContext: {remaining: [1, 6], grantAt: 0, grants: [2, 0]},
    cRemaining: [1, 6],
  });
});

test('首主池 UP 前的加急会即时影响 A 的后续歪出和 B 的期初状态', () => {
  const prepared = {initialOwnedMask: 1 << 1, pools: [
    pool(0, [1, 2], [[8, 1], [16, 1], [24, 1], [29, 1], [31, 1], [32, 0]], 30, [1]),
  ]};

  const [observed] = replayLimitedPotential(prepared, [[]]);
  assert.deepEqual([observed.a, observed.b, observed.c, observed.saturatedOff], [5, 0, 1, 1]);
  assert.deepEqual(observed.aContext, {remaining: [5, 6], grantAt: 30, grants: [1, 0]});
  assert.deepEqual(observed.bContext, {remaining: [0, 6], grantAt: null, grants: [0, 0]});
  assert.deepEqual(observed.cRemaining, [1, 6]);
});

test('当期 UP 已满潜时，主池和加急继续算有效限定产出', () => {
  const prepared = {initialOwnedMask: 0, pools: [
    pool(0, [1, 2], [[10, 0], [20, 0], [30, 0], [40, 0], [50, 0], [60, 0], [70, 0]], 80, [0]),
  ]};

  const [observed] = replayLimitedPotential(prepared, [[]]);
  assert.deepEqual([observed.a, observed.b, observed.c, observed.saturatedOff], [1, 6, 1, 0]);
});
