'use strict';

// Keep this literal: server.py exposes it so opened history is recalculated.
const VERSION = 'character-abc-flat-v4-new-weight';
const ledger = require('./character_ledger');
const {scoreResults} = require('./character_result_score');
const {scoreCharacterFlatABC} = require('../character_abc_score/flat_score');
const {FlatInputError} = require('../character_abc_score/ledger');

function scoreCharacter(record) {
  const checked = ledger.scoreCharacter(record);
  let flat, fallback;
  if (checked.counts && record?.pools?.length && ['characterSix', 'up', 'limited'].some(axis =>
    checked.axes[axis]?.status === 'scored' || checked.axes[axis]?.reason === '没有有效评分方差')) {
    try {
      flat = scoreCharacterFlatABC(record);
    } catch (error) {
      if (!(error instanceof FlatInputError)) throw error;
      fallback = error.message;
    }
  }
  return {...scoreResults(record, checked, ledger, {flat, fallback}), version: VERSION};
}

module.exports = {...ledger, VERSION, scoreCharacter};
