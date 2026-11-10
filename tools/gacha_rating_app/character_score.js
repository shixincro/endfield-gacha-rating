'use strict';

// Keep this literal: server.py exposes it so opened history is recalculated.
const VERSION = 'character-count-merged-up-v5-catalog-20261105';
const ledger = require('./character_ledger');
const {scoreResults} = require('./character_result_score');

function scoreCharacter(record) {
  return {...scoreResults(record, ledger.scoreCharacter(record), ledger), version: VERSION};
}

module.exports = {...ledger, VERSION, scoreCharacter};
