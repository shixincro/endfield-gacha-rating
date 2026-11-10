import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {scoreWeaponRecord, profileFromTable} from '../core/weapon-scoring.js';
import {clearWeaponProfileCache, erfc, parseProfile, referenceProfileMoments, scoreWeaponProfile} from '../core/weapon-profile.js';

const oracle = JSON.parse(readFileSync(new URL('./weapon-oracle.json', import.meta.url), 'utf8'));

function equivalent(actual, expected, location = '') {
  if (typeof expected === 'number') {
    assert.equal(typeof actual, 'number', location);
    assert.ok(Number.isFinite(actual), location);
    // DP paths use a different summation order. This permits only Float64
    // rounding: scores retain nine decimal places, moments eleven relative.
    const tolerance = /score$/u.test(location) ? 1e-9 : 2e-10 + 2e-11 * Math.abs(expected);
    assert.ok(Math.abs(actual - expected) <= tolerance,
      `${location}: ${actual} versus ${expected}; error=${Math.abs(actual - expected)}`);
  } else if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), location);
    assert.equal(actual.length, expected.length, location);
    expected.forEach((value, index) => equivalent(actual[index], value, `${location}[${index}]`));
  } else if (expected && typeof expected === 'object') {
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), location);
    for (const key of Object.keys(expected)) equivalent(actual[key], expected[key], `${location}.${key}`);
  } else assert.equal(actual, expected, location);
}

test('normal-tail mapping agrees with Python math.erfc, including tiny tails', () => {
  for (const [x, expected] of oracle.erfc) {
    const actual = erfc(x);
    assert.ok(Math.abs(actual - expected) <= 4e-14 * Math.max(expected, 1e-300),
      `erfc(${x}): ${actual} != ${expected}`);
  }
});

for (const [index, row] of oracle.records.entries()) {
  test(`Python parity: synthetic weapon record ${index + 1}`, () => {
    const before = JSON.stringify(row.input);
    if (row.error) assert.throws(() => scoreWeaponRecord(row.input), error => error.message === row.error);
    else equivalent(scoreWeaponRecord(row.input), row.expected, `record[${index}]`);
    assert.equal(JSON.stringify(row.input), before, 'does not mutate raw inputs');
  });
}

for (const row of oracle.profiles) {
  test(`Python exact-moment parity: ${row.input}`, () => {
    equivalent(parseProfile(row.input), row.parsed);
    equivalent(referenceProfileMoments(row.input), row.moments);
  });
}

test('loss draws improve only signature score and do not change six-star reference', () => {
  for (const profile of [undefined, '12 5 1']) {
    const record = {N: 1000, K6: 55, KU: 15, ...(profile ? {profile} : {})};
    const full = scoreWeaponRecord(record), reduced = scoreWeaponRecord({...record, lossDraws: 117});
    assert.deepEqual(full.six_star, reduced.six_star);
    assert.ok(reduced.signature.score > full.signature.score);
    assert.equal(full.signature.total_draws - reduced.signature.total_draws, 117);
  }
});

test('grouped potentials retain operand roles and independent target covariances', () => {
  assert.deepEqual(parseProfile('11 5*7'), parseProfile('11 5 5 5 5 5 5 5'));
  assert.notDeepEqual(referenceProfileMoments('11 5*7'), referenceProfileMoments('11 7*5'));
  const one = referenceProfileMoments('1 5'), two = referenceProfileMoments('2 5 5');
  equivalent(two.mean, one.mean.map(v => 2 * v));
  equivalent(two.covariance, one.covariance.map(row => row.map(v => 2 * v)));
});

test('full potentials require explicit distribution of multiple overflow groups', () => {
  assert.throws(() => profileFromTable({totalTypes: 2, counts: [0, 0, 0, 0, 2], overflowCopies: 5}), /分别填写/u);
  assert.equal(profileFromTable({totalTypes: 2, counts: [0, 0, 0, 0, 2], overflowCopies: 5, overflowByType: [1, 4]}), '2 6 9');
});

test('cache never leaks mutable arrays and repeated calculation is deterministic', () => {
  const before = referenceProfileMoments('1 1');
  const modified = referenceProfileMoments('1 1');
  modified.mean[0] = modified.raw_covariance[0][0] = -999;
  assert.deepEqual(referenceProfileMoments('1 1'), before);
  const result = scoreWeaponRecord({N: 1000, K6: 55, KU: 15, profile: '12 5 1'});
  clearWeaponProfileCache();
  assert.deepEqual(scoreWeaponRecord({N: 1000, K6: 55, KU: 15, profile: '12 5 1'}), result);
});

test('standalone zero profile stays unscored, not a fabricated midpoint', () => {
  const result = scoreWeaponProfile(0, 0, 0, '0');
  assert.equal(result.six_star.score, null);
  assert.equal(result.signature.score, null);
});

test('malformed profiles and excessive DP work fail before expansion or computation', () => {
  for (const value of ['', null, '1 -1', '2 1.5', '2 1 2 3', '11 5*0', '11 5*12', '11 5**7', '11*1 5', '11 5*9999999999', '1 9999999999', '1001'])
    assert.throws(() => parseProfile(value));
  assert.throws(() => referenceProfileMoments('1 1000'), /预算/u);
});
