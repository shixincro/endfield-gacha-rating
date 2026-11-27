'use strict';

const {LIMITED} = require('../gacha_rating_app/character_ledger');

const FULL_COPIES = 6;
const MAIN = 0;
const RUSH = 1;
const TOKEN = 2;

function replayLimitedPotential(prepared, tokenPositionsByPool) {
  const copies = Uint8Array.from(LIMITED,
    (_, id) => Number(Boolean(prepared.initialOwnedMask & (1 << id))));

  function acquire(id) {
    if (copies[id] < FULL_COPIES) copies[id]++;
  }

  return prepared.pools.map((pool, i) => {
    const remaining = () => pool.off.map(id => FULL_COPIES - copies[id]);
    const context = () => ({remaining: remaining(), grantAt: null, grants: [0, 0]});
    const row = {a: 0, b: 0, c: 0, aContext: context(), bContext: context(),
      cRemaining: remaining(), saturatedOff: 0};
    let firstUpAt = null;

    function observe(id, phase) {
      if (id < 0) return;
      if (id === pool.index || copies[id] < FULL_COPIES) row[phase]++;
      else row.saturatedOff++;
      acquire(id);
    }

    const timeline = pool.events.map(({at, id}) => ({at, id, kind: MAIN}));
    if (pool.rushAt != null) timeline.push({at: pool.rushAt, kind: RUSH});
    for (const at of tokenPositionsByPool[i] ?? []) timeline.push({at, kind: TOKEN});
    timeline.sort((left, right) => left.at - right.at || left.kind - right.kind);

    for (const event of timeline) {
      const {at, id, kind} = event;
      if (kind === MAIN) {
        observe(id, firstUpAt == null ? 'a' : 'b');
        if (firstUpAt == null && id === pool.index) {
          firstUpAt = at;
          row.bContext = context();
        }
      } else if (kind === RUSH) {
        row.cRemaining = remaining();
        const active = firstUpAt == null ? row.aContext : row.bContext;
        active.grantAt = at - (firstUpAt ?? 0);
        for (const result of pool.rush) {
          const index = pool.off.indexOf(result);
          if (index >= 0) active.grants[index]++;
          observe(result, 'c');
        }
      } else {
        // A confirmed token advances potential but is not a drawn limited.
        acquire(pool.index);
      }
    }
    return row;
  });
}

module.exports = {replayLimitedPotential};
